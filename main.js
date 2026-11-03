'use strict';

/*
 * Digitalstrom ioBroker Adapter
 */

/*
Rule 5 When applications send a scene command to a set of digitalSTROM-Devices with more than one target device they have to use scene calls directed to a group, splitting into multiple calls to single devices has to be avoided due to latency and statemachine consistency issues.

Rule 8 Application processes that do automatic cyclic reads or writes of device parameters are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 9 Application processes that do automatic cyclic reads of measured values are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 10 The action command ”Set Output Value” must not be used for other than device configuration purposes.

Rule 13 Applications that automatically generate Call Scene action commands (see 6.1.1) must not execute the action commands at a rate faster than one request per second.
 */

const utils = require('@iobroker/adapter-core');
const ObjectHelper = require('@apollon/iobroker-tools'); // Get common adapter utils

const DSS = require('./lib/dss');
const DSSQueue = require('./lib/dssQueue');
const DSSStructure = require('./lib/dssStructure');
const DSSSmartHome = require('./lib/dssSmartHome');
const ActivityCounter = require('./lib/activityCounter');
const configUtils = require('./lib/configUtils');
const { performance } = require('node:perf_hooks');
const dssConstants = require('./lib/constants');

// Safety valve for the events parked during the startup, not a working limit: the busiest
// 150 s of a three hour production log carried 88 of them, the whole run 2746. At roughly
// 300 bytes of payload each this caps the parking at a couple of megabytes even if a start
// runs all the way into the ten minute watchdog.
const STARTUP_EVENT_LIMIT = 2000;

// A momentary scene is released again after this pause. Not on the next turn: a wall
// switch repeats its Stop, measured three times within 481 ms on one blind while the
// position never moved. Releasing immediately would turn that ONE press into three
// rising edges for every rule listening on it. Re-armed on each repeat, so a burst
// stays a single true -> false, exactly as many edges as the user caused.
const MOMENTARY_SCENE_RELEASE = 500;

// A dSS that did not answer at startup is asked again after this pause - the same five
// minutes the process restart used to wait. Such a dSS is rebooting, being updated or
// switched off, and asking more often would buy nothing but log lines.
const DSS_RETRY_DELAY = 5 * 60 * 1000;

/**
 * The objectHelper of `@apollon/iobroker-tools`. The package ships no types, so the part
 * of it this adapter actually uses is written down here.
 *
 * @typedef {object} ObjectHelper
 * @property {(adapter: any) => void} init binds the helper to an adapter instance
 * @property {(id: string, obj: any, obtainCustomFields: string[], value?: any, stateChangeCallback?: (value: any) => void, createNow?: boolean) => void} setOrUpdateObject queues an object for creation or update
 * @property {(callback?: () => void) => void} processObjectQueue writes the queued objects and their values
 * @property {(callback?: () => void) => void} loadExistingObjects fills existingStates with the objects that already exist for this instance
 * @property {(id: string, state: ioBroker.State) => void} handleStateChange routes an unacknowledged state change to the onChange handler of that object
 * @property {Record<string, any>} existingStates objects of this instance, the ones left over after registerObjects() are the unknown ones
 */

// DSS rules 8/9 (see above) allow at most one cyclic read per minute and circuit.
// One cycle issues TWO reads per circuit (getConsumption + getEnergyMeterValue), and the
// timer for the next cycle only starts once they are answered - measured against a real
// DSS a cycle therefore takes about 20s longer than the configured interval:
//   interval  60s -> cycle  ~80s -> 1.53 requests per minute and circuit
//   interval 100s -> cycle ~120s -> 1.00 requests per minute and circuit
// 100s is the first value that really stays within the rule, so it is the default.
const DEFAULT_POLL_INTERVAL = 100000;
// Smaller values stay possible on purpose - they exceed the guideline, which is documented
// in the README and in the admin dialog. 0 still disables polling completely.
const MIN_POLL_INTERVAL_SECONDS = 60;
const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

class Digitalstrom extends utils.Adapter {
    /**
     * Returns an objectHelper that belongs to this adapter instance only.
     *
     * The helper of `@apollon/iobroker-tools` keeps its adapter reference, the object queue,
     * the known objects and the state change callbacks in module scope. In compact mode two
     * instances of this adapter share one process, so the instance initialized last would
     * receive the object and state writes of the other one (verified, see testObjectHelper).
     * Loading a private copy of the module per instance keeps them isolated without
     * reimplementing the helper.
     *
     * @param {Partial<ioBroker.Logger>} [logger] adapter logger, used only if the private copy is not possible
     * @returns {ObjectHelper} objectHelper instance
     */
    static createObjectHelper(logger) {
        try {
            const modulePath = require.resolve('@apollon/iobroker-tools/lib/objectHelper');
            const cached = require.cache[modulePath];
            delete require.cache[modulePath];
            try {
                return require('@apollon/iobroker-tools/lib/objectHelper');
            } finally {
                // Restore the module cache so other consumers keep their own copy
                if (cached) {
                    require.cache[modulePath] = cached;
                } else {
                    delete require.cache[modulePath];
                }
            }
        } catch (err) {
            // Should not happen, but a shared helper is still better than no adapter at all
            logger &&
                logger.warn &&
                logger.warn(
                    `Could not create a private objectHelper (${configUtils.errorMessage(
                        err,
                    )}). Running a second instance of this adapter in the same compact process is not safe.`,
                );
            return ObjectHelper.objectHelper;
        }
    }

    /**
     * @param {Partial<import('@iobroker/adapter-core').AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'digitalstrom',
        });
        // The host starts a compact instance with {compact: true}. js-controller keeps its
        // own flag for that private, and restartAdapter() has to know it: in compact mode
        // the host logs the reason of a stop as a warning.
        this.compactMode = !!(options && options.compact);
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.objectHelper = Digitalstrom.createObjectHelper(this.log);
        this.objectHelper.init(this);
        // undefined (not null) so the type matches the connected flag of the base class.
        // The first setConnected() call writes the state in either case.
        /** @type {boolean|undefined} */
        this.connected = undefined;

        this.dss = null;
        /** @type {DSSSmartHome|null} Client der neuen API, nur wenn eingeschaltet */
        this.smartHome = null;
        this.dssQueue = null;
        this.dssStruct = null;
        this.lastScenes = {};
        // Boolean states whose declared valueTrue/valueFalse did not match what the dSS
        // sent. Each one is reported once per run, see coerceScalarValue().
        /** @type {Set<string>} */
        this.unmappedBooleanStates = new Set();
        // dSS state names that have no object here. Each one is named once per run at info,
        // see handleStateChange in registerEventHandlers().
        /** @type {Set<string>} */
        this.unhandledStateNames = new Set();
        // Scene calls that found no scene state. Each one is named once per run at info,
        // see logUnmappedSceneCall().
        /** @type {Set<string>} */
        this.unmappedSceneCalls = new Set();
        // "<zone>.<group>" of every group that has scene states, see logUnmappedSceneCall()
        /** @type {{stateMap: Record<string, string>, groups: Set<string>}|null} */
        this.sceneGroupCache = null;
        // Scene states waiting to be released again, by state id - see handleScene()
        /** @type {Map<string, NodeJS.Timeout>} */
        this.momentaryReleases = new Map();
        // Overridable in tests so a release does not cost half a second there
        this.momentaryReleaseDelay = MOMENTARY_SCENE_RELEASE;
        // Events that arrived before the objects existed, in arrival order. null means the
        // live path, an array means the startup is still building - see replayStartupEvents()
        /** @type {Array<{apply: () => void, at: number}>|null} */
        this.pendingEvents = null;
        this.pendingEventsDropped = 0;
        // A model_ready that arrived while the objects were being created - acted on once
        // the startup is through, see replayStartupEvents()
        this.pendingModelReady = false;
        // Overridable in tests so an overflow does not need thousands of events
        this.startupEventLimit = STARTUP_EVENT_LIMIT;
        // Set SYNCHRONOUSLY when the subscribe goes out, not when it comes back: the second
        // attempt is decided while the first is still in flight
        this.eventSubscriptionStarted = false;
        /** @type {Error|null|undefined} undefined while the early subscribe is in flight */
        this.eventSubscriptionResult = undefined;
        /** @type {Array<(err: Error|null) => void>} */
        this.eventSubscriptionWaiters = [];

        this.dataPollInterval = 60000;
        this.dataPollTimeout = null;

