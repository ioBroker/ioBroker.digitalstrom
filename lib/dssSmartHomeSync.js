const dssConstants = require('./constants');
const { errorMessage } = require('./configUtils');

/**
 * Reads device output values through the Smart Home API - ONE apartment status request
 * instead of one classic request per output channel.
 *
 * The status delivers every output of every device in a single answer (~59 KB), in
 * exactly the scale the ioBroker states use: the new API normalizes each channel to its
 * official value range (brightness 0..100, colortemp 0..1000, ...), which is precisely
 * `classic * max / nativeMax` - the conversion the classic read path applies by hand.
 * Verified against a dSS20 1.19.13, see docs/smarthome-api.md.
 *
 * Two rules from the live measurements shape this class:
 *
 * 1. A moving output carries NO value in the status (the field is simply absent while a
 *    blind travels). A missing value therefore means "unchanged", never null - the
 *    channel stays pending and is asked again with the next follow-up.
 * 2. Requests are coalesced: a room scene touches many devices at once, and one status
 *    answer covers them all. The window is fixed (not sliding), so a steady stream of
 *    scene calls cannot delay the read forever.
 *
 * Every channel the status cannot deliver falls back to the classic read path, so with
 * the Smart Home API switched off or failing the behaviour is exactly the one before.
 *
 * Some channels the status NEVER answers - measured live: the outputs of audio
 * devices (their status entries carry no outputs at all) and every channel only a
 * failing device would leave out permanently. Such channels are learned after
 * DEFAULT_LEARN_AFTER_MISSES exhausted follow-up budgets and from then on go to the
 * classic read immediately - without burning ~60 s of follow-ups per trigger and
 * without follow-up status requests that can never succeed. One look at every later
 * status answer heals the learning (a blind that just travelled longer than the
 * whole budget, or a firmware that starts delivering the channel).
 */

/**
 * The part of the DSSStructure this sync works with. Written down as the surface it
 * really touches instead of the whole class - it is exactly the surface the tests hand
 * in, and the optional members are the ones the code below guards before calling.
 *
 * @typedef {object} SyncStructure
 * @property {() => boolean} isAdapterStopping true while the adapter is shutting down
 * @property {(func: () => void, delay: number) => NodeJS.Timeout} setClearableTimeout timer that is also cancelled on stop
 * @property {(dev: any, outputType: string, prio?: 'high'|'medium'|'low', options?: {report?: boolean}) => void} queueClassicOutputRead the classic read of one output channel
 * @property {(id: string, value: any, options?: {skipUnchanged?: boolean}) => void} setStateSafe writes one ioBroker state
 * @property {Record<string, any>} initialObjectValues last written value per state id
 * @property {Set<any>} [pendingTimeouts] the timers the structure clears on stop
 * @property {Record<string, any>} [devicesByDsuid] the devices of the structure by dSUID
 * @property {(status: any) => any} [applyZoneTemperatureStatus] takes the zone temperature values out of a status answer
 * @property {(api: 'classic'|'smarthome') => void} [reportOutputApi] records which API delivered the last output values
 */

/**
 * The part of the DSSSmartHome client this sync works with - one single request.
 *
 * @typedef {object} SyncSmartHome
 * @property {() => Promise<any>} getApartmentStatus all current values in one answer
 */

/**
 * One device waiting for its output values, as the flush works through them.
 *
 * @typedef {object} PendingRead
 * @property {any} dev the structure device the values belong to
 * @property {Set<string>} outputTypes channels still without an answer
 * @property {number} attempts status answers that did not carry them
 * @property {number} lastTriggeredAt when the last trigger restarted the budget
 * @property {number} travellingUntil a running travel does not burn the budget until then
 * @property {boolean} probeOnly true while every channel here is a probe of a learned gap
 */

/**
 * The logging surface of the ioBroker adapter. Only the log is used here, so only the
 * log is asked for - the tests pass a recording logger instead of a real adapter.
 *
 * @typedef {object} SyncAdapter
 * @property {{debug: (message: string) => void, info: (message: string) => void, warn: (message: string) => void, error: (message: string) => void}} log the adapter logger
 */

/** Collect triggers for this long before the one status request */
const DEFAULT_DEBOUNCE = 2000;
/** A travelling blind carries no value - ask again after this pause */
const DEFAULT_FOLLOW_UP_DELAY = 15000;
/** After this many follow-ups the classic read takes over */
const DEFAULT_MAX_FOLLOW_UPS = 4;
/** After a failed status request the classic path serves alone for this long */
const DEFAULT_FAILURE_BACKOFF = 5 * 60 * 1000;
/** A channel is considered undeliverable after this many exhausted follow-up budgets */
const DEFAULT_LEARN_AFTER_MISSES = 2;
/**
 * How long a channel stays on the fast re-read schedule after its announced travel
 * end. Long enough to catch the real value in the next read or two, short enough that
 * a device stuck on "moving" runs into the normal follow-up budget.
 */
const TRAVEL_GRACE = 5000;
/**
 * A learned channel is probed again after this long. Healing normally happens by
 * looking at the status answers of OTHER channels - but if every channel of an
 * installation were learned (a dSS serving degraded 200-answers for a while), no
 * status request would ever run again and the learning could never heal. The
 * periodic probe bounds that state instead of latching it until the next restart.
 */
const DEFAULT_RELEARN_INTERVAL = 60 * 60 * 1000;

class SmartHomeOutputSync {
    /**
     * @param {object} options
     * @param {SyncStructure} options.structure the DSSStructure instance
     * @param {SyncSmartHome} options.smartHome the DSSSmartHome client
     * @param {SyncAdapter} options.adapter the ioBroker adapter, for its log
     * @param {number} [options.debounce]
     * @param {number} [options.followUpDelay]
     * @param {number} [options.maxFollowUps]
     * @param {number} [options.failureBackoff]
     * @param {number} [options.learnAfterMisses]
     * @param {number} [options.relearnInterval]
     */
    constructor(options) {
        this.structure = options.structure;
        this.smartHome = options.smartHome;
        this.adapter = options.adapter;
        this.debounce = options.debounce || DEFAULT_DEBOUNCE;
        this.followUpDelay = options.followUpDelay || DEFAULT_FOLLOW_UP_DELAY;
        this.maxFollowUps = options.maxFollowUps === undefined ? DEFAULT_MAX_FOLLOW_UPS : options.maxFollowUps;
        this.failureBackoff = options.failureBackoff || DEFAULT_FAILURE_BACKOFF;
        this.learnAfterMisses =
            options.learnAfterMisses === undefined ? DEFAULT_LEARN_AFTER_MISSES : options.learnAfterMisses;
        this.relearnInterval = options.relearnInterval || DEFAULT_RELEARN_INTERVAL;

        /** @type {Map<string, PendingRead>} */
        this.pending = new Map();
        /** @type {Map<string, number>} "<dSUID>|<channel>" -> exhausted follow-up budgets in a row */
        this.missCounts = new Map();
        /** @type {Map<string, number>} learned "<dSUID>|<channel>" pairs the status never answers -> learned at */
        this.undeliverable = new Map();
        /** @type {NodeJS.Timeout|null} the armed flush timer, null while none is armed */
        this.flushTimer = null;
        /** When the armed flush timer will fire - to let an earlier request pull it forward */
        this.flushTimerFireAt = 0;
        /** True while a status request is on its way */
        this.flushInFlight = false;
        this.disabledUntil = 0;
        this.warnedFailure = false;
    }

    /** @returns {number} */
    now() {
        return Date.now();
    }

    /**
     * @returns {boolean} false while a failed request keeps the classic path in charge
     */
    isAvailable() {
        return !!this.smartHome && this.disabledUntil <= this.now();
    }