        this.restartTimeout = null;
        this.startupTimeout = null;
        // Next check of a dSS that did not answer at startup, see waitForDss()
        /** @type {NodeJS.Timeout|null} */
        this.dssRetryTimeout = null;
        // Overridable in tests so a retry does not take five minutes
        this.dssRetryDelay = DSS_RETRY_DELAY;
        // The outage waitForDss() is riding out: since when (performance.now(), a clock NTP
        // does not set), how many checks failed and which errors were already reported. null
        // as long as the dSS answers.
        /** @type {{since: number, failures: number, reported: Set<string>}|null} */
        this.dssOutage = null;
        this.stopping = false;
        this.stopped = false;
        /** @type {Array<() => void>} */
        this.stopCallbacks = [];
        // Overridable in tests so the unsubscribe guard does not take four seconds
        /** @type {number|undefined} */
        this.stopGuardTimeout = undefined;
        // DSS clients created by the App-Token dialog. They are not part of the normal
        // adapter lifecycle, so they have to be tracked to be closable on unload.
        this.tokenConnections = new Set();
        // Smart Home key creation also lives outside the normal client lifecycle. Abort every
        // in-flight flow on unload so it cannot create a late key or answer a closed dialog.
        this.smartHomeKeyControllers = new Set();
        // Guards against registering the event handlers more than once
        this.eventHandlersRegistered = false;
    }

    /**
     * True as soon as the unload has started.
     *
     * Every asynchronous startup callback has to check this before it creates timers,
     * requests, subscriptions or state subscriptions. Otherwise an answer that arrives
     * during or after the unload would revive an already stopped adapter.
     *
     * @returns {boolean} true if the adapter is stopping or already stopped
     */
    isStopping() {
        return this.stopping || this.stopped;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.main();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.stopAdapter(callback);
        } catch {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     *
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.debug(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (this.isStopping()) {
            // A control command during the unload would push a new queue entry after the
            // queues were already cleared and the DSS client is about to be closed
            this.log.debug(`Ignoring state change for ${id} - the adapter is stopping`);
            return;
        }
        if (state) {
            // The state was changed. A command (ack = false) is logged at debug. The
            // confirmations are mostly this adapter's own writes - half of a debug log, one
            // line per sensor value and every 30 s for info.apiActivity - and go to silly.
            if (state.ack) {
                this.log.silly(`state ${id} changed: ${state.val} (ack = true)`);
            } else {
                this.log.debug(`state ${id} changed: ${state.val} (ack = false)`);
            }

            if (this.dssStruct && typeof this.dssStruct.notePublishedValue === 'function') {
                // What is in the state now, no matter who wrote it and whether it was
                // acknowledged. Tracking foreign writes here is what keeps the
                // reconciliation able to correct a value another adapter put there -
                // without it the skipped re-assert would leave it standing forever.
                // Deliberately NOT limited to acknowledged writes: an unacknowledged one
                // on a read-only state is a value nobody will confirm, and it is exactly
                // the case the reconciliation has to notice.
                // The id arrives with the namespace, the structure keeps its ids without it -
                // under the full id the value was stored next to the tracked one and never
                // compared, so a foreign write on a polled state was never corrected.
                const prefix = `${this.namespace}.`;
                const ownId = this.namespace && id.startsWith(prefix) ? id.slice(prefix.length) : id;
                this.dssStruct.notePublishedValue(ownId, state.val);
            }

            if (!state.ack && state.val === null) {
                // null is "no value" - what this adapter writes for a state the dSS reports
                // as unknown. There is nothing to send for it, and objectHelper would turn
                // it into false for a boolean state (!!null) and hand that to the write
                // handler, which sends the false word of the state ("inactive", "absent",
                // ...) to the dSS - a command nobody gave. It has to be stopped here: by
                // the time a write handler runs, the null is already gone.
                this.log.debug(`Ignoring null for ${id} - there is no value to send to the DSS`);
                return;
            }

            this.objectHelper.handleStateChange(id, state);
        } else {
            // The state was deleted
            this.log.debug(`state ${id} deleted`);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'createSmartHomeKey') {
                if (!obj.callback) {
                    return;
                }
                if (this.isStopping()) {
                    return;
                }
                const messageToken = typeof obj.message.appToken === 'string' ? obj.message.appToken.trim() : '';
                const appToken = messageToken || this.config.appToken;
                if (!appToken) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        { error: 'Please create or enter the App-Token first, the API key is derived from it.' },
                        obj.callback,
                    );
                    return;
                }
                // Der vorhandene App-Token reicht: er wird zur Session und die erzeugt den
                // Bearer-Key. Der Benutzer muss also kein Passwort erneut eingeben.
                this.log.info(`Creating a Smart Home API key for host ${obj.message.host || this.config.host}`);
                const controller = new AbortController();
                this.smartHomeKeyControllers.add(controller);
                DSSSmartHome.createApiKey({
                    host: obj.message.host || this.config.host,
                    appToken,
                    validateCertificate: this.config.validateCertificate,
                    name: `ioBroker.digitalstrom.${this.instance}`,
                    signal: controller.signal,
                    logger: {
                        silly: this.log.silly.bind(this),
                        debug: this.log.debug.bind(this),
                        info: this.log.info.bind(this),
                        warn: this.log.warn.bind(this),
                        error: this.log.error.bind(this),
                    },
                })
                    .then(
                        apiKey => {
                            if (this.isStopping() || controller.signal.aborted) {
                                return;
                            }
                            this.log.info('Smart Home API key created');
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { apiKey, native: { smartHomeApiKey: apiKey } },
                                obj.callback,
                            );
                        },
                        err => {
                            if (this.isStopping() || controller.signal.aborted) {
                                return;
                            }
                            this.log.warn(`Could not create the Smart Home API key: ${configUtils.errorMessage(err)}`);
                            this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(err) }, obj.callback);
                        },
                    )
                    .finally(() => this.smartHomeKeyControllers.delete(controller));
                return;
            }
            if (obj.command === 'createAppToken') {
                if (!obj.callback) {
                    return;
                }
                if (this.isStopping()) {
                    // Starting a new connection during the unload would outlive the adapter
                    this.log.debug('Ignoring createAppToken request - the adapter is stopping');
                    return;
                }
                // The username is part of the credentials and is deliberately not logged
                this.log.info(`Try to retrieve AppToken for host ${obj.message.host}`);

                let tokenConnection;
                try {
                    tokenConnection = new DSS({
                        host: obj.message.host,
                        validateCertificate: this.config.validateCertificate,
                        logger: {
                            silly: this.log.silly.bind(this),
                            debug: this.log.debug.bind(this),
                            info: this.log.info.bind(this),
                            warn: this.log.warn.bind(this),
                            error: this.log.error.bind(this),
                        },
                    });
                } catch (err) {
                    // An invalid host throws synchronously - answer the admin dialog instead
                    // of letting the exception escape the message handler
                    this.log.warn(`Can not retrieve AppToken: ${configUtils.errorMessage(err)}`);
                    this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(err) }, obj.callback);
                    return;
                }

                // Tracked so that an unload can close a token dialog that is still running
                this.tokenConnections.add(tokenConnection);
                let tokenClientClosed = false;
                const closeTokenClient = () => {
                    if (tokenClientClosed) {
                        return;
                    }
                    tokenClientClosed = true;
                    this.tokenConnections.delete(tokenConnection);
                    tokenConnection.stop();
                };

                tokenConnection.createAppTokenAsync(obj.message.username, obj.message.password).then(
                    appToken => {
                        closeTokenClient();
                        if (this.isStopping()) {
                            // The admin dialog is gone with the adapter - no late answer, no log line
                            return;
                        }
                        this.log.info(`Successfully retrieved AppToken for host ${obj.message.host}`);
                        // "native" is used by the jsonConfig sendTo component (useNative) to fill the config field
                        this.sendTo(obj.from, obj.command, { appToken, native: { appToken } }, obj.callback);
                    },
                    error => {
                        closeTokenClient();
                        if (this.isStopping()) {
                            return;
                        }
                        this.log.warn(
                            `Error while retrieving AppToken for host ${obj.message.host}: ${configUtils.errorMessage(
                                error,
                            )}`,
                        );
                        this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(error) }, obj.callback);
                    },
                );
            }
        }
    }

    stopAdapter(callback) {
        // Every caller has to be answered exactly once, even if a stop is already running
        if (this.stopping) {
            if (this.stopped) {
                return void (callback && callback());
            }
            callback && this.stopCallbacks.push(callback);
            return;
        }
        this.stopping = true;
        this.stopCallbacks = callback ? [callback] : [];
        const stopStartedAt = Date.now();
        this.log && this.log.info(`stopping ... ${stopStartedAt}`);
        this.setConnected(false);

        if (this.dataPollTimeout) {
            clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }
        if (this.apiActivityTimer) {
            clearInterval(this.apiActivityTimer);
            this.apiActivityTimer = null;
        }
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
        if (this.dssRetryTimeout) {
            clearTimeout(this.dssRetryTimeout);
            this.dssRetryTimeout = null;
        }
        // A scene state that was about to be released stays true - the adapter is going
        // down, and writing after the stop barrier is what isStopping() exists to prevent
        this.momentaryReleases?.forEach(timer => clearTimeout(timer));
        this.momentaryReleases?.clear();
        // Anything still parked belongs to a startup that is not going to finish. Dropped
        // rather than carried into the next run, where it would be older than the fresh
        // snapshot and would overwrite it.
        this.pendingEvents = null;
        this.pendingEventsDropped = 0;
        this.eventSubscriptionWaiters = [];

        // Close a still running App-Token dialog: its client lives outside the normal
        // lifecycle and would otherwise keep sockets open after the unload
        this.tokenConnections.forEach(connection => {
            try {
                connection.stop();
            } catch (err) {
                this.log && this.log.debug(`Error while closing a token connection: ${configUtils.errorMessage(err)}`);
            }
        });
        this.tokenConnections.clear();

        this.smartHomeKeyControllers?.forEach(controller => controller.abort());
        this.smartHomeKeyControllers?.clear();

        this.dssStruct && this.dssStruct.clearTimeouts();

        // Stop the queue for good: removes all entries, ends the timers and rejects
        // anything that still arrives while the unload is running
        this.dssQueue && this.dssQueue.stop();

        // Central cleanup, runs exactly once no matter which path finished first
        /** @type {NodeJS.Timeout|null} */
        let unsubscribeGuard = null;
        const finish = time => {
            if (this.stopped) {
                return;
            }
            this.stopped = true;
            if (unsubscribeGuard) {
                clearTimeout(unsubscribeGuard);
                unsubscribeGuard = null;
            }
            // Closes the agents and aborts still running requests/long-polls
            this.dss && this.dss.stop();
            this.smartHome && this.smartHome.stop();
            // This used to print the value unsubscribeAllEvents hands over, which is the
            // deadline of the longest running long-poll - a moment in the FUTURE. Next to
            // the timestamp of the "stopping" line it read like a duration and suggested
            // 15 s where the unload had taken 116 ms. The elapsed time is what anybody
            // reading these two lines wants, and the poll deadline stays available for
            // whoever needs it.
            this.log &&
                this.log.info(
                    `cleaned everything up... after ${Date.now() - stopStartedAt}ms (longest event poll ran until ${time})`,
                );
            const callbacks = this.stopCallbacks;
            this.stopCallbacks = [];
            callbacks.forEach(cb => {
                try {
                    cb();
                } catch (err) {
                    this.log && this.log.debug(`Error in unload callback: ${configUtils.errorMessage(err)}`);
                }
            });
        };

        // unsubscribe to all events
        if (this.dss) {
            unsubscribeGuard = setTimeout(() => {
                unsubscribeGuard = null;
                this.log && this.log.info('unsubscribe did not finish in time, stopping anyway');
                finish(0);
            }, this.stopGuardTimeout || 4000);
            this.dss.unsubscribeAllEvents(time => finish(time));
        } else {
            finish(0);
        }
    }

    /**
     * Ends this instance so that js-controller starts it again.
     *
     * @param {number} timeout ms until the restart
     * @param {string} reason why, completing "restarting because ..." - js-controller logs
     *   it next to the exit code
     */
    restartAdapter(timeout, reason) {
        if (this.restartTimeout || this.isStopping()) {
            return;
        }
        this.restartTimeout = setTimeout(() => {
            this.restartTimeout = null;
            // START_IMMEDIATELY_AFTER_STOP is the code js-controller restarts after one second
            // and logs at info level together with the reason. The -100 used before only
            // became that code because a process exit code is cut to 8 bits: the instance
            // logged "Terminated (-100): Without reason" as a warning at every restart, and in
            // compact mode, where nothing is cut, the host logged an error and waited 30 s.
            // Read here and not at load time: the test stubs of adapter-core do not carry it.
            const exitCode = utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP;
            const text = `restarting because ${reason}`;
            // In compact mode terminate() hands the reason to the host as the "signal" of its
            // exit event, and the host logs any signal as a warning ("terminated due to
            // restarting because ..."). There the reason is logged here at info and not passed
            // on. undefined and not the bare exit code: terminate(156) would make 156 the signal.
            const stopReason = this.compactMode ? undefined : text;
            if (this.compactMode) {
                this.log.info(text);
            }
            if (typeof this.stop === 'function') {
                // stop(), not terminate(): only stop() runs onUnload first. terminate() skips
                // it, and in compact mode this instance would keep polling the dSS events and
                // keep its timers and its websocket in the shared process next to the new one.
                // process.exit() is no option either, it would end that whole process.
                this.stop({ exitCode, reason: stopReason }).catch(() => this.terminate(stopReason, exitCode));
            } else {
                this.terminate(stopReason, exitCode);
            }
        }, timeout || 1000);
    }

    /**
     * @param {boolean} isConnected
     */
    setConnected(isConnected) {
        if (isConnected && this.isStopping()) {
            // A late startup callback must never mark an already stopped adapter as connected
            this.log && this.log.debug('Ignoring connected = true, the adapter is stopping');
            return;
        }
        if (this.connected !== isConnected) {
            this.connected = isConnected;
            this.setState('info.connection', isConnected, true);
        }
    }

    /**
     * Brings the boolean options into a defined state.
     *
     * The instance object can be written by hand, by a script or by a restored backup, so
     * a value can arrive as the string "false". Plain truthiness would read that as true -
     * for deleteUnknownObjects that would silently enable deleting objects including their
     * custom settings (history, influxdb, ...).
     */
    normalizeConfig() {
        // option name -> safe default, matching "native" in io-package.json
        const booleanDefaults = {
            usePresetValues: true,
            initializeOutputValues: true,
            deleteUnknownObjects: false,
            validateCertificate: false,
        };
        Object.keys(booleanDefaults).forEach(name => {
            const raw = this.config[name];
            const normalized = configUtils.normalizeBoolean(raw, booleanDefaults[name]);
            if (raw !== undefined && !configUtils.isInterpretableBoolean(raw)) {
                // Never fail silently - especially not for the certificate check
                this.log.warn(
                    `Configuration value "${name}" is not a valid boolean (${JSON.stringify(
                        raw,
                    )}), using the default ${normalized}. Please check the adapter settings.`,
                );
            }
            this.config[name] = normalized;
        });
    }

    main() {
        // Reset the connection indicator during startup
        this.setConnected(false);
        this.normalizeConfig();

        if (!this.config.host || !this.config.appToken) {
            this.log.warn('Please open Admin page for this adapter to set the host and create an App Token.');
            return;
        }
        if (!Digitalstrom.looksLikeAppToken(this.config.appToken)) {
            this.log.error(
                'The stored App-Token does not look like a valid digitalSTROM token (expected a long hex ' +
                    'string). Please open the adapter configuration, enter the App-Token again or create a new ' +
                    'one with your DSS login, and save. The adapter tries to log in anyway.',
            );
        }
        // Zaehlt je Weg, was wirklich laeuft - der Status-Tab zeigt daraus
        // "x empfangen / y gesendet in den letzten 10 Minuten"
        this.apiActivity = new ActivityCounter();
        let dss;
        try {
            dss = new DSS({
                host: this.config.host,
                appToken: this.config.appToken,
                validateCertificate: this.config.validateCertificate,
                onActivity: (kind, detail) => this.countClassicActivity(kind, detail),
                logger: {
                    silly: this.log.silly.bind(this),
                    debug: this.log.debug.bind(this),
                    info: this.log.info.bind(this),
                    warn: this.log.warn.bind(this),
                    error: this.log.error.bind(this),
                },
            });
        } catch (err) {
            // An invalid host is a configuration error - restarting would only loop.
            // The adapter stays idle until the configuration is corrected (which restarts it).
            this.dss = null;
            this.log.error(
                `${configUtils.errorMessage(err)}. Please correct the host in the adapter configuration - the adapter stays inactive until then.`,
            );
            return;
        }
        this.dss = dss;
        this.smartHome = this.createSmartHomeClient();
        // 30 s Takt reicht: der Status-Tab zeigt ein 10-Minuten-Fenster
        this.apiActivityTimer = setInterval(() => this.publishApiActivity(), 30000);
        const dssQueue = new DSSQueue({
            logger: {
                silly: this.log.silly.bind(this),
                debug: this.log.debug.bind(this),
                info: this.log.info.bind(this),
                warn: this.log.warn.bind(this),
                error: this.log.error.bind(this),
            },
            dss,
        });
        this.dssQueue = dssQueue;
        const dssStruct = new DSSStructure({
            dss,
            dssQueue,
            adapter: this,
            smartHome: this.smartHome,
        });
        this.dssStruct = dssStruct;

        this.dataPollInterval = Digitalstrom.normalizePollInterval(this.config.dataPollInterval);

        this.waitForDss(dssName => {
            // Every step checks the stop barrier: an answer that arrives during the
            // unload must not create new objects, timers or subscriptions any more.
            if (this.isStopping()) {
                return;
            }
            this.log.debug(`getName: ${JSON.stringify(dssName)}`);

            // Watchdog: if initialization does not finish in time (e.g. a stuck request
            // or a DSS that stops responding mid-init), restart the adapter. Armed only
            // now that the dSS answered - waitForDss() may wait for hours, and that is
            // not an initialization that got stuck.
            this.startupTimeout = setTimeout(() => {
                this.startupTimeout = null;
                this.log.warn('Initialization did not finish within 10 minutes, restarting adapter');
                this.restartAdapter(1000, 'the initialization did not finish within 10 minutes');
            }, 600000);

            // getName has proven host, login and reachability, so the events can be
            // subscribed NOW. Measured on a real installation: the adapter was deaf for
            // 149.7 s, and the classic structure read was done after 2.6 s of it - all
            // the rest is parsing and creating 5231 objects. Nothing is applied yet:
            // the level handlers park their events until replayStartupEvents() runs.
            this.pendingEvents = [];
            this.startEarlyEventSubscription();

            this.objectHelper.loadExistingObjects(() => {
                if (this.isStopping()) {
                    return;
                }
                this.initializeDSSData(err => {
                    if (this.isStopping()) {
                        return;
                    }
                    if (err) {
                        this.log.warn(`Error while initializing Data: ${err}`);
                        this.restartAdapter(60000, 'reading the DSS structure failed');
                        return;
                    }

                    this.registerObjects();
                    this.objectHelper.processObjectQueue(() => {
                        if (this.isStopping()) {
                            return;
                        }
                        // From here on all objects exist, so values may be written directly
                        dssStruct.objectsReady = true;
                        this.setInitialValues(() => {
                            if (this.isStopping()) {
                                return;
                            }
                            this.lastScenes = dssStruct.initialScenes;
                            // Subscribe right away: every millisecond between the initial
                            // snapshot and the active subscription is a window in which
                            // scene calls are lost for good. Usually the early
                            // subscription already covers it, see ensureEventSubscription().
                            this.ensureEventSubscription(subscriptionErr => {
                                if (this.isStopping()) {
                                    return;
                                }
                                if (subscriptionErr) {
                                    // Without events the adapter would silently miss every
                                    // change, so this must not be treated as a running adapter
                                    this.log.error(`Could not subscribe to the DSS events: ${subscriptionErr.message}`);
                                    this.setConnected(false);
                                    if (this.startupTimeout) {
                                        clearTimeout(this.startupTimeout);
                                        this.startupTimeout = null;
                                    }
                                    // Drop the partially created subscriptions before restarting
                                    dss.unsubscribeAllEvents(() =>
                                        this.restartAdapter(30000, 'the DSS events could not be subscribed'),
                                    );
                                    return;
                                }
                                this.subscribeStates('*');
                                this.setConnected(true);
                                if (this.startupTimeout) {
                                    clearTimeout(this.startupTimeout);
                                    this.startupTimeout = null;
                                }
                                this.log.info('Subscribed to states ...');

                                // Everything the dSS reported while the objects were
                                // being created, in arrival order, ON TOP of the initial
                                // snapshot that was just written - never before it
                                this.replayStartupEvents();

                                this.startDataPolling();

                                // Catches scene calls that happened while the structure
                                // was being built, see resyncSceneStates()
                                this.resyncSceneStates();

                                this.clearAdditionalObjects();

                                this.startNotificationChannel();
                            });
                        });
                    });
                });
            });
        });
    }

    /**
     * Calls back with the answer of apartment/getName as soon as the dSS answers.
     *
     * A dSS that refuses connections is rebooting, being updated or switched off. Ending the
     * process for that turned one night without a dSS into 102 restarts, each with two error
     * lines and a warning from js-controller. The process stays now and only this check is
     * repeated: nothing else of the startup exists yet, so there is nothing to tear down or
     * to create twice. Never calls back after a stop - the unload clears the retry timer and
     * aborts a check that is still running.
     *
     * @param {(dssName: import('./lib/configUtils').DssResponse) => void} callback
     */
    waitForDss(callback) {
        const dss = this.dss;
        if (!dss || dss.stopped || this.isStopping()) {
            return;
        }
        dss.requestAsync('apartment', 'getName').then(
            dssName => {
                if (this.isStopping()) {
                    return;
                }
                this.noteDssReachable();
                callback(dssName);
            },
            err => {
                // A stopped client refuses every request - that is a shutdown, not an
                // outage, and asking it again would only loop
                if (this.isStopping() || dss.stopped) {
                    return;
                }
                this.noteDssUnreachable(err);
                this.dssRetryTimeout = setTimeout(() => {
                    this.dssRetryTimeout = null;
                    this.waitForDss(callback);
                }, this.dssRetryDelay || DSS_RETRY_DELAY);
            },
        );
    }

    /**
     * Reports a failed connection check - loudly once, then quietly.
     *
     * The first failure is an error with the hint what to check. Every further failure with
     * an error already reported goes to debug: nothing has changed, info.connection stays
     * false, and a line every five minutes for hours helps nobody. A failure with a NEW error
     * is reported again - a dSS that accepts the connection but refuses the login needs
     * somebody to act, even in the middle of an outage.
     *
     * A refused login is named as such. The dSS was reached then, and a line that starts
     * with "Cannot reach" sends the user to the network, while a revoked App-Token never
     * comes back by itself.
     *
     * @param {unknown} err why the check failed
     */
    noteDssUnreachable(err) {
        const message = configUtils.errorMessage(err);
        const retryIn = Digitalstrom.formatDuration(this.dssRetryDelay || DSS_RETRY_DELAY);
        // loginApplication answered without a session token (see DSS.getSessionToken()).
        // dSS 1.19 answers a revoked App-Token and a full session table the same way.
        const loginRefused = /^Login failed:/.test(message);
        const tokenHint =
            'Please check that the App-Token is still enabled on the DSS, or create a new one in the adapter settings';
        const outage = this.dssOutage;
        if (!outage) {
            this.dssOutage = { since: performance.now(), failures: 1, reported: new Set([message]) };
            // The line for the answer is info: somebody running at warn must not wait for it
            const howItGoesOn =
                `The adapter asks again every ${retryIn}, reports a different error once more and logs at ` +
                `info level when the DSS ${loginRefused ? 'accepts the login' : 'answers'} again`;
            this.log.error(
                loginRefused
                    ? `The DSS at ${this.config.host} refused the login with the App-Token (getName): ${message}. ` +
                          `${tokenHint}. ${howItGoesOn}`
                    : `Cannot reach the DSS at ${this.config.host} (getName): ${message}. Please check the host, ` +
                          `the network and the App-Token in the adapter settings. ${howItGoesOn}`,
            );
            return;
        }
        outage.failures++;
        if (!outage.reported.has(message)) {
            outage.reported.add(message);
            // A refused login is an answer of the dSS, so neither line claims it is silent
            this.log.error(
                loginRefused
                    ? `The DSS at ${this.config.host} answers, but refuses the login with the App-Token - a ` +
                          `different error: ${message}. ${tokenHint}`
                    : `The connection check of the DSS at ${this.config.host} still fails, now with a different ` +
                          `error: ${message}`,
            );
            return;
        }
        this.log.debug(
            `DSS connection check still fails (${outage.failures} failed checks in ${Digitalstrom.formatDuration(
                performance.now() - outage.since,
            )}): ${message} - asking again in ${retryIn}`,
        );
    }

    /**
     * Closes an outage noted by noteDssUnreachable() with one line saying how long it took.
     */
    noteDssReachable() {
        const outage = this.dssOutage;
        if (!outage) {
            return;
        }
        this.dssOutage = null;
        this.log.info(
            `The DSS answers again after ${Digitalstrom.formatDuration(performance.now() - outage.since)} (${
                outage.failures
            } failed check${outage.failures === 1 ? '' : 's'}) - continuing the start`,
        );
    }

    /**
     * Formats a duration for a log line: "45 s", "5 min", "4 min 12 s", "8 h 37 min".
     *
     * @param {number} ms duration in milliseconds
     * @returns {string} readable duration, rounded to seconds
     */
    static formatDuration(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours) {
            return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
        }
        if (minutes) {
            return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
        }
        return `${seconds} s`;
    }

    /**
     * Re-reads the last called scene of every known zone group once the event
     * subscription is active.
     *
     * The initial scene snapshot is taken while the structure is being read, which can
     * take minutes on large installations. A scene called between that snapshot and the
     * active subscription appears neither in the snapshot nor in an event, so the states
     * would stay wrong until the next scene call. The re-read uses the lowest priority so
     * it never delays a user command, and only a really changed scene is applied - through
     * the normal event path, so all follow up handling stays identical.
     *
     * @param {() => void} [callback]
     */
    resyncSceneStates(callback) {
        // Group keys look like "<zoneId>.<groupId>", device keys are dSUIDs without a dot
        const groupKeys = Object.keys(this.lastScenes || {}).filter(key => /^\d+\.\d+$/.test(key));
        const dss = this.dss;
        const dssQueue = this.dssQueue;
        if (!groupKeys.length || this.isStopping() || !dssQueue || !dss) {
            return void (callback && callback());
        }
        this.log.debug(`Checking the scenes of ${groupKeys.length} zone groups for changes during the startup`);
        let open = groupKeys.length;
        const done = () => {
            if (!--open) {
                callback && callback();
            }
        };
        groupKeys.forEach(key => {
            const [zoneId, groupId] = key.split('.');
            dssQueue.pushQueryQueue(
                'zone',
                {
                    dssClass: 'zone',
                    dssFunction: 'getLastCalledScene',
                    params: {
                        id: zoneId,
                        groupID: groupId,
                    },
                },
                'low',
                (err, res) => {
                    if (this.isStopping()) {
                        return void done();
                    }
                    if (err || !res || !res.ok || !res.result || res.result.scene === undefined) {
                        this.log.debug(
                            `Could not check the scene of zone group ${key}: ${
                                (err && err.message) || JSON.stringify(res)
                            }`,
                        );
                        return void done();
                    }
                    if (String(res.result.scene) === String(this.lastScenes[key])) {
                        return void done();
                    }
                    this.log.info(
                        `Scene of zone group ${key} changed to ${res.result.scene} while the adapter was starting - applying it now`,
                    );
                    dss.emit('callScene', {
                        name: 'callScene',
                        source: { isDevice: false, isGroup: true, isApartment: false },
                        properties: {
                            zoneID: String(zoneId),
                            groupID: String(groupId),
                            sceneID: String(res.result.scene),
                            callOrigin: '-1',
                        },
                    });
                    done();
                },
            );
        });
    }

    /**
     * True when the value looks like a digitalSTROM application token.
     *
     * The DSS issues a long hex string. A stored value that does not look like one usually
     * means js-controller could not decrypt it, and the login would fail with nothing but
     * "Login failed" - which gives the user no clue what to do.
     *
     * Deliberately only a plausibility check - it never blocks the login, it only produces a
     * helpful message.
     *
     * @param {unknown} token configured app token
     * @returns {boolean} true if the value can be a valid token
     */
    static looksLikeAppToken(token) {
        return typeof token === 'string' && /^[0-9a-f]{32,}$/i.test(token.trim());
    }

    /**
     * True for a scene that commands a change instead of selecting a preset.
     *
     * The group is checked FIRST and not afterwards: group 48 reads scene 10 as "Cooling
     * Night" and 11 as "Cooling Holiday", the ventilation groups read their own numbers
     * too. Those are lasting modes, and releasing one would clear the operation mode of a
     * room half a second after it was set.
     *
     * @param {string|number|undefined} sceneId scene number of the event
     * @param {string|number|undefined} groupId group of the event, undefined for a device
     * @returns {boolean} true if the scene leaves no state behind
     */
    static isMomentaryScene(sceneId, groupId) {
        if (groupId !== undefined && dssConstants.ownSceneNumberGroups.includes(Number(groupId))) {
            return false;
        }
        return !!dssConstants.momentaryScenes[Number(sceneId)];
    }

    /**
     * True for the internal helper states of dSS addons, which have no object on purpose.
     *
     * Measured on a dSS20 1.19.13: the window-states addon keeps "<dsuid>_open-tilded" per
     * window handle, the climate control "queue-active" while it works through its queue.
     * Neither is anything a user would read.
     *
     * @param {string} statename name of the state in the dSS
     * @returns {boolean} true if the state is logged at debug only
     */
    static isAddonHelperState(statename) {
        return statename === 'queue-active' || /_open-tilded$/.test(statename);
    }

    /**
     * Logs a scene call that found no scene state, with zone, group and scene.
     *
     * Two kinds are expected and go to debug: a room or group that has no scene objects at
     * all - the climate control calls the scenes of group 48 in every room at its switch
     * times, also in rooms without heating - and a command such as Stop on group level,
     * which only exists as a device scene state. Anything else is named once per run at
     * info, then at debug.
     *
     * @param {any} data the callScene or undoScene event
     */
    logUnmappedSceneCall(data) {
        const props = data.properties || {};
        const source = data.source || {};
        const stateMap = (this.dssStruct && this.dssStruct.stateMap) || {};
        let key;
        let what;
        let expected = false;
        if (source.isDevice) {
            key = `device ${source.dSUID}.${props.sceneID}`;
            what = `device ${source.dSUID}, scene ${props.sceneID}`;
        } else {
            const zone = source.isApartment ? '0' : props.zoneID;
            const group = source.isApartment ? '0' : props.groupID;
            key = `${zone}.${group}.${props.sceneID}`;
            what = `zone ${zone}, group ${group}, scene ${props.sceneID}`;
            if (!this.sceneGroupCache || this.sceneGroupCache.stateMap !== stateMap) {
                // Built once per structure, not per call: the climate control alone calls
                // group 48 in every room at each of its switch times
                const groups = new Set();
                Object.keys(stateMap).forEach(id => {
                    const match = /^(\d+)\.(\d+)\.scenes\./.exec(id);
                    match && groups.add(`${match[1]}.${match[2]}`);
                });
                this.sceneGroupCache = { stateMap, groups };
            }
            if (!this.sceneGroupCache.groups.has(`${zone}.${group}`)) {
                what += ' - this room has no scene objects for that group';
                expected = true;
            } else if (Digitalstrom.isMomentaryScene(props.sceneID, group)) {
                what += ' - a command scene, only devices have a state for it';
                expected = true;
            }
        }
        if (!this.unmappedSceneCalls) {
            this.unmappedSceneCalls = new Set();
        }
        if (expected || this.unmappedSceneCalls.has(key)) {
            this.log.debug(`${data.name || 'Scene call'} without scene state: ${what}`);
            return;
        }
        this.unmappedSceneCalls.add(key);
        this.log.info(
            `${data.name || 'Scene call'} without scene state: ${what}. The scene is not mapped to an object here; further calls of it are logged at debug level.`,
        );
    }

    /**
     * Wraps an event handler so that it parks its event while the objects are being built.
     *
     * ONLY for handlers whose event carries a LEVEL - a sensor reading, a state, a binary
     * input. For those, applying them late is the same as applying them on time: the newest
     * value wins either way, and the initial snapshot underneath is older than all of them.
     *
     * Deliberately NOT for callScene, undoScene and buttonClick. Those are actions, and a
     * button press replayed two minutes after it happened would make every rule listening
     * on it act two minutes late - lights on, blinds up, long after the person left the
     * room. Losing it is the lesser evil, and it is what happened before the subscription
     * moved forward - only for 150 s instead of the 95 s the objects now take.
     *
     * The repair afterwards is partial, and the comment used to claim more than it does:
     * resyncSceneStates() re-reads the last called scene of every ZONE GROUP, so a group
     * scene missed here is corrected. A scene the dSS reported for a single device is not
     * - initialScenes only ever holds group keys - and on an installation whose wall
     * switches report per device that is the common case. Such a scene state stays as it
     * was until the next call reaches it.
     *
     * @param {(...args: any[]) => void} handler the live handler
     * @returns {(...args: any[]) => void} the handler with the parking in front of it
     */
    parkable(handler) {
        return (...args) => {
            if (!this.pendingEvents) {
                return handler(...args);
            }
            if (this.pendingEvents.length >= this.startupEventLimit) {
                // The newest value is the one that counts, so the oldest goes. Reported once
                // at the replay rather than per event.
                this.pendingEvents.shift();
                this.pendingEventsDropped++;
            }
            this.pendingEvents.push({ apply: () => handler(...args), at: Date.now() });
        };
    }

    /**
     * Wraps an event handler that must NOT run while the objects are being built and must
     * not be caught up afterwards either.
     *
     * These are the actions - a scene call, a button press. Replaying one late would make
     * every rule listening on it act minutes after the fact, and running it live would let
     * it reach into a half built tree: handleScene() walks dssStruct.apartmentStructure,
     * which is still null until the structure is parsed. Dropping it is exactly what
     * happened before the subscription was moved forward, and the scenes are re-read by
     * resyncSceneStates() at the end of the start anyway.
     *
     * @param {(...args: any[]) => void} handler the live handler
     * @returns {(...args: any[]) => void} the handler, silent until the objects are there
     */
    liveOnly(handler) {
        return (...args) => {
            if (this.pendingEvents) {
                // Named, because this is the only trace such an event ever leaves - and
                // nothing catches a device scene up afterwards, see the note above
                const name = (args[0] && args[0].name) || 'event';
                this.log.debug(`${name} ignored - the objects are still being created`);
                return;
            }
            handler(...args);
        };
    }

    /**
     * Applies everything that arrived while the objects did not exist yet, in arrival order.
     *
     * Must run AFTER setInitialValues() and never before it. The initial snapshot is the
     * older picture - it was read while the structure was being parsed - so replaying first
     * would let the snapshot overwrite the newer value and leave exactly the stale state
     * this is meant to prevent.
     */
    replayStartupEvents() {
        const parked = this.pendingEvents;
        this.pendingEvents = null;
        if (!parked || !parked.length) {
            this.pendingEventsDropped = 0;
            this.settlePendingModelReady();
            return;
        }
        const oldest = Math.round((Date.now() - parked[0].at) / 1000);
        this.log.info(
            `Applying ${parked.length} event(s) that arrived while the objects were being created, the oldest ${oldest}s ago`,
        );
        if (this.pendingEventsDropped) {
            this.log.warn(
                `${this.pendingEventsDropped} further event(s) were dropped during the startup - the newest value of a state survived, an intermediate one may not have`,
            );
            this.pendingEventsDropped = 0;
        }
        parked.forEach(entry => {
            try {
                entry.apply();
            } catch (err) {
                // One unusable event must not cost the remaining ones
                this.log.debug(`Parked event could not be applied: ${configUtils.errorMessage(err)}`);
            }
        });
        this.settlePendingModelReady();
    }

    /**
     * Acts on a model_ready that arrived while the objects were being created. Called at
     * the end of the startup, whether or not anything was parked.
     */
    settlePendingModelReady() {
        if (!this.pendingModelReady) {
            return;
        }
        this.pendingModelReady = false;
        this.log.info('The dSS re-initialized its model during the startup - restarting now that it is through');
        this.restartAdapter(10000, 'the dSS re-initialized its apartment model during the startup');
    }

    /**
     * Lets a state that stands for a moment fall back to false after
     * MOMENTARY_SCENE_RELEASE - a momentary scene, or a button the dSS reports as pressed.
     *
     * @param {string} stateId state that was just set to true
     */
    releaseMomentaryState(stateId) {
        const pending = this.momentaryReleases.get(stateId);
        // A repeat re-arms instead of adding a second release, so a wall switch that sends
        // its Stop three times still produces one true and one false
        pending && clearTimeout(pending);
        this.momentaryReleases.set(
            stateId,
            setTimeout(() => {
                this.momentaryReleases.delete(stateId);
                if (this.isStopping()) {
                    return;
                }
                this.setDssState(stateId, false);
                // Never setTimeout(fn, undefined): that fires on the next tick and would
                // turn the pulse into no pulse at all
            }, this.momentaryReleaseDelay || MOMENTARY_SCENE_RELEASE),
        );
    }

    /**
     * Sorts classic API activity into the counters of the status tab.
     *
     * @param {string} kind 'request' | 'eventPoll' | 'event'
     * @param {string} detail request path or event name
     */
    countClassicActivity(kind, detail) {
        if (!this.apiActivity) {
            return;
        }
        if (kind === 'event') {
            return void this.apiActivity.count('classic.events');
        }
        if (kind === 'eventPoll') {
            // Der permanente Long-Poll ist Zuhoeren, kein Arbeitsauftrag - er wuerde
            // die Request-Zahl nur kuenstlich aufblasen
            return;
        }
        this.apiActivity.count('classic.requests');
        if (detail.includes('/json/metering/')) {
            this.apiActivity.count('classic.meterReads');
        } else if (
            detail.includes('getOutputValue') ||
            // covers the named channel read of vDC devices in both spellings,
            // getOutputChannelValue and getOutputChannelValue2
            detail.includes('getOutputChannelValue') ||
            detail.includes('getConfig')
        ) {
            this.apiActivity.count('classic.outputReads');
        } else if (
            /callScene|undoScene|setValue|setOutputValue|\/state\/set|pushSensorValue|setTemperatureControlValues|\/event\/raise/.test(
                detail,
            )
        ) {
            // Geschriebene Befehle - die zweite Richtung der Ereignisse-und-Steuerung-Zeile
            this.apiActivity.count('classic.commands');
        }
    }

    /**
     * @param {string} kind currently always 'request'
     * @param {string} apiPath
     */
    countSmartHomeActivity(kind, apiPath) {
        if (!this.apiActivity || kind !== 'request') {
            return;
        }
        this.apiActivity.count('smarthome.requests');
        if (apiPath.includes('/meterings/values')) {
            this.apiActivity.count('smarthome.meterReads');
        } else if (apiPath.includes('/apartment/status')) {
            this.apiActivity.count('smarthome.statusReads');
        }
    }

    /**
     * Writes the rolling 10 minute activity into info.apiActivity, at most every
     * 30 seconds. The status tab of the settings renders it live - that is the
     * proof that a path really works, not just that it is configured.
     */
    publishApiActivity() {
        if (this.isStopping() || !this.apiActivity) {
            return;
        }
        const counts = this.apiActivity.snapshot();
        const payload = JSON.stringify({
            windowMinutes: 10,
            classic: {
                requests: counts['classic.requests'] || 0,
                events: counts['classic.events'] || 0,
                commands: counts['classic.commands'] || 0,
                meterReads: counts['classic.meterReads'] || 0,
                outputReads: counts['classic.outputReads'] || 0,
            },
            smarthome: {
                requests: counts['smarthome.requests'] || 0,
                meterReads: counts['smarthome.meterReads'] || 0,
                statusReads: counts['smarthome.statusReads'] || 0,
                notifications: counts['smarthome.notifications'] || 0,
            },
        });
        if (payload === this.lastApiActivityPayload) {
            return;
        }
        this.lastApiActivityPayload = payload;
        this.setState('info.apiActivity', payload, true);
    }

    /**
     * Opens the notification websocket of the Smart Home API as a safety net.
     *
     * The notifications carry no payload - they only say THAT something changed, and
     * they fire for every meter tick. Everything driven by buttons and scenes is
     * already reported precisely by the classic events, so the reaction here is a
     * hard rate-limited reconciliation (see DSSStructure.reconcileOutputValues): it
     * catches changes made past ioBroker, e.g. a third-party app writing an output
     * directly. The client reconnects on its own; a dSS without the websocket just
     * leaves the adapter running like before.
     */
    startNotificationChannel() {
        if (!this.smartHome || !this.dssStruct) {
            return;
        }
        this.smartHome.on('statusChanged', () => {
            if (this.isStopping() || !this.dssStruct) {
                return;
            }
            if (this.dssStruct.reconcileOutputValues()) {
                this.log.debug('Smart Home notification: reconciling the output values');
            }
        });
        this.smartHome.on('structureChanged', () => {
            // The classic model_ready event reports the same and restarts the adapter
            this.log.debug('The dSS reports a structure change');
        });
        this.smartHome.on('notificationConnected', () => this.log.debug('Smart Home notification channel connected'));
        this.smartHome.on('notification', () => this.apiActivity && this.apiActivity.count('smarthome.notifications'));
        this.smartHome.startNotifications().then(
            () =>
                // A start that had nothing to do (stopping, or another start still
                // running) resolves without a socket - that is not an open channel
                this.smartHome && this.smartHome.websocket
                    ? this.log.info(
                          'Smart Home notification channel is active - changes made outside of ioBroker are reconciled automatically',
                      )
                    : this.log.debug('Smart Home notification channel was not started'),
            err =>
                this.log.info(
                    `Smart Home notification channel is not available (${configUtils.errorMessage(err)}) - the adapter works without it and keeps retrying in the background`,
                ),
        );
    }

    /**
     * Creates the client for the new Smart Home API, if it is switched on and configured.
     *
     * Returns null in every other case. The adapter then behaves exactly as before: the
     * classic API stays the fallback for everything, so a missing key or an unreachable
     * host must never keep the adapter from starting.
     *
     * @returns {DSSSmartHome|null}
     */
    createSmartHomeClient() {
        if (!configUtils.normalizeBoolean(this.config.useSmartHomeApi, false)) {
            return null;
        }
        if (!this.config.smartHomeApiKey && !this.dss) {
            this.log.warn(
                'The Smart Home API is switched on but there is neither an API key nor a connection to the ' +
                    'classic interface - falling back to the classic API',
            );
            return null;
        }
        if (!this.config.smartHomeApiKey) {
            // The new API also accepts the login of the classic interface (measured for
            // every endpoint this adapter reads and for the notification websocket), so
            // a key is a convenience, not a requirement
            this.log.info(
                'No Smart Home API key configured - using the login of the classic interface for the new API',
            );
        }
        // Same reasoning as for the app token: a value that is not a hex string usually
        // means js-controller could not decrypt it (e.g. after restoring a backup on
        // another host), and the dSS would only answer with an anonymous 401
        if (this.config.smartHomeApiKey && !Digitalstrom.looksLikeAppToken(this.config.smartHomeApiKey)) {
            this.log.error(
                'The stored Smart Home API key does not look like a valid key (expected a long hex string). ' +
                    'Please open the adapter configuration, create the API key again and save. ' +
                    'The adapter tries to use it anyway.',
            );
        }
        try {
            const client = new DSSSmartHome({
                host: this.config.host,
                apiKey: this.config.smartHomeApiKey,
                // The session of the classic client, renewed by it: serves without a
                // key, and catches a key the dSS revoked without taking the path down
                getSessionToken: this.dss
                    ? forceRenew => {
                          const dss = /** @type {any} */ (this.dss);
                          forceRenew && dss.invalidateSession();
                          return dss.getSessionToken();
                      }
                    : undefined,
                validateCertificate: this.config.validateCertificate,
                onActivity: (kind, apiPath) => this.countSmartHomeActivity(kind, apiPath),
                logger: {
                    silly: this.log.silly.bind(this),
                    debug: this.log.debug.bind(this),
                    info: this.log.info.bind(this),
                    warn: this.log.warn.bind(this),
                    error: this.log.error.bind(this),
                },
            });
            this.log.info(
                'Smart Home API is active: meter values are read with one request instead of two per ' +
                    'circuit, and device output values with one status request instead of one read per channel',
            );
            return client;
        } catch (err) {
            this.log.warn(
                `Could not create the Smart Home API client (${configUtils.errorMessage(err)}) - falling back to the classic API`,
            );
            return null;
        }
    }

    /**
     * Validates the configured polling interval independently of the admin UI.
     * Invalid values must never produce an aggressive timer.
     *
     * @param {unknown} configuredSeconds raw value from the instance config
     * @returns {number} interval in ms, 0 means polling is disabled
     */
    static normalizePollInterval(configuredSeconds) {
        if (configuredSeconds === undefined || configuredSeconds === null || configuredSeconds === '') {
            return DEFAULT_POLL_INTERVAL;
        }
        const seconds = Number(configuredSeconds);
        if (!Number.isFinite(seconds)) {
            return DEFAULT_POLL_INTERVAL;
        }
        if (seconds <= 0) {
            return 0; // explicitly disabled
        }
        return Math.min(Math.max(Math.round(seconds), MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS) * 1000;
    }

    initializeDSSData(callback) {
        const dss = this.dss;
        const dssStruct = this.dssStruct;
        if (!dss || !dssStruct) {
            return void (callback && callback('No DSS connection available'));
        }
        dss.requestAsync('system', 'version').then(
            dssVersion => {
                this.log.debug(`version: ${JSON.stringify(dssVersion)}`);

                dssStruct.init(err => {
                    if (err) {
                        return void (callback && callback(err));
                    }

                    callback && callback(null);
                });
            },
            err => {
                this.log.error(`Error getVersion:${(err && err.message) || JSON.stringify(err)}`);
                callback && callback(err);
            },
        );
    }

    startDataPolling(fromTimeout) {
        if (this.dataPollTimeout) {
            !fromTimeout && clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }
        if (this.isStopping()) {
            return;
        }
        if (this.dataPollInterval === 0) {
            this.log.info('Data polling deactivated.');
            return;
        }
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return;
        }
        dssStruct.updateMeterData((failed, total) => {
            if (this.isStopping()) {
                return;
            }
            // If every single meter request failed the DSS is most likely unreachable
            if (total > 0) {
                this.setConnected(failed < total);
            }
            this.dataPollTimeout = setTimeout(() => this.startDataPolling(true), this.dataPollInterval);
        });
    }

    /**
     * Makes sure the events are subscribed exactly once, and answers when they are.
     *
     * The subscription is started early, before the objects exist, so almost nothing is
     * lost while they are built. This is the authoritative attempt afterwards: if the
     * early one is still in flight it waits for it - firing nine more subscribes into a
     * running one buys nothing - and if the early one failed it tries again, because
     * failing the whole start on a transient early error would be a regression.
     *
     * @param {(err: Error|null) => void} callback
     */
    ensureEventSubscription(callback) {
        if (!this.eventSubscriptionStarted) {
            return void this.initializeSubscriptions(callback);
        }
        const useResult = err => {
            if (err) {
                this.eventSubscriptionStarted = false;
                return void this.initializeSubscriptions(callback);
            }
            callback(null);
        };
        if (this.eventSubscriptionResult !== undefined) {
            return void useResult(this.eventSubscriptionResult);
        }
        this.eventSubscriptionWaiters.push(useResult);
    }

    /**
     * Starts the subscription before the objects exist. Errors are not fatal here - see
     * ensureEventSubscription(), which decides the start.
     */
    startEarlyEventSubscription() {
        this.eventSubscriptionStarted = true;
        this.eventSubscriptionResult = undefined;
        this.initializeSubscriptions(err => {
            this.eventSubscriptionResult = err || null;
            const waiting = this.eventSubscriptionWaiters;
            this.eventSubscriptionWaiters = [];
            waiting.forEach(cb => cb(err || null));
        });
    }

    /**
     * Lets the early subscription count as failed, so the authoritative attempt subscribes
     * again instead of trusting a channel that is not delivering.
     *
     * @param {Error|null} err what the event channel reported, may be nothing usable
     */
    failEarlyEventSubscription(err) {
        this.eventSubscriptionStarted = false;
        this.eventSubscriptionResult = undefined;
        const waiting = this.eventSubscriptionWaiters;
        this.eventSubscriptionWaiters = [];
        waiting.forEach(cb => cb(err));
    }

    initializeSubscriptions(callback) {
        const eventNames = Object.keys(dssConstants.availableEvents).filter(name => dssConstants.availableEvents[name]);
        if (!this.dss) {
            return void (callback && callback(new Error('No DSS connection available')));
        }
        // Handlers first, subscriptions second - see registerEventHandlers()
        this.registerEventHandlers(eventNames);
        this.dss.subscribeEvents(eventNames, errs => {
            /** @type {Error|null} */
            let subscriptionError = null;
            if (errs && Array.isArray(errs) && errs.length) {
                this.log.warn(`Error to subscribe to ${errs.length} events. See the following log lines.`);
                errs.forEach((err, idx) => this.log.warn(`${idx}: ${(err && err.message) || err}`));
                subscriptionError = new Error(
                    `${errs.length} of ${eventNames.length} event subscriptions failed: ${errs
                        .map(err => (err && err.message) || err)
                        .join('; ')}`,
                );
            } else {
                this.log.debug(`Successfully subscribed to ${eventNames.length} Events`);
            }

            callback && callback(subscriptionError);
        });
    }

    /**
     * Registers all event handlers on the DSS client.
     *
     * This must happen BEFORE subscribeEvents() is called: all events share one
     * subscription id, and its long-poll starts as soon as the last subscription
     * succeeded - before subscribeEvents() answers its own callback. Registering the
     * handlers only in that callback would silently drop the events of the first poll,
     * and those events are consumed on the DSS and lost for good.
     *
     * Idempotent: a second call must not add a second set of listeners.
     *
     * @param {string[]} eventNames all subscribed event names
     */
    registerEventHandlers(eventNames) {
        if (this.eventHandlersRegistered || !this.dss || !this.dssStruct) {
            return;
        }
        this.eventHandlersRegistered = true;
        // Captured once: both are created together in main() and are never replaced
        // afterwards. The local constants also keep the handlers free of repeated null checks.
        const dss = this.dss;
        const dssStruct = this.dssStruct;
        dss.on(
            'deviceSensorValue',
            this.parkable(data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice || data.properties.sensorValueFloat === undefined) {
                    this.log.info(`--INVALID ${JSON.stringify(data)}`);
                    return;
                }
                const sourceDeviceId =
                    dssStruct.stateMap[`${data.source.dSUID}.sensors.${data.properties.sensorIndex}`];
                if (!sourceDeviceId) {
                    this.log.info('INVALID Device Sensor update');
                    return;
                }
                this.setDssState(sourceDeviceId, data.properties.sensorValueFloat);
            }),
        );

        dss.on(
            'deviceBinaryInputEvent',
            this.parkable(data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice || data.properties.inputType === undefined) {
                    this.log.info(`--INVALID ${JSON.stringify(data)}`);
                    return;
                }
                const sourceDeviceId =
                    dssStruct.stateMap[`${data.source.dSUID}.binaryInputs.${data.properties.inputIndex}`];
                if (!sourceDeviceId) {
                    this.log.info('INVALID Device Binary input event');
                    return;
                }
                this.setDssState(sourceDeviceId, parseInt(data.properties.inputState, 10) + 1);
            }),
        );

        const handleStateChange = data => {
            this.eventLog(data.name, data, true);
            if (!data.properties || !data.properties.statename) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            const statename = data.properties.statename;
            const sourceDeviceId = dssStruct.stateMap[statename];
            if (!sourceDeviceId) {
                // Helper states of dSS addons (e.g. "<dsuid>_open-tilded" of the
                // window-states addon, "queue-active" of the climate control) have no
                // ioBroker object by design - the window state itself arrives via binary
                // input and device state. Any other state is named once per run, an addon
                // state as well - "operationmode.3.NotUsed" of the climate control used to
                // stay at debug although nothing maps it: the first line says what is
                // missing, every repeat is noise. A room crossing its passive cooling
                // threshold repeated the same line four times in five hours. stateMap is
                // built at startup, so a state the dSS added since then (a new user state,
                // a room put under regulation) only needs a restart, not an issue.
                if (Digitalstrom.isAddonHelperState(statename) || this.unhandledStateNames.has(statename)) {
                    this.log.debug(`Unhandled State Change: ${statename}`);
                } else {
                    this.unhandledStateNames.add(statename);
                    this.log.info(
                        `Unhandled State Change: ${statename} - the DSS reports a state this adapter has no object for. A state added in the DSS after the adapter started gets its object at the next start of the adapter; if the name is still reported after a restart, please report it in a GitHub issue so it can be mapped. Further changes of it are logged at debug level.`,
                    );
                }
                return;
            }
            // The valueTrue/valueFalse mapping of the state is applied by setDssState()
            this.setDssState(sourceDeviceId, data.properties.state);
        };
        // One wrapper for both names, so the two share a single parked identity
        const parkedStateChange = this.parkable(handleStateChange);
        dss.on('stateChange', parkedStateChange);
        dss.on('addonStateChange', parkedStateChange);

        dss.on(
            'buttonClick',
            this.liveOnly(data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice) {
                    this.log.info(`--INVALID ${JSON.stringify(data)}`);
                    return;
                }
                const buttonIndex = data.properties.buttonIndex ? data.properties.buttonIndex - 1 : 0;
                if (!dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.button`]) {
                    this.log.info('INVALID Button click');
                    return;
                }
                this.setState(dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.button`], true, true);
                this.releaseMomentaryState(dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.button`]);
                // setDssState, not setState: the DSS delivers the click type and the hold count as
                // strings while both objects are declared as numbers. The ids can be missing on
                // devices that only have the plain button state.
                const clickTypeId = dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.buttonClickType`];
                clickTypeId && this.setDssState(clickTypeId, data.properties.clickType ?? -1);
                const holdCountId = dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.buttonHoldCount`];
                holdCountId && this.setDssState(holdCountId, data.properties.holdCount ?? 0);
            }),
        );

        dss.on(
            'zoneSensorValue',
            this.parkable(data => {
                this.eventLog(data.name, data, true);
                if (
                    !data.source ||
                    !data.properties ||
                    !data.properties.sensorType ||
                    data.properties.sensorValueFloat === undefined
                ) {
                    this.log.info(`--INVALID ${JSON.stringify(data)}`);
                    return;
                }
                let sourceDeviceId = dssStruct.stateMap[`${data.source.zoneID}.sensors.${data.properties.sensorType}`];
                if (!sourceDeviceId && data.properties.sensorType === 60) {
                    sourceDeviceId = dssStruct.stateMap['0.sensors.60'];
                }
                if (!sourceDeviceId) {
                    this.log.info(
                        `INVALID Zone Sensor update: ${data.source.zoneID}.sensors.${data.properties.sensorType}`,
                    );
                    return;
                }
                this.setDssState(sourceDeviceId, data.properties.sensorValueFloat);
            }),
        );

        /**
         * Hands a scene event to the device handlers of the affected devices.
         *
         * zoneDevices is keyed by the real device groups (1, 2, 8 ...) only - the DSS never
         * lists a device in the broadcast group 0. A scene called for a whole room therefore
         * arrives with groupID "0" and has to be fanned out over every group of that room,
         * exactly like the apartment wide broadcast does.
         *
         * @param {string} zoneId zone of the scene event
         * @param {string} groupId group of the scene event, "0" means the whole room
         * @param {import('./lib/dss').DssEvent} data the scene event itself
         */
        const emitSceneToDevices = (zoneId, groupId, data) => {
            const groups = dssStruct.zoneDevices[zoneId];
            if (!groups) {
                return;
            }
            if (String(groupId) !== '0') {
                (groups[groupId] || []).forEach(dSUID => dss.emit(dSUID, data));
                return;
            }
            const handledDevices = {};
            Object.keys(groups).forEach(group =>
                groups[group].forEach(dSUID => {
                    if (!handledDevices[dSUID]) {
                        handledDevices[dSUID] = true;
                        dss.emit(dSUID, data);
                    }
                }),
            );
        };

        const handleScene = (data, value, forwarded) => {
            this.eventLog(data.name + (forwarded ? ' (forwarded)' : ''), data, true);
            if (!data.source) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            let sourceDeviceId;
            let lastSourceDeviceId;

            if (data.source.isDevice) {
                sourceDeviceId = dssStruct.stateMap[`${data.source.dSUID}.scenes.${data.properties.sceneID}`];
                if (this.lastScenes[data.source.dSUID] !== undefined) {
                    lastSourceDeviceId =
                        dssStruct.stateMap[`${data.source.dSUID}.scenes.${this.lastScenes[data.source.dSUID]}`];
                }
                if (value) {
                    this.lastScenes[data.source.dSUID] = data.properties.sceneID;
                } else {
                    this.lastScenes[data.source.dSUID] = undefined;
                }

                dss.emit(data.source.dSUID, data);
            } else if (data.source.isGroup && (data.properties.zoneID !== '0' || data.properties.groupID !== '0')) {
                sourceDeviceId =
                    dssStruct.stateMap[
                        `${data.properties.zoneID}.${data.properties.groupID}.scenes.${data.properties.sceneID}`
                    ];
                if (this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] !== undefined) {
                    lastSourceDeviceId =
                        dssStruct.stateMap[
                            `${data.properties.zoneID}.${data.properties.groupID}.scenes.${
                                this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`]
                            }`
                        ];
                }
                if (value) {
                    this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] = data.properties.sceneID;
                } else {
                    this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] = undefined;
                }

                // No initializeOutputValues check here: the device handlers also apply the
                // scene preset values (usePresetValues) and gate the real DSS read on that
                // option themselves.
                if (!forwarded) {
                    emitSceneToDevices(data.properties.zoneID, data.properties.groupID, data);
                }
            } else if (
                data.source.isApartment ||
                (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0')
            ) {
                sourceDeviceId = dssStruct.stateMap[`0.0.scenes.${data.properties.sceneID}`];
                if (this.lastScenes['0.0'] !== undefined) {
                    lastSourceDeviceId = dssStruct.stateMap[`0.0.scenes.${this.lastScenes['0.0']}`];
                }
                if (value) {
                    this.lastScenes['0.0'] = data.properties.sceneID;
                } else {
                    this.lastScenes['0.0'] = undefined;
                }

                if (!forwarded) {
                    const handledDevices = {};
                    Object.keys(dssStruct.zoneDevices).forEach(zoneId => {
                        Object.keys(dssStruct.zoneDevices[zoneId]).forEach(groupId => {
                            dssStruct.zoneDevices[zoneId][groupId].forEach(dSUID => {
                                if (!handledDevices[dSUID]) {
                                    dss.emit(dSUID, data);
                                    handledDevices[dSUID] = true;
                                }
                            });
                        });
                    });
                }
            }

            if (sourceDeviceId) {
                this.setDssState(sourceDeviceId, value);
                lastSourceDeviceId &&
                    lastSourceDeviceId !== sourceDeviceId &&
                    value &&
                    this.setDssState(lastSourceDeviceId, false);
                const idArr = sourceDeviceId.split('.');
                idArr[idArr.length - 1] = 'sceneId';
                const sceneIdState = idArr.join('.');
                if (value) {
                    this.setDssState(sceneIdState, data.properties.sceneID);
                } else {
                    this.setDssState(sceneIdState, null);
                }
                // A Stop, an Increment or an Impulse is a command, not a preset, and the
                // dSS never sends the undoScene that would release it again - the state
                // would stay true from the first press to the end of the run. sceneId is
                // deliberately NOT released: it keeps answering "the last scene called
                // here was Stop", with its own timestamp.
                // The scene and group are read HERE, synchronously: the zone-wide and
                // apartment-wide expansion further down mutates data.properties, so a
                // callback reading them later would see the last group of that loop.
                if (value && Digitalstrom.isMomentaryScene(data.properties.sceneID, data.properties.groupID)) {
                    this.releaseMomentaryState(sourceDeviceId);
                }
                // The room temperature control is switched through the scenes of group 48.
                // Keep the readable operation mode of that room in sync with them.
                if (value && String(data.properties.groupID) === '48') {
                    const operationModeState = dssStruct.stateMap[`${data.properties.zoneID}.48.operationMode`];
                    operationModeState && this.setDssState(operationModeState, data.properties.sceneID);
                }
            } else if (!forwarded) {
                this.logUnmappedSceneCall(data);
            }

            // When Scene is called on zone level we also update all groups in that zone
            if (data.source.isGroup && data.properties.zoneID !== '0' && data.properties.groupID === '0') {
                if (dssStruct.zoneDevices[data.properties.zoneID]) {
                    Object.keys(dssStruct.zoneDevices[data.properties.zoneID]).forEach(group => {
                        data.properties.groupID = group.toString();
                        handleScene(data, value, true);
                    });
                }
            } else if (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0') {
                dssStruct.apartmentStructure.zones.forEach(zone => {
                    if (!dssStruct.zoneDevices[zone.id]) {
                        return;
                    }
                    data.properties.zoneID = zone.id.toString();
                    Object.keys(dssStruct.zoneDevices[zone.id]).forEach(group => {
                        data.properties.groupID = group.toString();
                        handleScene(data, value, true);
                    });
                });
            }

            //console.log('Check Button: ' + dssStruct.stateMap[data.properties.originDSUID + '.0.button']);
            // A press is a moment, not a level: the dSS reports it and never takes it back,
            // so the state used to stay true from the first press to the end of the run -
            // the same defect the momentary scenes had, on the state right next to them.
            if (!forwarded && data.properties.callOrigin === '9') {
                if (data.properties.originDSUID && dssStruct.stateMap[`${data.properties.originDSUID}.0.button`]) {
                    this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.button`], true, true);
                    this.releaseMomentaryState(dssStruct.stateMap[`${data.properties.originDSUID}.0.button`]);
                    dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonClickType`] &&
                        this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonClickType`], 0, true);
                    dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonHoldCount`] &&
                        this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonHoldCount`], 0, true);
                } else if (data.source.dSUID && dssStruct.stateMap[`${data.source.dSUID}.0.button`]) {
                    this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.button`], true, true);
                    this.releaseMomentaryState(dssStruct.stateMap[`${data.source.dSUID}.0.button`]);
                    dssStruct.stateMap[`${data.source.dSUID}.0.buttonClickType`] &&
                        this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.buttonClickType`], 0, true);
                    dssStruct.stateMap[`${data.source.dSUID}.0.buttonHoldCount`] &&
                        this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.buttonHoldCount`], 0, true);
                }
            }
        };

        dss.on(
            'callScene',
            this.liveOnly(data => handleScene(data, true)),
        );
        dss.on(
            'undoScene',
            this.liveOnly(data => handleScene(data, false)),
        );

        dss.on('eventError', (eventName, errorCount, err) => {
            if (this.pendingEvents) {
                // The objects do not exist yet. Restarting here would loop an adapter that
                // never writes a single value - before the early subscription this state
                // could not be reached at all. The subscription counts as failed instead,
                // so the authoritative attempt after the initial values tries again.
                this.log.warn(
                    `Event polling errors (${eventName}) while the objects were being created: ${err} - subscribing again after the startup`,
                );
                this.failEarlyEventSubscription(configUtils.asError(err));
                return;
            }
            this.log.warn(`Too many event polling errors (${eventName}): ${err} - restarting adapter`);
            this.setConnected(false);
            this.restartAdapter(2000, `of too many event polling errors (${eventName})`);
        });

        dss.on('model_ready', () => {
            // The DSS finished (re-)initializing its apartment model, e.g. after a DSS
            // restart or structure change - restart to resync structure and subscriptions
            this.log.info(
                'DSS apartment model was (re-)initialized (model_ready event) - restarting adapter to resync the structure',
            );
            if (this.pendingEvents) {
                // Since the subscription moved to the front this can arrive WHILE the
                // objects are being created, which it never could before. Restarting in
                // the middle of that would throw away a structure that is half built and,
                // if the dSS keeps re-initializing, would loop without ever writing a
                // value. The structure being read right now is stale either way, so the
                // restart is remembered and done once the startup is through.
                this.pendingModelReady = true;
                return;
            }
            this.restartAdapter(10000, 'the dSS re-initialized its apartment model (model_ready)');
        });
        // Log unhandled Events to see what happens so at all
        eventNames.forEach(
            eventName =>
                dss.listenerCount(eventName) === 0 && dss.on(eventName, data => this.eventLog(eventName, data, false)),
        );
    }

    /**
     * Converts a single DSS value to the type declared for the ioBroker object.
     *
     * The DSS delivers numeric values as strings in many places, so js-controller would
     * otherwise complain about the type of every sensor value, scene id and state.
     *
     * @param {string} id
     * @param {unknown} value
     * @returns {ioBroker.StateValue} value converted to the declared type
     */
    coerceScalarValue(id, value) {
        if (value === null || value === undefined) {
            return null;
        }
        const obj = this.dssStruct && this.dssStruct.dssObjects && this.dssStruct.dssObjects[id];
        const type = obj && obj.common && obj.common.type;
        if (type === 'number' && typeof value !== 'number') {
            const numeric = parseFloat(String(value));
            return Number.isNaN(numeric) ? null : numeric;
        }
        if (type === 'boolean' && typeof value !== 'boolean') {
            // Prefer the value mapping the DSS reported for this state
            const native = obj.native || {};
            if (native.valueTrue !== undefined && value === native.valueTrue) {
                return true;
            }
            if (native.valueFalse !== undefined && value === native.valueFalse) {
                return false;
            }
            if (value === DSSStructure.UNKNOWN_STATE_WORD) {
                // The dSS has no information about this state (see UNKNOWN_STATE_WORD). It
                // creates the room state heating as unknown, and a dSS20 1.19.13 answers
                // zone.<id>.heating like that in all eight rooms of a real installation,
                // five of them with a running temperature control. That is neither true nor
                // false, and no stale vocabulary either, so it is not reported: the state
                // gets no value, and the next "active"/"inactive" sets it again. The
                // toBoolean fallback made it true - "heating active" in eight rooms at
                // once, plus eight warnings per start. It sits behind the vocabulary
                // matches on purpose, so a state that declares the word itself still wins.
                return null;
            }
            if (native.valueTrue !== undefined || native.valueFalse !== undefined) {
                // This is the only signal that a declared vocabulary has gone stale, and it
                // sat on debug: on a real installation it fired five times at startup and
                // nobody ever saw it. It warns once per state now - the value itself still
                // comes out right through the toBoolean fallback, so this is a report worth
                // filing, not a failure. Once per state, because a state that keeps sending
                // the unknown word must not fill the log with it.
                if (!this.unmappedBooleanStates.has(id)) {
                    this.unmappedBooleanStates.add(id);
                    this.log.warn(
                        `Unmapped value "${value}" for boolean state ${id} (expected "${native.valueTrue}"/"${native.valueFalse}") - the value was interpreted, please report this state and value so the mapping can be corrected`,
                    );
                }
            }
            return DSSStructure.toBoolean(value);
        }
        if (type === 'string' && typeof value !== 'string') {
            return String(value);
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        // Everything else (objects, arrays, functions) has no representation as a state value
        return null;
    }

    /**
     * Converts a value that came from the DSS for writing it into a state.
     *
     * Beside plain values the adapter also passes whole state objects around: the outdoor
     * sensors carry the timestamp of the DSS, which has to be preserved. Only the value
     * itself is converted in that case.
     *
     * @param {string} id
     * @param {unknown} value
     * @returns {ioBroker.SettableState|ioBroker.StateValue|undefined} converted value, undefined stays undefined
     */
    coerceStateValue(id, value) {
        if (value === undefined) {
            // Kept as undefined on purpose: the callers use it as "no value at all"
            return undefined;
        }
        if (value === null) {
            return null;
        }
        if (typeof value === 'object' && !Array.isArray(value) && 'val' in value && value.val !== undefined) {
            const state = /** @type {ioBroker.SettableState} */ (value);
            return { ...state, val: this.coerceScalarValue(id, state.val) };
        }
        return this.coerceScalarValue(id, value);
    }

    /**
     * Writes an acknowledged value that came from the DSS, converted to the declared type.
     *
     * @param {string} id
     * @param {unknown} value
     */
    setDssState(id, value) {
        if (!id) {
            return;
        }
        const converted = this.coerceStateValue(id, value);
        if (converted === undefined) {
            // Writing undefined would only produce a js-controller warning, same as in
            // DSSStructure.setStateSafe()
            return;
        }
        // Everything the dSS reports comes through here - that is what keeps the known
        // value of a user state current, see DSSStructure.noteUserStateValue()
        if (this.dssStruct && typeof this.dssStruct.noteUserStateValue === 'function') {
            this.dssStruct.noteUserStateValue(id, converted);
        }
        // What is in the state now - the polling paths compare against this before they
        // re-assert a value that has not moved, see DSSStructure.setStateSafe()
        if (this.dssStruct && typeof this.dssStruct.notePublishedValue === 'function') {
            this.dssStruct.notePublishedValue(id, converted);
        }
        this.setState(id, converted, true);
    }

    eventLog(eventName, event, handled) {
        this.log.debug(`${handled ? '' : 'UNHANDLED '}EVENT: ${eventName}: ${JSON.stringify(event)}`);
    }

    /**
     * Undoes the HTML escaping that older dSS firmware applied to every name it stored, see
     * DSSStructure.decodeDssEntities(). The structure applies it to every name it builds,
     * so the names handed to registerObjects() are already decoded.
     *
     * @param {string} text name as it was stored
     * @returns {string} the name as it was typed in the dSS
     */
    static decodeDssEntities(text) {
        return DSSStructure.decodeDssEntities(text);
    }

    /**
     * True when the stored name is nothing but the old dSS escaping of today's name.
     *
     * Nobody chose such a name, so it may be replaced. Any other difference is a rename by
     * the user, and that one is kept.
     *
     * @param {unknown} storedName common.name of the existing object
     * @param {unknown} wantedName name the dSS reports now
     * @returns {boolean} true if the stored name has to be replaced once
     */
    static isDssEscapedName(storedName, wantedName) {
        return (
            typeof storedName === 'string' &&
            typeof wantedName === 'string' &&
            storedName !== wantedName &&
            Digitalstrom.decodeDssEntities(storedName) === wantedName
        );
    }

    registerObjects() {
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return;
        }
        // Read before the loop: setOrUpdateObject() removes every object it is handed from
        // this list, whatever is left afterwards is deleted as unknown
        const existing = this.objectHelper.existingStates || {};
        const objNames = Object.keys(dssStruct.dssObjects);
        this.log.info(`Create ${objNames.length} objects ...`);
        objNames.forEach(id => {
            const obj = dssStruct.dssObjects[id];
            // The DSS delivers e.g. state values as strings - the object is created with its
            // declared type right away, so the initial value has to match it.
            const initValue = this.coerceStateValue(id, obj.value);
            const onChange = obj.onChange;
            delete obj.value;
            delete obj.onChange;
            // common.write is mandatory for a state, and a missing one is read differently:
            // the admin offers to edit the state, the type detector treats it as read-only.
            // Writable is exactly what has a write handler. It is decided HERE because only
            // now is the handler final - the light, shade and single channel paths hang it
            // onto the generic output channel after addStateObject, and the objectHelper
            // keeps an explicit flag, so an earlier false could never become true again.
            // An explicit flag of the definition stays as it is.
            if (obj.type === 'state' && obj.common && typeof obj.common.write !== 'boolean') {
                obj.common.write = typeof onChange === 'function';
            }

            // The stored name normally wins, the user may have renamed the object. An object
            // created while the dSS still escaped its names kept "Schlafen &amp; Bad" that way
            // forever. That name is written ONCE - from the next start on both are equal and
            // the stored name wins again. The dSS may still answer with the escaped name
            // (it keeps what old firmware stored), so the wanted name is decoded by the
            // structure first; otherwise both would be equal and nothing would be repaired.
            const storedName = existing[id] && existing[id].common ? existing[id].common.name : undefined;
            const repairName = Digitalstrom.isDssEscapedName(storedName, obj.common && obj.common.name);
            if (repairName) {
                this.log.info(`Name of ${id} corrected from "${storedName}" to "${obj.common.name}"`);
            }
            this.objectHelper.setOrUpdateObject(id, obj, repairName ? [] : ['name'], initValue, onChange);
        });
    }

    setInitialValues(callback, list) {
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return void (callback && callback());
        }
        if (list === undefined) {
            list = Object.keys(dssStruct.initialObjectValues);
        }
        if (list && !list.length) {
            return callback && callback();
        }
        const id = list.shift();
        const value = dssStruct.initialObjectValues[id];
        if (value === undefined) {
            // undefined values would only produce js-controller warnings
            return void setImmediate(() => this.setInitialValues(callback, list));
        }
        const converted = this.coerceStateValue(id, value);
        if (converted === undefined) {
            return void setImmediate(() => this.setInitialValues(callback, list));
        }
        this.setState(id, converted, true, () => this.setInitialValues(callback, list));
    }

    clearAdditionalObjects(delIds, callback) {
        if (typeof delIds === 'function') {
            callback = delIds;
            delIds = null;
        }
        if (!delIds && this.objectHelper.existingStates) {
            delIds = Object.keys(this.objectHelper.existingStates);
            if (delIds.length) {
                // Normalized again right at the destructive branch: only an unambiguously
                // true value may delete objects, whatever the configuration contains.
                if (!configUtils.normalizeBoolean(this.config.deleteUnknownObjects, false)) {
                    // Devices that are temporarily absent (offline circuit, unreachable device)
                    // would lose their objects including all custom settings (history, influxdb, ...).
                    // So only report them and let the user decide via the config option.
                    this.log.info(
                        `The following objects are unknown to the current DSS structure and would be deleted if "Delete unknown objects" is enabled in the adapter settings: ${JSON.stringify(
                            delIds,
                        )}`,
                    );
                    return void (callback && callback());
                }
                this.log.info(`Deleting the following states: ${JSON.stringify(delIds)}`);
            }
        }
        if (!delIds || !delIds.length) {
            return void (callback && callback());
        }
        const del = delIds.shift();
        this.delObject(del, err => {
            if (err) {
                this.log.info(` Could not delete ${del}: ${err}`);
            }
            if (this.objectHelper.existingStates) {
                delete this.objectHelper.existingStates[del];
            }
            setImmediate(() => this.clearAdditionalObjects(delIds, callback));
        });
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode. The class rides along on the factory BEFORE
    // it becomes module.exports: assigning to module.exports twice is what a module with
    // an export assignment may not do, and the object js-controller receives is the same
    // either way.
    /**
     * @param {Partial<import('@iobroker/adapter-core').AdapterOptions>} [options]
     */
    const factory = options => new Digitalstrom(options);
    // Additionally exposed for unit tests - js-controller only uses the function itself
    factory.Digitalstrom = Digitalstrom;

    module.exports = factory;
} else {
    // otherwise start the instance directly
    new Digitalstrom();
}