    /**
     * Asks for a fresh read of the given output channels of a device.
     *
     * @param {any} dev device object of the structure, with outputChannelList. Untyped
     *   on purpose: this is the entry point every caller reaches with whatever the
     *   structure built, and the first line below is what validates it.
     * @param {string[]} [outputTypes] channel types, default every channel of the device
     * @returns {boolean} true when the sync takes care of it, false = use the classic path
     */
    requestDeviceSync(dev, outputTypes) {
        if (!dev || !dev.dSUID || !dev.outputChannelList || !this.isAvailable()) {
            return false;
        }
        const wanted =
            outputTypes && outputTypes.length
                ? outputTypes.filter(type => dev.outputChannelList[type])
                : Object.keys(dev.outputChannelList);
        if (!wanted.length) {
            return false;
        }
        const askable = [];
        let probes = 0;
        for (const type of wanted) {
            const key = `${dev.dSUID}|${type}`;
            const learnedAt = this.undeliverable.get(key);
            if (learnedAt === undefined) {
                askable.push(type);
                continue;
            }
            if (this.now() - learnedAt > this.relearnInterval) {
                // Probe an old entry once through the status again - one more
                // exhausted budget relearns it, one delivered value heals it
                this.undeliverable.delete(key);
                this.missCounts.set(key, this.learnAfterMisses - 1);
                askable.push(type);
                probes++;
                continue;
            }
            // A learned gap: the status will never answer, the classic read serves
            // right away instead of after the exhausted follow-up budget. Without
            // report - the Smart Home API stays in charge of the other channels.
            this.structure.queueClassicOutputRead(dev, type, 'medium', { report: false });
        }
        if (!askable.length) {
            // Fully handled classically - true, so the caller does not read a second time
            return true;
        }
        const existing = this.pending.get(dev.dSUID);
        const entry = existing || {
            dev,
            outputTypes: new Set(),
            attempts: 0,
            lastTriggeredAt: 0,
            travellingUntil: 0,
            probeOnly: true,
        };
        // An entry exists "only to probe" while EVERY reason it exists is such a question.
        // The moment a real trigger joins it, the full follow-up budget applies again.
        entry.probeOnly = (existing ? existing.probeOnly !== false : true) && probes === askable.length;
        askable.forEach(type => entry.outputTypes.add(type));
        // A new trigger restarts the follow-up budget - the outputs are moving again.
        // The timestamp keeps a status answer that was already on its way from
        // satisfying this trigger with values from before it.
        entry.attempts = 0;
        entry.lastTriggeredAt = this.now();
        this.pending.set(dev.dSUID, entry);
        this.scheduleFlush(this.debounce);
        return true;
    }

    /**
     * @param {number} delay ms until the pending devices are read
     */
    scheduleFlush(delay) {
        const fireAt = this.now() + delay;
        if (this.flushTimer) {
            if (fireAt >= this.flushTimerFireAt) {
                // The armed timer fires earlier or at the same time - join that read
                return;
            }
            // A fresh 2 s trigger must not wait behind a 15 s follow-up timer
            clearTimeout(this.flushTimer);
            this.structure.pendingTimeouts && this.structure.pendingTimeouts.delete(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushTimerFireAt = fireAt;
        this.flushTimer = this.structure.setClearableTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(err => {
                // flush() handles its own errors, this only guards a broken handler
                this.adapter.log.error(`Smart Home output sync failed unexpectedly: ${errorMessage(err)}`);
            });
        }, delay);
    }

    /**
     * ONE status request for everything that piled up, then classic reads for the rest.
     */
    async flush() {
        if (this.structure.isAdapterStopping() || !this.pending.size) {
            return;
        }
        if (!this.isAvailable()) {
            return void this.fallBackAll();
        }
        if (this.flushInFlight) {
            // The running read predates this timer - ask again once it is through
            return void this.scheduleFlush(this.debounce);
        }
        // A trigger that arrives while the request is on its way must not be satisfied
        // by its answer - the answer shows the state from BEFORE that trigger
        const flightStart = this.now();
        this.flushInFlight = true;
        let status;
        try {
            status = await this.smartHome.getApartmentStatus();
        } catch (err) {
            this.flushInFlight = false;
            const shutdown = !!(err && typeof err === 'object' && 'shutdown' in err && err.shutdown === true);
            if (shutdown || this.structure.isAdapterStopping()) {
                return;
            }
            this.disabledUntil = this.now() + this.failureBackoff;
            const minutes = Math.max(1, Math.round(this.failureBackoff / 60000));
            const message =
                `Could not read the output values via the Smart Home API (${errorMessage(err)}); ` +
                `reading them through the classic API and trying the Smart Home API again in ${minutes} minute${
                    minutes === 1 ? '' : 's'
                }`;
            if (this.warnedFailure) {
                this.adapter.log.debug(message);
            } else {
                this.adapter.log.warn(message);
                this.warnedFailure = true;
            }
            return void this.fallBackAll();
        }
        this.flushInFlight = false;
        if (this.structure.isAdapterStopping()) {
            return;
        }
        this.warnedFailure = false;
        const travelEndsAt = this.applyStatus(status, flightStart);
        if (typeof this.structure.applyZoneTemperatureStatus === 'function') {
            // Die Antwort traegt auch Sollwert und Stellgroesse der Raumtemperatur-
            // regelung je Zone - mitnehmen, sie ist schon bezahlt
            this.structure.applyZoneTemperatureStatus(status);
        }

        // What is left had no value in the answer - typically a travelling blind.
        // Ask again a few times, then let the classic read deliver whatever it can.
        for (const [dSUID, entry] of [...this.pending]) {
            if (entry.lastTriggeredAt > flightStart) {
                // Was not asked yet - its own read is already scheduled
                continue;
            }
            if (entry.travellingUntil > this.now()) {
                // A running travel is not a missing answer - the status told us when it
                // ends, so the budget must not burn while we wait for exactly that
                continue;
            }
            entry.attempts++;
            // A probe is a question, not a value someone is waiting for: the channel is
            // already served classically, so it gets NO follow-up at all - the one status it
            // rode along with is the answer. The hourly probe of four Sonos players used to
            // spend the full budget instead, measured twelve of the eighty-four status reads
            // of three hours, and it healed nothing in any of them.
            const followUpBudget = entry.probeOnly ? 0 : this.maxFollowUps;
            if (entry.attempts > followUpBudget) {
                this.pending.delete(dSUID);
                for (const outputType of entry.outputTypes) {
                    const key = `${dSUID}|${outputType}`;
                    const misses = (this.missCounts.get(key) || 0) + 1;
                    this.missCounts.set(key, misses);
                    if (misses >= this.learnAfterMisses && !this.undeliverable.has(key)) {
                        this.undeliverable.set(key, this.now());
                        this.adapter.log.debug(
                            `The status never answers output channel ${outputType} of ${dSUID} - ` +
                                `the classic read serves it directly from now on`,
                        );
                    }
                }
                // Without report: one undeliverable channel does not put the classic
                // path in charge, the Smart Home API keeps serving everything else
                this.fallBackEntry(entry, false);
            }
        }
        if (this.pending.size) {
            const hasFreshTrigger = [...this.pending.values()].some(entry => entry.lastTriggeredAt > flightStart);
            let delay = hasFreshTrigger ? this.debounce : this.followUpDelay;
            if (travelEndsAt !== Infinity) {
                // Ask again right after the travel ends instead of on the fixed grid -
                // that answer carries the real final position
                delay = Math.max(this.debounce, Math.min(delay, travelEndsAt - this.now() + 500));
            }
            this.scheduleFlush(delay);
        }
    }

    /**
     * Writes every pending output value the status answer carries.
     *
     * @param {any} status answer of getApartmentStatus()
     * @param {number} flightStart entries triggered after this moment are not touched
     * @returns {number} when the earliest running travel ends, Infinity without one
     */
    applyStatus(status, flightStart) {
        const statusDevices = (status && status.included && status.included.dsDevices) || [];
        const devicesById = new Map();
        for (const device of statusDevices) {
            if (device && typeof device.id === 'string') {
                devicesById.set(device.id, device);
            }
        }
        let applied = 0;
        // The earliest moment a running travel ends - the next read is due right after
        let travelEndsAt = Infinity;
        for (const [dSUID, entry] of [...this.pending]) {
            if (entry.lastTriggeredAt > flightStart) {
                // The answer predates this trigger and could carry stale values
                continue;
            }
            const statusEntry = devicesById.get(dSUID);
            const values = SmartHomeOutputSync.collectOutputValues(statusEntry, this.now());
            const travelling = SmartHomeOutputSync.collectTravellingChannels(statusEntry, this.now());
            for (const outputType of [...entry.outputTypes]) {
                const value = values.get(outputType);
                if (value === undefined) {
                    // Missing means "unchanged", never null - stays pending
                    continue;
                }
                // The status DID answer - this channel is deliverable
                this.missCounts.delete(`${dSUID}|${outputType}`);
                if (this.applyValue(entry.dev, outputType, value) === 'unsupported') {
                    // The channel exists but its semantics are not verified against the
                    // new API (boolean 0/1 channels) - the classic read knows them.
                    // Without report: the sync stays in charge, see fallBackEntry.
                    this.structure.queueClassicOutputRead(entry.dev, outputType, 'medium', { report: false });
                } else {
                    applied++;
                }
                if (travelling.has(outputType)) {
                    // An interpolated position is a good intermediate value, not the
                    // final one - the channel stays pending until the travel is over
                    continue;
                }
                entry.outputTypes.delete(outputType);
            }
            // Whatever is still pending AND travelling decides when to ask again. This
            // has to look at the pending set, not only at the channels a value was
            // written for: right after the announced end there is no value to write,
            // and exactly then the next read must come quickly.
            let entryTravelEnd = 0;
            for (const outputType of entry.outputTypes) {
                const travelEnd = travelling.get(outputType);
                if (travelEnd !== undefined) {
                    entryTravelEnd = Math.max(entryTravelEnd, travelEnd);
                    travelEndsAt = Math.min(travelEndsAt, travelEnd);
                }
            }
            entry.travellingUntil = entryTravelEnd;
            if (!entry.outputTypes.size) {
                this.pending.delete(dSUID);
            }
        }
        // A learned gap may close again - a blind that just travelled longer than the
        // whole follow-up budget, or a firmware that starts delivering the channel.
        // One look at the answer that is already here heals it, no extra request -
        // and the value it carries is applied right away instead of being thrown out.
        for (const key of [...this.undeliverable.keys()]) {
            const [dSUID, outputType] = key.split('|');
            const statusEntry = devicesById.get(dSUID);
            if (!statusEntry) {
                continue;
            }
            const value = SmartHomeOutputSync.collectOutputValues(statusEntry, this.now()).get(outputType);
            if (value === undefined) {
                continue;
            }
            this.undeliverable.delete(key);
            this.missCounts.delete(key);
            const dev = (this.structure.devicesByDsuid && this.structure.devicesByDsuid[dSUID]) || null;
            if (dev && this.applyValue(dev, outputType, value) !== 'unsupported') {
                applied++;
            }
            this.adapter.log.debug(
                `The status answers output channel ${outputType} of ${dSUID} again - back to the Smart Home API`,
            );
        }
        if (applied && typeof this.structure.reportOutputApi === 'function') {
            // Makes the division of labour visible: info.outputApi in the instance
            this.structure.reportOutputApi('smarthome');
        }
        return travelEndsAt;
    }

    /**
     * The outputs of a device status, across all its function blocks.
     *
     * @param {any} statusEntry one dsDeviceStatus entry
     * @param {number} [now] clock for the interpolation of a travelling output
     * @returns {Map<string, number>} output id (= channel type) to value
     */
    static collectOutputValues(statusEntry, now = Date.now()) {
        const values = new Map();
        /** @type {number|undefined} */
        let powerStateLevel;
        const blocks = (statusEntry && statusEntry.attributes && statusEntry.attributes.functionBlocks) || [];
        for (const block of blocks) {
            for (const output of (block && block.outputs) || []) {
                if (
                    output &&
                    typeof output.id === 'string' &&
                    typeof output.value === 'number' &&
                    isFinite(output.value)
                ) {
                    values.set(output.id, output.value);
                } else if (output && typeof output.id === 'string') {
                    const travelled = SmartHomeOutputSync.travelPosition(output, now);
                    if (travelled !== undefined) {
                        values.set(output.id, travelled);
                    }
                }
                if (
                    output &&
                    output.id === 'powerState' &&
                    typeof output.level === 'number' &&
                    isFinite(output.level)
                ) {
                    powerStateLevel = output.level;
                }
            }
        }
        // Two id mismatches of the dSS status, measured on a dSS20 1.19.13: a switched
        // socket (SW-KL200) declares the powerLevel channel but reports it as the level
        // field of a powerState output, and a blind (GR-KL300) declares the ...Indoor
        // shade channels but reports the single class-64 shade bank only under the
        // ...Outside ids - there the classic read (getConfig class 64) would deliver
        // the identical value to both, so the alias is exact by construction. The
        // level field is 0..1, NOT 0..100 like the regular output values - measured
        // live: 0 while the socket is off, 1 while it powers a device (2.4.19 wrote
        // "1 %" here). Matches the structure, which normalizes the switch threshold
        // to 0..1 as well (levelThresholds 200/255). Scaled and clamped to the
        // 0..100 state.
        if (!values.has('powerLevel') && powerStateLevel !== undefined) {
            values.set('powerLevel', Math.max(0, Math.min(100, Math.round(powerStateLevel * 100))));
        }
        for (const [indoor, outside] of [
            ['shadePositionIndoor', 'shadePositionOutside'],
            ['shadeOpeningAngleIndoor', 'shadeOpeningAngleOutside'],
        ]) {
            if (!values.has(indoor) && values.has(outside)) {
                values.set(indoor, /** @type {number} */ (values.get(outside)));
            }
        }
        return values;
    }

    /**
     * Where an output stands while it travels. The status leaves the value out for a
     * moving output, but it carries the whole journey: status "moving", where it
     * started, where it goes, and the window it takes (measured live on a dSS20
     * 1.19.13: initialValue 100, targetValue 0, 24.8 s for one full blind travel).
     * So the position IS known during the travel, it just has to be computed.
     *
     * Nothing here is assumed about how long a travel takes: the dSS sends its own
     * window with every single movement, so a slow awning, a fast roller shutter and
     * a short partial travel each carry their own.
     *
     * Clock skew between dSS and ioBroker cannot do harm: the ratio is clamped, so
     * the worst case is the start or the target position.
     *
     * @param {any} output one entry of a functionBlock outputs array
     * @param {number} now
     * @returns {number|undefined} the position now, or undefined if this is no travel
     */
    static travelPosition(output, now) {
        if (!output || output.status !== 'moving') {
            return undefined;
        }
        const from = output.initialValue;
        const to = output.targetValue;
        if (typeof from !== 'number' || typeof to !== 'number' || !isFinite(from) || !isFinite(to)) {
            return undefined;
        }
        const start = Date.parse(output.startedAt);
        const end = Date.parse(output.terminatesAt);
        if (!isFinite(start) || !isFinite(end) || end <= start) {
            return undefined;
        }
        if (now >= end) {
            // The window has passed but the dSS still says "moving": writing the target
            // now would claim the blind arrived before it did - and it may have been
            // stopped on the way. The real value is one short read away, see
            // collectTravellingChannels.
            return undefined;
        }
        const ratio = Math.max(0, (now - start) / (end - start));
        return from + (to - from) * ratio;
    }

    /**
     * The channels of a device that are still travelling, with the moment their
     * travel ends. They keep an interpolated value AND stay pending: only the answer
     * after the travel carries the real final position.
     *
     * @param {any} statusEntry one dsDeviceStatus entry
     * @param {number} now
     * @returns {Map<string, number>} output id to the end of its travel
     */
    static collectTravellingChannels(statusEntry, now) {
        const travelling = new Map();
        const blocks = (statusEntry && statusEntry.attributes && statusEntry.attributes.functionBlocks) || [];
        for (const block of blocks) {
            for (const output of (block && block.outputs) || []) {
                if (!output || typeof output.id !== 'string' || output.status !== 'moving') {
                    continue;
                }
                const end = Date.parse(output.terminatesAt);
                // The grace period keeps the channel on the fast schedule for a moment
                // after the announced end: the travel is over, the value is not in the
                // answer yet, and asking again in two seconds beats waiting a full
                // follow-up delay. It expires, so a dSS stuck on "moving" still runs
                // into the normal follow-up budget.
                if (isFinite(end) && end + TRAVEL_GRACE > now) {
                    travelling.set(output.id, end);
                }
            }
        }
        // The indoor shade channels are served from the outside ids (see
        // collectOutputValues), so they travel with them
        for (const [indoor, outside] of [
            ['shadePositionIndoor', 'shadePositionOutside'],
            ['shadeOpeningAngleIndoor', 'shadeOpeningAngleOutside'],
        ]) {
            if (!travelling.has(indoor) && travelling.has(outside)) {
                travelling.set(indoor, /** @type {number} */ (travelling.get(outside)));
            }
        }
        return travelling;
    }

    /**
     * Writes one value the way the classic read callback would have written it.
     *
     * @param {any} dev
     * @param {string} outputType
     * @param {number} value already in the ioBroker scale of the channel
     * @returns {'applied'|'unsupported'}
     */
    applyValue(dev, outputType, value) {
        const roleDef = dssConstants.outputChannelUnitRoleMap[outputType];
        const stateId = dev.outputChannelList && dev.outputChannelList[outputType];
        if (!roleDef || !stateId) {
            return 'unsupported';
        }
        if (outputType === 'brightness' && typeof dev.applyNativeLightValue === 'function') {
            // The light helper also maintains the boolean .state (switch threshold!),
            // so the value goes back to the native 0..255 scale it expects
            dev.applyNativeLightValue(Math.round(value * 2.55), { skipUnchanged: true });
            return 'applied';
        }
        if (roleDef.type === 'boolean') {
            return 'unsupported';
        }
        if (outputType === 'x' || outputType === 'y') {
            // CIE x/y arrive as 0..1 in the channel scale (measured live: 0.2235/0.3921
            // in the status), the states hold 0..10000 (max 10000 / nativeMax 65535) -
            // the factor of the offset read. Without it Math.round collapsed every
            // coordinate to 0 or 1 since 2.4.18.
            value *= 10000;
        }
        // The classic read callbacks round to whole numbers in the ioBroker scale
        const rounded = Math.round(value);
        this.structure.setStateSafe(stateId, rounded, { skipUnchanged: true });
        this.structure.initialObjectValues[stateId] = rounded;
        return 'applied';
    }

    /**
     * Classic reads for everything that is still pending. Only used while the status
     * request itself fails or the sync pauses - then the classic path really IS in
     * charge and its reads may report info.outputApi = classic.
     */
    fallBackAll() {
        const entries = [...this.pending.values()];
        this.pending.clear();
        entries.forEach(entry => this.fallBackEntry(entry, true));
    }

    /**
     * @param {{dev: any, outputTypes: Set<string>}} entry
     * @param {boolean} report whether the classic reads may flip info.outputApi
     */
    fallBackEntry(entry, report) {
        entry.outputTypes.forEach(outputType =>
            this.structure.queueClassicOutputRead(entry.dev, outputType, 'medium', { report }),
        );
    }

    stop() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pending.clear();
    }
}

module.exports = SmartHomeOutputSync;
