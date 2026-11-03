const dssConstants = require('./constants');
const DSSQueue = require('./dssQueue');
const SmartHomeOutputSync = require('./dssSmartHomeSync');
const { errorMessage } = require('./configUtils');

/**
 * A device of the apartment structure: what apartment/getStructure delivers, enriched by
 * this adapter while the objects are built. Only the fields the output handling relies on
 * are named here.
 *
 * @typedef {object} StructureDeviceKnownFields
 * @property {string} dSUID unique id of the device, its object path and its event key
 * @property {string} [name] name given in digitalSTROM, missing on an unnamed device
 * @property {boolean} [isVdcDevice] true for vDC hardware (Hue, Sonos), which answers only the named channel read
 * @property {Record<string, string>} [outputChannelList] channel type -> ioBroker state id, filled while the objects are created
 * @property {(value: number, options?: {skipUnchanged?: boolean}) => void} [applyNativeLightValue] light helper of createLightDevice, maintains the boolean .state as well
 */

/**
 * The DSS delivers many more fields per device type and a newer firmware may add further
 * ones, so the rest stays open - a closed type would reject the very fields the comment
 * above promises to leave alone. Same shape as DssResponse in configUtils.
 *
 * @typedef {StructureDeviceKnownFields & Record<string, any>} StructureDevice
 */

/**
 * A zone of the apartment structure, as far as the temperature control needs it.
 *
 * @typedef {object} StructureZoneKnownFields
 * @property {number} id zone id the DSS addresses the room by
 * @property {string} [name] name of the room, missing on an unnamed zone
 */

/**
 * @typedef {StructureZoneKnownFields & Record<string, any>} StructureZone
 */

/**
 * One zone entry of apartment/getTemperatureControlStatus. The DSS answers for EVERY
 * zone, an unregulated one carries nothing but ControlMode 0.
 *
 * @typedef {object} TemperatureControlStatusKnownFields
 * @property {number} [ControlMode] 0 when the zone is not regulated at all
 * @property {number} [ControlState] state of the controller, missing on older firmware
 * @property {number} [OperationMode] currently active operation mode (scene of group 48)
 */

/**
 * @typedef {TemperatureControlStatusKnownFields & Record<string, any>} TemperatureControlStatus
 */

const SMART_HOME_METER_RETRY_BASE = 5 * 60 * 1000;
const SMART_HOME_METER_RETRY_MAX = 60 * 60 * 1000;
/**
 * Eine apartmentStatusChanged-Meldung sagt nur, DASS sich etwas geaendert hat - und sie
 * kommt im Normalbetrieb im Sekundentakt (jede Zaehleraenderung erzeugt eine, gemessen:
 * 17 Meldungen in 75 s). Alles, was ueber Szenen und Taster laeuft, melden die
 * klassischen Events laengst gezielt. Der Abgleich per Notification faengt nur den Rest
 * (z.B. eine Dritt-App, die direkt einen Ausgang setzt) und darf deshalb hoechstens
 * alle fuenf Minuten einen 59-KB-Statusread kosten.
 */
const OUTPUT_RECONCILE_MIN_INTERVAL = 5 * 60 * 1000;
/**
 * Device sensor types read once at startup when the dSS marks them invalid:
 * 4 Active Power (1 W), 5 Output Current (1 mA), 65 Apparent Power (1 VA).
 * Linear 12 bit encodings - the native value of device/getSensorValue equals the
 * float a deviceSensorValue event would deliver. Energy meter (6) and high range
 * current (64) natives have unverified resolutions and are left to the events.
 */
const INITIAL_READ_SENSOR_TYPES = new Set([4, 5, 65]);
/**
 * buttonInputMode values that make a device with push-button inputs the master of a
 * 2-way button pair, as Device::is2WayMaster() of the dSS decides it: 6/10 pair input 1
 * with input 2 ("2-way down/up with input 2"), 8/12 input 3 with input 4, and 13/14 only
 * on an even dSID. The partner is always the next dSID (Device::tryGetPartnerDevice), and
 * the dSS leaves it out of every device list ("do not render slave devices") - the
 * installation manual says the coupled input is not listed. Its states are still in
 * /usr/states (dss-mainline src/model/device.cpp, src/web/handler/jsonhelper.cpp).
 * A SW-UMR200 pairs its outputs by outputMode instead and is not recognised here.
 */
const TWO_WAY_MASTER_BUTTON_MODES = new Set([6, 8, 10, 12]);
const TWO_WAY_MASTER_BUTTON_MODES_EVEN_DSID = new Set([13, 14]);
/** A dSUID derived from a dSID: dSID[0..11], eight zero digits, dSID[12..23], "00". */
const DSID_BASED_DSUID = /^[0-9a-f]{12}0{8}[0-9a-f]{12}00$/;

/**
 * The dSUID one dSID below the given one - the device a further input of the same
 * terminal block counts up from. Only a dSUID derived from a dSID has a serial number to
 * count with; a vDC device has a name based dSUID, and "one below" means nothing there.
 *
 * @param {string} dSUID
 * @returns {string|undefined}
 */
function previousDsidDsuid(dSUID) {
    if (typeof dSUID !== 'string' || !DSID_BASED_DSUID.test(dSUID)) {
        return undefined;
    }
    // the last four bytes of the dSID are its serial number (= the DisplayID)
    const serial = parseInt(dSUID.slice(24, 32), 16);
    if (!serial) {
        return undefined;
    }
    return `${dSUID.slice(0, 24)}${(serial - 1).toString(16).padStart(8, '0')}${dSUID.slice(32)}`;
}

/**
 * The name the dSS gives a sensor state a dSS app keeps for a room:
 * zone.zone<zone id>.group<group id>.type<sensor type>.<identifier>. The dSS publishes it
 * under /usr/addon-states/<app>/, not under /usr/states, and reports its changes as a
 * plain stateChange (dss-mainline src/model/state.cpp StateSensor and
 * publishToPropertyTree, src/event/event_create.cpp createStateChangeEvent). The
 * user-defined states end in a timestamp, the climate control in "passiveCooling".
 */
const ZONE_SENSOR_STATE = /^zone\.zone(\d+)\.group(\d+)\.type(\d+)\.([^.]+)$/;

/**
 * The characters js-controller replaces in an object id (FORBIDDEN_CHARS of its tools). The
 * identifier of such a sensor state is whatever the app passed to zone.addStateSensor(),
 * and only setObject/extendObject clean it: setState keeps the raw id, so the value would
 * land next to its object, and the object would be created anew at every start.
 */
const FORBIDDEN_ID_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;

/**
 * The Smart Home API sometimes returns numbers as strings. Empty strings, null and
 * non-finite values must not silently become a real meter value (notably null -> 0).
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function finiteMeterValue(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Converts the meter reading of a circuit from watt seconds to kilowatt hours, rounded to
 * whole watt hours.
 *
 * The plain division left values such as 4009.7331175000004 kWh in every write - digits
 * below a watt hour that no meter of a dSM measures, and a float tail that made two equal
 * readings look different. The total is rounded, not the step, so nothing adds up.
 *
 * @param {number} wattSeconds meter value as the dSS reports it
 * @returns {number} kWh with at most three decimals
 */
function wattSecondsToKwh(wattSeconds) {
    return Math.round(wattSeconds / 3600) / 1000;
}

/**
 * Turns the HTML codes older dSS firmware put into names back into the characters.
 *
 * The dSS ran each name set through its JSON API through escapeHTML() and handed the stored
 * text out unchanged, so getCircuits answered "Schlafen &amp; Bad" (dss-mainline
 * src/util.cpp escapeHTML(), src/web/handler/circuitrequesthandler.cpp setName). A name
 * stored back then stays that way until it is set again, also with current firmware. One
 * pass on purpose: escapeHTML() replaced "&" first, so "&amp;lt;" was a literal "&lt;" and
 * has to stay one. "&#39;" is accepted as the short spelling of the same apostrophe.
 *
 * @param {string} text name as the dSS stored it
 * @returns {string} the name as it was typed in the dSS
 */
function decodeDssEntities(text) {
    /** @type {Record<string, string>} */
    const entities = { amp: '&', quot: '"', '#039': "'", '#39': "'", lt: '<', gt: '>' };
    return text.replace(/&(amp|quot|#0?39|lt|gt);/g, (match, entity) => entities[entity]);
}

class DSSStructure {
    constructor(options) {
        this.options = options || {};
        this.dss = options.dss;
        this.adapter = options.adapter;
        this.dssQueue = options.dssQueue;
        // Client der neuen API, null wenn die Option aus ist. Wird fuer die Zaehler und
        // die Output-Werte benutzt - alles andere laeuft weiter ueber die klassische API.
        this.smartHome = options.smartHome || null;
        // Buendelt Output-Reads zu EINER Statusabfrage der neuen API. Ohne Client null,
        // dann laufen alle Reads unveraendert klassisch.
        this.smartHomeSync = this.smartHome
            ? new SmartHomeOutputSync({
                  structure: this,
                  smartHome: this.smartHome,
                  adapter: options.adapter,
                  ...(options.smartHomeSyncOptions || {}),
              })
            : null;
        // A failed optional API must not add another failed request to every classic poll.
        // Retries use the normal polling cycle, so no additional timer is needed.
        this.smartHomeMeterFailures = 0;
        this.smartHomeMeterRetryAfter = 0;
        this.smartHomeMeterRetryBase = options.smartHomeMeterRetryBase || SMART_HOME_METER_RETRY_BASE;
        this.smartHomeMeterRetryMax = options.smartHomeMeterRetryMax || SMART_HOME_METER_RETRY_MAX;
        this.now = options.now || Date.now;
        /** @type {'classic'|'smarthome'|null} zuletzt gemeldeter Weg, verhindert Wiederholungen */
        this.lastMeteringApi = null;
        /** @type {'classic'|'smarthome'|null} dito fuer die Output-Werte (info.outputApi) */
        this.lastOutputApi = null;

        this.stateMap = {};
        this.dssObjects = {};
        this.initialObjectValues = {};
        this.processedZones = {};
        this.zoneDevices = {};
        this.initialScenes = {};
        /** @type {Record<string, any>} jedes gueltige Geraet, fuer den Abgleich per Notification */
        this.devicesByDsuid = {};
        /** @type {Record<string, string>} "zone.group.scene" -> vom Nutzer vergebener Szenenname (neue API) */
        this.scenarioNames = {};
        /** @type {Record<string, string>} Zonen-Id (als String) -> State-Praefix der Zonen-Sensoren */
        this.zoneSensorBaseIds = {};
        // -Infinity statt 0: der allererste Abgleich darf nie an der Ratenbremse haengen
        this.lastOutputReconcileAt = -Infinity;
        this.outputReconcileMinInterval = options.outputReconcileMinInterval || OUTPUT_RECONCILE_MIN_INTERVAL;

        this.apartmentStructure = null;
        this.apartmentCircuits = null;
        this.sensorValues = null;
        this.temperatureControlStatus = null;
        this.propertyUserStates = null;
        this.propertyStates = null;
        this.userActions = null;
        this.reachableGroups = null;
        // Private copy per structure instance: apartment specific cluster names are merged
        // into this map (see parseData). Using the shared constants object directly would
        // leak the cluster names of one apartment into every other adapter instance of the
        // same compact process - and would permanently modify the module constants.
        this.groupTypes = { ...dssConstants.groupTypes };

        this.basicRoomScenes = [
            0, 5, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
        ];

        // Devices/channels whose output value could not be read - reported only once
        this.reportedOutputReadErrors = new Set();
        // The value last published to ioBroker per state id. Only the polling and
        // reconciling paths consult it (setStateSafe with skipUnchanged): they re-assert
        // a value the dSS still reports, which on a real installation was 7661 of 11015
        // writes in three hours. An event-driven value is never suppressed - "the dSS
        // reported this now" is a message even when the number repeats - and neither is
        // the confirmation of a user command, which has to reach its ack.
        /** @type {Map<string, any>} */
        this.publishedValues = new Map();
        /** @type {Set<string>} vDC devices the dSS rejected for the named channel read */
        this.vdcChannelReadRejected = new Set();
        /** @type {Map<string, {report: boolean}>} devices with a named channel read in flight - one answer serves all channels */
        this.vdcChannelReadPending = new Map();
        /** @type {Set<string>} devices whose outputs are re-read after a scene, registered once */
        this.sceneRefreshDevices = new Set();
        /**
         * The apartment user states, by ioBroker id: their name in the dSS and the value
         * it holds as far as the adapter knows. Kept current from both directions - what
         * is written to the dSS and what the dSS reports back - so a write that would
         * change nothing there can be skipped.
         *
         * @type {Map<string, {name: string, value: any}>}
         */
        this.userStates = new Map();
        // Prefixes of zones and groups THIS adapter decided not to build objects for -
        // a zone the dSS reports as not present, a group no zone can reach, a zone 0
        // group without devices. Their states have no object by our own choice, so they
        // are not "unassignable" and must not be reported as such.
        /** @type {Set<string>} */
        this.skippedStatePrefixes = new Set();
        // Names of the property states that were claimed by a device, circuit, zone, group
        // or the apartment. Everything left over is reported by reportUnmappedStates().
        /** @type {Set<string>} */
        this.matchedPropertyStates = new Set();
        /**
         * The sensor states of dSS apps other than the user-defined states, read from
         * /usr/addon-states at startup - see readAddonSensorStates().
         *
         * @type {Array<{name: string, addon: string, zoneId: number, groupId: number, sensorType: number, identifier: string, state?: any, value?: any}>}
         */
        this.addonSensorStates = [];
        // true once readAddonSensorStates() got an answer - only then is a room sensor state
        // that is not in it really gone, see createZoneSensorStates()
        this.addonSensorStatesRead = false;
        this.pendingTimeouts = new Set();
        // becomes true once all ioBroker objects have been created
        this.objectsReady = false;
    }

    setClearableTimeout(func, delay) {
        const timeout = setTimeout(() => {
            this.pendingTimeouts.delete(timeout);
            func();
        }, delay);
        this.pendingTimeouts.add(timeout);
        return timeout;
    }

    clearTimeouts() {
        this.pendingTimeouts.forEach(timeout => clearTimeout(timeout));
        this.pendingTimeouts.clear();
        this.smartHomeSync && this.smartHomeSync.stop();
    }

    /**
     * One classic output read, written back exactly like the original inline callbacks:
     * the brightness of a light goes through the light helper (it also maintains the
     * boolean .state including the switch threshold), everything else lands rounded in
     * the channel state. Channels without a fixed channelIndex have no classic read.
     *
     * options.report = false keeps info.outputApi untouched: reads the Smart Home sync
     * hands over for single channels the status cannot deliver must not flip the state
     * to "classic" while the Smart Home API stays in charge of everything else.
     *
     * @param {StructureDevice} dev
     * @param {string} outputType
     * @param {'high'|'medium'|'low'} [prio]
     * @param {{report?: boolean}} [options]
     */
    queueClassicOutputRead(dev, outputType, prio = 'medium', options = {}) {
        const report = options.report !== false;
        // A vDC device (Hue, Sonos, ...) answers ONLY the named channel read. Its
        // outputs have no offset the dSS could address - getOutputValue returns
        // "Could not find item. deviceOutputIndex:255" no matter which channelIndex
        // the role map declares, so this comes BEFORE the offset path.
        if (this.queueVdcChannelRead(dev, outputType, prio, report)) {
            return;
        }
        const roleDef = dssConstants.outputChannelUnitRoleMap[outputType];
        if (!roleDef || !roleDef.native || roleDef.native.channelIndex === undefined) {
            // Channels without a fixed channelIndex never had a working offset read:
            // getOutputValue needs the offset, and the getConfig fallback reads the
            // class 64 bank, which only holds the shade values
            this.adapter.log.debug(`No classic read for output channel ${outputType} of ${dev.dSUID}`);
            return;
        }
        this.dssQueue.queueUpdateOutputValue(
            dev,
            roleDef.native.channelIndex,
            roleDef.native.nativeMax,
            prio,
            (err, value) => {
                if (err) {
                    this.logOutputReadError(dev, outputType, err);
                    return;
                }
                if (outputType === 'brightness' && typeof dev.applyNativeLightValue === 'function') {
                    dev.applyNativeLightValue(value, { skipUnchanged: true });
                    report && this.reportOutputApi('classic');
                    return;
                }
                if (roleDef.native.nativeMax && roleDef.max) {
                    value = Math.round((value * roleDef.max) / roleDef.native.nativeMax);
                }
                const stateId = dev.outputChannelList && dev.outputChannelList[outputType];
                if (!stateId) {
                    return;
                }
                this.setStateSafe(stateId, value, { skipUnchanged: true });
                this.initialObjectValues[stateId] = value;
                report && this.reportOutputApi('classic');
            },
        );
    }

    /**
     * Named channel read for a vDC device: device/getOutputChannelValue2 answers with
     * EVERY channel of the device in the official channel scale. Native dS terminals
     * are filtered by the structure flag, and a dSS that still rejects the call
     * ("This call is currently only supported on vDCs") is remembered per device.
     *
     * @param {StructureDevice} dev
     * @param {string} outputType the channel that asked - the answer serves all of them
     * @param {'high'|'medium'|'low'} prio
     * @param {boolean} report whether a successful read may flip info.outputApi
     * @returns {boolean} true when a read serves this channel (queued now or in flight)
     */
    queueVdcChannelRead(dev, outputType, prio, report) {
        if (!dev || dev.isVdcDevice !== true || this.vdcChannelReadRejected.has(dev.dSUID)) {
            return false;
        }
        const pending = this.vdcChannelReadPending.get(dev.dSUID);
        if (pending) {
            // One answer carries every channel - the running read serves this one too.
            // Its answer may predate this trigger by the request duration; the next
            // trigger refreshes, the same bound every offset read has always had.
            // A joiner that is allowed to report upgrades the running read.
            pending.report = pending.report || report;
            return true;
        }
        const flags = { report };
        this.vdcChannelReadPending.set(dev.dSUID, flags);
        this.dssQueue.queueReadOutputChannels(dev, prio, (err, channels) => {
            this.vdcChannelReadPending.delete(dev.dSUID);
            if (this.isAdapterStopping()) {
                return;
            }
            if (err) {
                // requestAsync delivers an ok:false answer as a thrown DSSError -
                // the rejection text sits in its message
                const message = (err && err.message) || String(err);
                if (message.includes('only supported on vDCs')) {
                    this.vdcChannelReadRejected.add(dev.dSUID);
                    this.adapter.log.debug(`No named channel read for ${dev.dSUID}: ${message}`);
                } else {
                    this.logOutputReadError(dev, outputType, err);
                }
                return;
            }
            let applied = 0;
            for (const [channel, entry] of Object.entries(channels)) {
                if (!dev.outputChannelList || !dev.outputChannelList[channel]) {
                    continue;
                }
                if (!entry || typeof entry.value !== 'number' || !isFinite(entry.value)) {
                    continue;
                }
                if (this.applyChannelScaleValue(dev, channel, entry.value) === 'applied') {
                    applied++;
                }
            }
            applied && flags.report && this.reportOutputApi('classic');
        });
        return true;
    }

    /**
     * Re-reads the outputs of a device after every scene, through the bundled status
     * request - a whole room coalesces into ONE read. For device types without a read
     * path of their own (jokers, and everything the type dispatch leaves generic) this
     * is the only way their values follow a scene instead of waiting for the next
     * reconciliation. Without the sync nothing is registered: one named read per device
     * would be a burst, and that is what the reconciliation is there for.
     *
     * Registered once per device - createJokerDevice can be reached from two paths.
     *
     * @param {StructureDevice} dev
     */
    registerSceneOutputRefresh(dev) {
        if (!this.adapter.config.initializeOutputValues || !this.smartHomeSync) {
            return;
        }
        if (!dev.outputChannelList || !Object.keys(dev.outputChannelList).length) {
            return;
        }
        if (this.sceneRefreshDevices.has(dev.dSUID) || !this.dss || typeof this.dss.on !== 'function') {
            return;
        }
        const sync = this.smartHomeSync;
        this.sceneRefreshDevices.add(dev.dSUID);
        this.dss.on(dev.dSUID, data => {
            if (data.name === 'callScene' || data.name === 'undoScene') {
                sync.requestDeviceSync(dev);
            }
        });
    }

    /**
     * Initial read for a device the type dispatch left generic - that is vDC hardware
     * (Hue, Sonos) and a few exotic terminals, which have no typed create*Device path
     * of their own and therefore never read their outputs at all.
     *
     * One bundled status request of the Smart Home API covers every channel of every
     * device; without it a vDC device is served by its named channel read, which also
     * carries all of its channels at once. A native terminal gets false here and keeps
     * the offset read it always had.
     *
     * @param {StructureDevice} dev
     * @param {string} outputType any channel of the device - both reads cover all of them
     * @returns {boolean} true when a read is on its way
     */
    queueGenericInitialRead(dev, outputType) {
        // ONLY a vDC device may hand its initial read over. A native terminal in this
        // branch has no second way in: its channels have no fixed channelIndex, the
        // caller below reads them through the channelIndex the DEVICE declares, and
        // every fallback of the sync goes through queueClassicOutputRead, which gives
        // up exactly there. Handing it over would lose the value silently.
        if (dev.isVdcDevice !== true) {
            return false;
        }
        if (this.smartHomeSync && this.smartHomeSync.requestDeviceSync(dev)) {
            return true;
        }
        return this.queueVdcChannelRead(dev, outputType, 'medium', true);
    }

    /**
     * Writes one output value that already comes in the official channel scale
     * (brightness 0..100, colortemp 100..1000, ...) - the scale of the Smart Home
     * API status AND of device/getOutputChannelValue2. Counterpart of the
     * native-scale write in the queueClassicOutputRead callback; the same rules as
     * SmartHomeOutputSync.applyValue (kept separate there for its own test rig).
     *
     * @param {any} dev
     * @param {string} outputType
     * @param {number} value
     * @returns {'applied'|'unsupported'}
     */
    applyChannelScaleValue(dev, outputType, value) {
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
            // Boolean channel semantics are not verified against the channel scale
            return 'unsupported';
        }
        if (outputType === 'x' || outputType === 'y') {
            // CIE x/y arrive as 0..1 in the channel scale (measured live: 0.225/0.3944),
            // the states hold 0..10000 (max 10000 / nativeMax 65535) - the same factor
            // the offset read applies as value*max/nativeMax. Without it Math.round
            // would collapse every coordinate to 0 or 1.
            value *= 10000;
        }
        const rounded = Math.round(value);
        this.setStateSafe(stateId, rounded, { skipUnchanged: true });
        this.initialObjectValues[stateId] = rounded;
        return 'applied';
    }

    /**
     * Uebernimmt Sollwert und Stellgroesse der Raumtemperaturregelung aus einer
     * Apartment-Status-Antwort - derselben Antwort, die ohnehin fuer die Output-Werte
     * geholt wurde, es entsteht kein zusaetzlicher Request. Modus und Betriebsart
     * bleiben beim klassischen Weg: ihre Zahlensemantik ist gegen die neue API nicht
     * verifiziert, Grad Celsius und Prozent dagegen schon (gegen echte Anlage geprueft).
     *
     * @param {any} status Antwort von getApartmentStatus()
     * @returns {number} Anzahl geschriebener Werte
     */
    applyZoneTemperatureStatus(status) {
        const zones = (status && status.included && status.included.zones) || [];
        let written = 0;
        for (const zone of zones) {
            const baseId = zone && this.zoneSensorBaseIds[String(zone.id)];
            if (!baseId) {
                continue;
            }
            const applications = (zone.attributes && zone.attributes.applications) || [];
            const temperature = applications.find(app => app && app.id === 'temperature');
            if (!temperature) {
                continue;
            }
            for (const [field, stateName] of [
                ['setpoint', 'NominalValue'],
                ['controlValue', 'ControlValue'],
            ]) {
                const value = temperature[field];
                const stateId = `${baseId}.${stateName}`;
                if (typeof value !== 'number' || !isFinite(value) || !this.dssObjects[stateId]) {
                    continue;
                }
                // Counted only when it really went out: with the comparison in front of
                // setStateSafe the old unconditional count reported attempts, not writes
                if (this.setStateSafe(stateId, value, { skipUnchanged: true })) {
                    written++;
                }
            }
        }
        return written;
    }

    /**
     * Die Reaktion auf eine apartmentStatusChanged-Meldung des Websockets: alle
     * Geraete mit Ausgaengen einmal ueber den Sync abgleichen. Hart ratenbegrenzt,
     * siehe OUTPUT_RECONCILE_MIN_INTERVAL.
     *
     * @returns {boolean} true wenn ein Abgleich angestossen wurde
     */
    reconcileOutputValues() {
        if (!this.smartHomeSync || !this.adapter.config || !this.adapter.config.initializeOutputValues) {
            return false;
        }
        if (this.now() - this.lastOutputReconcileAt < this.outputReconcileMinInterval) {
            return false;
        }
        let requested = false;
        for (const dev of Object.values(this.devicesByDsuid)) {
            if (dev.outputChannelList && Object.keys(dev.outputChannelList).length) {
                requested = this.smartHomeSync.requestDeviceSync(dev) || requested;
            }
        }
        if (requested) {
            this.lastOutputReconcileAt = this.now();
        }
        return requested;
    }

    /**
     * Records which API delivered the last output values - the counterpart of
     * reportMeteringApi() for info.outputApi, with the same "last successful
     * writer" semantics and the same change-only reporting.
     *
     * @param {'classic'|'smarthome'} api
     */
    reportOutputApi(api) {
        if (this.lastOutputApi === api) {
            return;
        }
        this.lastOutputApi = api;
        this.adapter.setState && this.adapter.setState('info.outputApi', api, true);
        this.adapter.log.info(
            `Output values are now read via the ${api === 'smarthome' ? 'Smart Home' : 'classic'} API`,
        );
    }

    init(callback) {
        // Die Klarnamen der Szenen kennt nur die neue API - einmalig am Start geholt,
        // bevor die Zonen verarbeitet werden. Ohne sie bleiben die bisherigen Namen.
        this.loadScenarioNames(() => this.initClassicStructure(callback));
    }

    /**
     * Laedt die vom Nutzer in digitalSTROM vergebenen Szenennamen ueber die neue API.
     * Jeder Fehler ist folgenlos: die Benennung faellt auf die klassischen
     * userSceneNames und die generischen Preset-Namen zurueck.
     *
     * @param {() => void} callback laeuft immer, auch bei Fehlern
     */
    loadScenarioNames(callback) {
        if (!this.smartHome || this.isAdapterStopping()) {
            return void callback();
        }
        this.smartHome.getScenarios().then(
            answer => {
                const scenarios = (answer && answer.scenarios) || [];
                let named = 0;
                for (const scenario of scenarios) {
                    const match =
                        scenario && typeof scenario.id === 'string'
                            ? scenario.id.match(/^applicationZone-z(\d+)-g(\d+)-s(\d+)$/)
                            : null;
                    const name = scenario && scenario.attributes && scenario.attributes.name;
                    if (!match || typeof name !== 'string' || !name.trim()) {
                        continue;
                    }
                    this.scenarioNames[`${match[1]}.${match[2]}.${match[3]}`] = name.trim();
                    named++;
                }
                named && this.adapter.log.debug(`Loaded ${named} scene names from the Smart Home API`);
                callback();
            },
            err => {
                this.adapter.log.debug(`Could not load the scene names from the Smart Home API: ${errorMessage(err)}`);
                callback();
            },
        );
    }

    initClassicStructure(callback) {
        this.dss.requestAsync('apartment', 'getStructure').then(
            res => {
                if (!res || !res.ok || !res.result || !res.result.apartment) {
                    return void (
                        callback &&
                        setImmediate(() =>
                            callback(`Error on apartment/getStructure: ${res.message || res.status_code || res}`),
                        )
                    );
                }
                this.apartmentStructure = res.result.apartment;
                this.adapter.log.debug(`getStructure:${JSON.stringify(this.apartmentStructure)}`);

                this.dss.requestAsync('apartment', 'getCircuits').then(
                    res => {
                        if (!res || !res.ok || !res.result || !res.result.circuits) {
                            return void (
                                callback &&
                                callback(`Error on apartment/getCircuits: ${res.message || res.status_code || res}`)
                            );
                        }
                        this.apartmentCircuits = res.result.circuits;
                        this.adapter.log.debug(`getCircuits:${JSON.stringify(this.apartmentCircuits)}`);

                        this.dss.requestAsync('apartment', 'getSensorValues').then(
                            res => {
                                if (!res || !res.ok || !res.result) {
                                    return void (
                                        callback &&
                                        callback(
                                            `Error on apartment/getSensorValues: ${
                                                res.message || res.status_code || res
                                            }`,
                                        )
                                    );
                                }
                                this.sensorValues = res.result;
                                this.adapter.log.debug(`getSensorValues: ${JSON.stringify(this.sensorValues)}`);

                                this.dss.requestAsync('apartment', 'getTemperatureControlStatus').then(
                                    res => {
                                        if (!res || !res.ok || !res.result) {
                                            return void (
                                                callback &&
                                                callback(
                                                    `Error on apartment/getTemperatureControlStatus: ${
                                                        res.message || res.status_code || res
                                                    }`,
                                                )
                                            );
                                        }
                                        this.temperatureControlStatus = res.result;
                                        this.adapter.log.debug(
                                            `getTemperatureControlStatus: ${JSON.stringify(
                                                this.temperatureControlStatus,
                                            )}`,
                                        );

                                        this.dss
                                            .requestAsync('property', 'query', {
                                                query: '/usr/addon-states/system-addon-user-defined-states/*(*)',
                                            })
                                            .then(
                                                res => {
                                                    if (!res || !res.ok || !res.result) {
                                                        return void (
                                                            callback &&
                                                            callback(
                                                                `Error on query user-defined-states: ${
                                                                    res.message || res.status_code || res
                                                                }`,
                                                            )
                                                        );
                                                    }
                                                    this.propertyUserStates = Array.isArray(
                                                        res.result['system-addon-user-defined-states'],
                                                    )
                                                        ? res.result['system-addon-user-defined-states']
                                                        : [];
                                                    this.adapter.log.debug(
                                                        `property user states: ${JSON.stringify(
                                                            this.propertyUserStates,
                                                        )}`,
                                                    );

                                                    this.dss
                                                        .requestAsync('property', 'query', {
                                                            query: '/usr/states/*(*)',
                                                        })
                                                        .then(
                                                            res => {
                                                                if (!res || !res.ok || !res.result) {
                                                                    return void (
                                                                        callback &&
                                                                        callback(
                                                                            `Error on query states: ${
                                                                                res.message || res.status_code || res
                                                                            }`,
                                                                        )
                                                                    );
                                                                }
                                                                this.propertyStates = Array.isArray(res.result.states)
                                                                    ? res.result.states
                                                                    : [];
                                                                this.adapter.log.debug(
                                                                    `property states: ${JSON.stringify(
                                                                        this.propertyStates,
                                                                    )}`,
                                                                );

                                                                this.dss
                                                                    .requestAsync('property', 'query', {
                                                                        query: '/usr/events/*(*)/*(*)/*(*)/*(*)/*(*)',
                                                                    })
                                                                    .then(
                                                                        res => {
                                                                            if (!res || !res.ok || !res.result) {
                                                                                return void (
                                                                                    callback &&
                                                                                    callback(
                                                                                        `Error on query user actions: ${
                                                                                            res.message ||
                                                                                            res.status_code ||
                                                                                            res
                                                                                        }`,
                                                                                    )
                                                                                );
                                                                            }
                                                                            this.userActions = Array.isArray(
                                                                                res.result.events,
                                                                            )
                                                                                ? res.result.events
                                                                                : [];
                                                                            this.adapter.log.debug(
                                                                                `property user actions: ${JSON.stringify(
                                                                                    this.userActions,
                                                                                )}`,
                                                                            );

                                                                            this.dss
                                                                                .requestAsync(
                                                                                    'apartment',
                                                                                    'getReachableGroups',
                                                                                    { id: 0 },
                                                                                )
                                                                                .then(
                                                                                    res => {
                                                                                        if (
                                                                                            !res ||
                                                                                            !res.ok ||
                                                                                            !res.result
                                                                                        ) {
                                                                                            return void (
                                                                                                callback &&
                                                                                                callback(
                                                                                                    `Error on apartment/getReachableGroups: ${
                                                                                                        res.message ||
                                                                                                        res.status_code ||
                                                                                                        res
                                                                                                    }`,
                                                                                                )
                                                                                            );
                                                                                        }
                                                                                        this.reachableGroups =
                                                                                            res.result;
                                                                                        this.adapter.log.debug(
                                                                                            `getReachableGroups: ${JSON.stringify(
                                                                                                this.reachableGroups,
                                                                                            )}`,
                                                                                        );

                                                                                        // Optional, it never fails the start
                                                                                        this.readAddonSensorStates().then(
                                                                                            () =>
                                                                                                this.parseData(
                                                                                                    callback,
                                                                                                ),
                                                                                        );
                                                                                    },
                                                                                    err => {
                                                                                        return void (
                                                                                            callback &&
                                                                                            callback(
                                                                                                `Error on apartment/getReachableGroups: ${
                                                                                                    (err &&
                                                                                                        err.message) ||
                                                                                                    JSON.stringify(err)
                                                                                                }`,
                                                                                            )
                                                                                        );
                                                                                    },
                                                                                );
                                                                        },
                                                                        err => {
                                                                            return void (
                                                                                callback &&
                                                                                callback(
                                                                                    `Error on apartment/getReachableGroups: ${
                                                                                        (err && err.message) ||
                                                                                        JSON.stringify(err)
                                                                                    }`,
                                                                                )
                                                                            );
                                                                        },
                                                                    );
                                                            },
                                                            err => {
                                                                return void (
                                                                    callback &&
                                                                    callback(
                                                                        `Error on query states: ${
                                                                            (err && err.message) || JSON.stringify(err)
                                                                        }`,
                                                                    )
                                                                );
                                                            },
                                                        );
                                                },
                                                err => {
                                                    return void (
                                                        callback &&
                                                        callback(
                                                            `Error on query user-defined-states: ${
                                                                (err && err.message) || JSON.stringify(err)
                                                            }`,
                                                        )
                                                    );
                                                },
                                            );
                                    },
                                    err => {
                                        return void (
                                            callback &&
                                            callback(
                                                `Error on apartment/getTemperatureControlStatus: ${
                                                    (err && err.message) || JSON.stringify(err)
                                                }`,
                                            )
                                        );
                                    },
                                );
                            },
                            err => {
                                return void (
                                    callback &&
                                    callback(
                                        `Error on apartment/getSensorValues: ${
                                            (err && err.message) || JSON.stringify(err)
                                        }`,
                                    )
                                );
                            },
                        );
                    },
                    err => {
                        return void (
                            callback &&
                            callback(`Error on apartment/getCircuits: ${(err && err.message) || JSON.stringify(err)}`)
                        );
                    },
                );
            },
            err => {
                return void (
                    callback &&
                    callback(`Error on apartment/getStructure: ${(err && err.message) || JSON.stringify(err)}`)
                );
            },
        );
    }

    convertObject(data, nameField, prefilled) {
        const res = prefilled || {};
        if (!data || !Array.isArray(data)) {
            return res;
        }
        data.forEach(el => {
            if (typeof el !== 'object' || el[nameField] === undefined) {
                return;
            }
            res[el[nameField]] = el;
        });
        return res;
    }

    parseData(callback) {
        const apt = {
            clusters: this.convertObject(this.apartmentStructure.clusters, 'id'),
            floors: this.convertObject(this.apartmentStructure.floors, 'id'),
            zones: this.convertObject(this.apartmentStructure.zones, 'id'),
        };
        Object.keys(apt.clusters).forEach(groupId => {
            if (!this.groupTypes[groupId]) {
                this.groupTypes[groupId] = apt.clusters[groupId].name;
            }
        });
        if (apt.zones[0]) {
            apt.zone0 = apt.zones[0]; // Zone 0 contains everything
            delete apt.zones[0];
        } else {
            return void (callback && setImmediate(() => callback('No devices returned in Zone 0')));
        }
        apt.groups = this.convertObject(apt.zone0.groups, 'id'); // enhance groups from zone 0

        this.createUserActions();

        this.createDevices(apt.zone0.devices, () => {
            const reachableZoneGroups = this.convertObject(this.reachableGroups.zones, 'zoneID');
            this.sensorValues.zones = this.convertObject(this.sensorValues.zones, 'id');
            this.temperatureControlStatus.zones = this.convertObject(this.temperatureControlStatus.zones, 'id');
            this.createApartment(apt, reachableZoneGroups, () => {
                this.reportUnmappedStates(apt.zone0.devices);
                callback && callback(null);
            });
        });
    }

    /**
     * Reads the sensor states that dSS apps keep per room.
     *
     * The climate control keeps zone.zone<id>.group0.type9.passiveCooling for a room it
     * regulates: active while the room is above its passive cooling threshold. The dSS
     * publishes such states under /usr/addon-states/<app>/ and reports their changes as a
     * plain stateChange, so they are neither in /usr/states nor among the user-defined
     * states. A room that stays on one side of its threshold sends no event for weeks,
     * so the value has to be read at startup. One property/query2 answers
     * {<app>: {<state name>: {name, value, state, callOrigin}}} (dss-mainline
     * src/propertyquery.cpp runFor2).
     *
     * Optional: a dSS without that node or without query2 only leaves the list empty. It
     * never throws and never fails the start.
     *
     * @returns {Promise<void>}
     */
    async readAddonSensorStates() {
        try {
            const res = await this.dss.requestAsync('property', 'query2', {
                query: '/usr/addon-states/*(*)/*(*)',
            });
            if (!res || !res.ok || !res.result || typeof res.result !== 'object') {
                this.adapter.log.debug(
                    `No sensor states of dSS apps: ${(res && (res.message || res.status_code)) || JSON.stringify(res)}`,
                );
                return;
            }
            this.addonSensorStates = DSSStructure.collectAddonSensorStates(res.result);
            this.addonSensorStatesRead = true;
            this.adapter.log.debug(`sensor states of dSS apps: ${JSON.stringify(this.addonSensorStates)}`);
        } catch (err) {
            this.adapter.log.debug(`Could not read the sensor states of dSS apps: ${errorMessage(err)}`);
        }
    }

    /**
     * The room sensor states in a property/query2 answer of /usr/addon-states.
     *
     * The user-defined states are left out, they already are apartment.userStates. So is
     * everything not named like a room sensor state: helper states such as
     * "<dSUID>_open-tilded" have no object on purpose, and the sensor states of a device
     * are named once when they change, like every other state without an object.
     *
     * @param {Record<string, any>|null|undefined} tree answer of the query, keyed by app and
     *   state name
     * @returns {Array<{name: string, addon: string, zoneId: number, groupId: number, sensorType: number, identifier: string, state?: any, value?: any}>}
     */
    static collectAddonSensorStates(tree) {
        const result = [];
        if (!tree || typeof tree !== 'object') {
            return result;
        }
        // A dSS20 1.19.13 lists its climate control twice, as system-addon-heating-controller
        // and as heating-controller, with the very same states (measured with probe-states.js).
        // A state name is unique in the dSS - an event carries nothing else - so the first
        // entry wins. A second one would become a second object, "<identifier>_type9", and
        // take the events away from the first.
        const seen = new Set();
        Object.keys(tree).forEach(addon => {
            const states = tree[addon];
            if (addon === 'system-addon-user-defined-states' || !states || typeof states !== 'object') {
                return;
            }
            Object.keys(states).forEach(key => {
                const entry = states[key];
                if (!entry || typeof entry !== 'object') {
                    return;
                }
                const name = typeof entry.name === 'string' && entry.name ? entry.name : key;
                const match = ZONE_SENSOR_STATE.exec(name);
                if (!match || seen.has(name)) {
                    return;
                }
                seen.add(name);
                result.push({
                    ...entry,
                    name,
                    addon,
                    zoneId: parseInt(match[1], 10),
                    groupId: parseInt(match[2], 10),
                    sensorType: parseInt(match[3], 10),
                    identifier: match[4],
                });
            });
        });
        return result;
    }

    /**
     * Reports property states that no part of the structure claimed.
     *
     * The DSS delivers all user states of `/usr/states` in one list. They are assigned by
     * their name prefix: `dev.<dSUID>.` to a device, `dsm.<dSUID>.` to a circuit,
     * `zone.<id>.` to a room, `zone.<id>.group.<id>.` to a group, everything without a dot
     * to the apartment. A state whose prefix belongs to none of them - for example a
     * sensor that is bound to a device the DSS does not list in the apartment structure -
     * would silently have no object at all.
     *
     * Reported once at info level with the exact names, so such a state can be assigned
     * afterwards instead of just being missing. The coupled input of a 2-way button is
     * not missing, the dSS hides it on purpose; it is named on debug with its device.
     * A room sensor state of a dSS app that got no object is named in the same line.
     *
     * @param {any[]} [structureDevices] all devices of zone 0, including the ones this
     *   adapter skipped - the partner of a 2-way button is recognised by its neighbour
     */
    reportUnmappedStates(structureDevices) {
        if (!Array.isArray(this.propertyStates)) {
            return;
        }
        const leftOver = this.propertyStates
            .filter(state => state && typeof state.name === 'string' && !this.matchedPropertyStates.has(state.name))
            .map(state => state.name);
        const skippedPrefixes = [...this.skippedStatePrefixes];
        const notSkipped = leftOver.filter(name => !skippedPrefixes.some(prefix => name.startsWith(prefix)));
        // The sensor states of dSS apps (see readAddonSensorStates) get an object only in
        // group 0 of a room this adapter built. Their names spell zone and group
        // differently ("zone.zone4.group48."), so a skipped zone or group is compared by id.
        const addonLeftOver = this.addonSensorStates.filter(state => !this.matchedPropertyStates.has(state.name));
        const addonNotSkipped = addonLeftOver.filter(
            state =>
                !this.skippedStatePrefixes.has(`zone.${state.zoneId}.`) &&
                !this.skippedStatePrefixes.has(`zone.${state.zoneId}.group.${state.groupId}.`),
        );
        const skipped = leftOver.length - notSkipped.length + addonLeftOver.length - addonNotSkipped.length;
        if (skipped) {
            // Worth a line, but not one that asks anybody to open an issue: on a real
            // installation 42 of 45 leftovers were of this kind and buried the three
            // names that really belonged to nobody.
            this.adapter.log.debug(
                `${skipped} DSS state(s) belong to zones or groups this adapter skipped on purpose and are not reported`,
            );
        }
        /** @type {Map<string, any>} */
        const devicesByDsuid = new Map();
        (Array.isArray(structureDevices) ? structureDevices : []).forEach(dev => {
            dev && typeof dev.dSUID === 'string' && devicesByDsuid.set(dev.dSUID, dev);
        });
        // Those three names turned out not to belong to nobody either: each was the
        // second input of a GR-KL300 whose push buttons are wired as a 2-way switch. The
        // dSS couples that input to the first one and hides it from getStructure, while
        // the binary input state of its alternative use (a 230 V sensor) stays in
        // /usr/states. There is nothing to map - wired as a 2-way switch that input is a
        // push button, not a sensor - so it is named on debug, with its device.
        const hiddenPartners = [];
        const unmapped = [];
        notSkipped.forEach(name => {
            const master = DSSStructure.twoWayMasterOf(name, devicesByDsuid);
            if (master) {
                const hwInfo = master.hwInfo ? `, ${master.hwInfo}` : '';
                hiddenPartners.push(`${name} (2nd input of "${master.name || master.dSUID}"${hwInfo})`);
            } else {
                unmapped.push(name);
            }
        });
        if (hiddenPartners.length) {
            this.adapter.log.debug(
                `${hiddenPartners.length} DSS state(s) belong to the coupled input of a 2-way button, ` +
                    `which the dSS does not list as a device, and have no object: ${hiddenPartners.join(', ')}`,
            );
        }
        addonNotSkipped.forEach(state => unmapped.push(state.name));
        if (!unmapped.length) {
            return;
        }
        this.adapter.log.info(
            `${unmapped.length} DSS state(s) could not be assigned to a device, circuit, room, group or the apartment ` +
                `and therefore have no object: ${JSON.stringify(unmapped)}. ` +
                'Please report these names in a GitHub issue so they can be mapped.',
        );
    }

    /**
     * The device whose hidden 2-way partner owns a `dev.<dSUID>.` state, if that is what
     * the state is. Only with positive evidence from the structure, never by the shape of
     * the name alone: the dSUID itself must be missing from the structure, the one a dSID
     * below must be a dS device (no vDC) and that device must be a 2-way master by its
     * own buttonInputMode - exactly the pair the dSS hides.
     *
     * @param {string} stateName
     * @param {Map<string, any>} devicesByDsuid all devices of the apartment structure
     * @returns {any|undefined} the master device of the pair
     */
    static twoWayMasterOf(stateName, devicesByDsuid) {
        const match = /^dev\.([0-9a-f]{34})\./.exec(stateName);
        if (!match || devicesByDsuid.has(match[1])) {
            return undefined;
        }
        const previous = previousDsidDsuid(match[1]);
        const master = previous && devicesByDsuid.get(previous);
        if (!master || master.isVdcDevice) {
            return undefined;
        }
        const mode = master.buttonInputMode;
        if (TWO_WAY_MASTER_BUTTON_MODES.has(mode)) {
            return master;
        }
        if (TWO_WAY_MASTER_BUTTON_MODES_EVEN_DSID.has(mode) && parseInt(master.dSUID.slice(24, 32), 16) % 2 === 0) {
            return master;
        }
        return undefined;
    }

    findStates(checkRegEx) {
        const regEx = new RegExp(checkRegEx);
        const res = [];
        if (!Array.isArray(this.propertyStates)) {
            return res;
        }
        this.propertyStates.forEach(state => {
            if (!state || typeof state.name !== 'string') {
                return;
            }
            const match = state.name.match(regEx);
            if (!match) {
                return;
            }
            if (match && match[1]) {
                state.matchedName = match[1];
            }
            this.matchedPropertyStates.add(state.name);
            res.push(state);
        });
        return res;
    }

    /**
     * Liest die Zaehlerwerte ueber die neue API - EIN Request fuer alle Klemmen.
     *
     * Die alte API braucht dafuer zwei Requests je Klemme. Einheit und Zaehlerstand sind
     * nachweislich identisch (gegen einen dSS 1.19.13 verglichen: fuenf von sechs Klemmen
     * auf die Wattsekunde gleich, die sechste um genau den Zeitversatz daneben), die
     * Umrechnung bleibt deshalb dieselbe wie im klassischen Weg.
     *
     * @returns {Promise<{attempted: boolean, succeeded: boolean, missingCircuits: object[]}>}
     */
    async updateMeterDataViaSmartHome() {
        const meteredCircuits = (this.apartmentCircuits || []).filter(circuit => circuit.hasMetering);
        if (!meteredCircuits.length || this.isAdapterStopping()) {
            return { attempted: false, succeeded: true, missingCircuits: [] };
        }
        if (!this.smartHome) {
            return { attempted: false, succeeded: false, missingCircuits: meteredCircuits };
        }
        if (this.smartHomeMeterRetryAfter > this.now()) {
            return { attempted: false, succeeded: false, missingCircuits: meteredCircuits };
        }
        let values;
        try {
            const answer = await this.smartHome.getMeteringValues();
            if (this.isAdapterStopping()) {
                return { attempted: false, succeeded: true, missingCircuits: [] };
            }
            values = answer && answer.values;
            if (!Array.isArray(values)) {
                throw new Error('the response contains no values array');
            }
        } catch (err) {
            if (
                (err && typeof err === 'object' && 'shutdown' in err && err.shutdown === true) ||
                this.isAdapterStopping()
            ) {
                return { attempted: false, succeeded: true, missingCircuits: [] };
            }
            this.deferSmartHomeMeterRetry(err);
            return { attempted: true, succeeded: false, missingCircuits: meteredCircuits };
        }

        const byId = new Map();
        for (const entry of values) {
            if (entry && typeof entry.id === 'string') {
                byId.set(entry.id, finiteMeterValue(entry.attributes && entry.attributes.value));
            }
        }

        const missingCircuits = [];
        for (const circuit of meteredCircuits) {
            const power = byId.get(`dsm-${circuit.dSUID}-power`);
            const energy = byId.get(`dsm-${circuit.dSUID}-energy`);
            if (power === undefined || energy === undefined) {
                missingCircuits.push(circuit);
                continue;
            }
            // A poll, not an event: an unchanged reading is not written again (the counter
            // in info.apiActivity shows that the reads go on)
            this.setStateSafe(`devices.${circuit.dSUID}.PowerConsumption`, power, { skipUnchanged: true });
            // Gleiche Umrechnung wie im klassischen Weg: Wattsekunden -> Kilowattstunden.
            // Die API deklariert "Wh", das ist nachweislich falsch.
            this.setStateSafe(`devices.${circuit.dSUID}.EnergyMeterValue`, wattSecondsToKwh(energy), {
                skipUnchanged: true,
            });
        }

        if (meteredCircuits.length && missingCircuits.length === meteredCircuits.length) {
            // Die Antwort enthaelt keine einzige der bekannten Klemmen - dann stimmt die
            // Zuordnung nicht und der alte Weg ist der verlaesslichere
            this.deferSmartHomeMeterRetry(new Error('the response contains no value for any known circuit'));
            return { attempted: true, succeeded: false, missingCircuits: meteredCircuits };
        }
        this.resetSmartHomeMeterRetry();
        // Auch ein teilweiser Erfolg ist ein Erfolg der neuen API - die fehlenden Klemmen
        // meldet gleich darauf der klassische Weg
        this.reportMeteringApi(missingCircuits.length ? 'classic' : 'smarthome');
        if (missingCircuits.length) {
            this.adapter.log.debug(
                `${missingCircuits.length} of ${meteredCircuits.length} circuits are incomplete in the Smart Home API answer; reading only those circuits through the classic API`,
            );
        }
        return { attempted: true, succeeded: true, missingCircuits };
    }

    /**
     * Delays the next optional Smart Home attempt exponentially. Authentication errors use
     * the maximum delay immediately; saving corrected settings restarts the adapter anyway.
     *
     * @param {unknown} err
     */
    deferSmartHomeMeterRetry(err) {
        this.smartHomeMeterFailures++;
        const status = err && typeof err === 'object' && 'status' in err ? err.status : undefined;
        const exponent = Math.min(this.smartHomeMeterFailures - 1, 10);
        // 404 means the firmware does not offer /api/v1 at all - retrying more often
        // than the maximum makes as little sense as it does for a rejected key
        const permanent = status === 401 || status === 403 || status === 404;
        const delay = permanent
            ? this.smartHomeMeterRetryMax
            : Math.min(this.smartHomeMeterRetryBase * 2 ** exponent, this.smartHomeMeterRetryMax);
        this.smartHomeMeterRetryAfter = this.now() + delay;
        const minutes = Math.max(1, Math.ceil(delay / 60000));
        const reason =
            status === 404
                ? 'the dSS does not offer the Smart Home API (HTTP 404), it needs a newer firmware'
                : errorMessage(err);
        const message = `Meter values could not be read completely via the Smart Home API (${reason}); using the classic API and retrying the Smart Home API in ${minutes} minute${minutes === 1 ? '' : 's'}`;
        // A permanently failing API would otherwise warn once per hour, forever
        if (this.smartHomeMeterFailures === 1) {
            this.adapter.log.warn(message);
        } else {
            this.adapter.log.debug(message);
        }
    }

    resetSmartHomeMeterRetry() {
        this.smartHomeMeterFailures = 0;
        this.smartHomeMeterRetryAfter = 0;
    }

    /**
     * Records which API delivered the meter values.
     *
     * Without this the fallback is invisible: the adapter keeps running, just quietly on
     * the classic path. A single log line at startup does not answer "is the new API
     * actually working right now" - a state does, and it can be watched and charted.
     *
     * @param {'classic'|'smarthome'} api
     */
    reportMeteringApi(api) {
        if (this.lastMeteringApi === api) {
            return;
        }
        this.lastMeteringApi = api;
        this.adapter.setState && this.adapter.setState('info.meteringApi', api, true);
        this.adapter.log.info(
            `Meter values are now read via the ${api === 'smarthome' ? 'Smart Home' : 'classic'} API`,
        );
    }

    isAdapterStopping() {
        return !!(this.adapter && typeof this.adapter.isStopping === 'function' && this.adapter.isStopping());
    }

    updateMeterData(callback) {
        // main.js plant den naechsten Poll-Zyklus ausschliesslich in diesem Callback -
        // er muss deshalb genau einmal laufen, auch wenn ein Handler unerwartet wirft
        let settled = false;
        const finish = (failed, total) => {
            if (settled) {
                return;
            }
            settled = true;
            callback && callback(failed, total);
        };
        if (this.isAdapterStopping()) {
            callback && setImmediate(() => finish(0, 0));
            return;
        }
        if (this.smartHome) {
            this.updateMeterDataViaSmartHome()
                .then(
                    result => {
                        if (this.isAdapterStopping()) {
                            finish(0, 0);
                            return;
                        }
                        if (result.succeeded && !result.missingCircuits.length) {
                            // Bewusst (0, 0) statt (0, 1): main.js leitet aus diesem Callback
                            // info.connection ab. Dieser Zyklus hat die klassische API gar nicht
                            // angefasst, darf ueber ihren Zustand also nichts behaupten. Faellt
                            // sie aus, meldet das der Event-Kanal ueber eventError - und faellt
                            // der dSS ganz aus, scheitert auch die neue API und der klassische
                            // Weg unten liefert das Urteil.
                            finish(0, 0);
                            return;
                        }
                        const smartFailed = result.attempted && !result.succeeded ? 1 : 0;
                        const smartTotal = result.attempted ? 1 : 0;
                        this.updateMeterDataViaClassicApi(
                            (failed, total) => finish(failed + smartFailed, total + smartTotal),
                            result.missingCircuits,
                        );
                    },
                    err => {
                        if ((err && err.shutdown === true) || this.isAdapterStopping()) {
                            finish(0, 0);
                            return;
                        }
                        this.adapter.log.debug(`Smart Home meter read failed unexpectedly: ${errorMessage(err)}`);
                        this.deferSmartHomeMeterRetry(err);
                        this.updateMeterDataViaClassicApi(
                            (failed, total) => finish(failed + 1, total + 1),
                            (this.apartmentCircuits || []).filter(circuit => circuit.hasMetering),
                        );
                    },
                )
                .catch(err => {
                    if (settled) {
                        // Der Fehler kam aus dem Poll-Callback von main.js. Ihn nur zu
                        // loggen koennte die Poll-Kette still beenden (der naechste Zyklus
                        // wird IM Callback geplant) - frueher endete er als unhandled
                        // rejection und js-controller startete den Adapter neu. Dieses
                        // Sicherheitsnetz bleibt erhalten.
                        this.adapter.log.error(
                            `The meter poll callback threw (${errorMessage(err)}); restarting the adapter so the polling cannot silently stop`,
                        );
                        if (typeof this.adapter.restartAdapter === 'function') {
                            this.adapter.restartAdapter(30000, 'the meter poll callback threw');
                        } else {
                            setImmediate(() => {
                                throw err;
                            });
                        }
                        return;
                    }
                    this.adapter.log.error(`Meter update failed unexpectedly: ${errorMessage(err)}`);
                    finish(1, 1);
                });
            return;
        }
        this.updateMeterDataViaClassicApi(finish);
    }

    updateMeterDataViaClassicApi(callback, circuits) {
        if (this.isAdapterStopping()) {
            callback && setImmediate(() => callback(0, 0));
            return;
        }
        const meteredCircuits = (circuits || this.apartmentCircuits || []).filter(circuit => circuit.hasMetering);
        if (meteredCircuits.length) {
            this.reportMeteringApi('classic');
        }
        const totalCounter = meteredCircuits.length * 2;
        let updateCounter = totalCounter;
        let errorCounter = 0;
        let callbackCalled = false;
        const finishOne = failed => {
            if (failed) {
                errorCounter++;
            }
            updateCounter--;
            if (updateCounter || callbackCalled) {
                return;
            }
            callbackCalled = true;
            callback && callback(errorCounter, totalCounter);
        };
        if (!updateCounter) {
            callback && setImmediate(() => callback(0, 0));
            return;
        }

        meteredCircuits.forEach(circuit => {
            let consumptionFinished = false;
            this.dssQueue.pushQueryQueue(
                circuit.dSUID,
                'getConsumption',
                {
                    dssClass: 'circuit',
                    dssFunction: 'getConsumption',
                    params: {
                        dsuid: circuit.dSUID,
                    },
                },
                'low',
                (err, res) => {
                    if (consumptionFinished) {
                        return;
                    }
                    consumptionFinished = true;
                    const value =
                        !err && res && res.ok && res.result ? finiteMeterValue(res.result.consumption) : undefined;
                    if (value !== undefined) {
                        this.setStateSafe(`devices.${circuit.dSUID}.PowerConsumption`, value, {
                            skipUnchanged: true,
                        });
                    }
                    finishOne(value === undefined);
                },
            );

            let energyFinished = false;
            this.dssQueue.pushQueryQueue(
                circuit.dSUID,
                'getEnergyMeterValue',
                {
                    dssClass: 'circuit',
                    dssFunction: 'getEnergyMeterValue',
                    params: {
                        dsuid: circuit.dSUID,
                    },
                },
                'low',
                (err, res) => {
                    if (energyFinished) {
                        return;
                    }
                    energyFinished = true;
                    const value =
                        !err && res && res.ok && res.result ? finiteMeterValue(res.result.meterValue) : undefined;
                    if (value !== undefined) {
                        this.setStateSafe(`devices.${circuit.dSUID}.EnergyMeterValue`, wattSecondsToKwh(value), {
                            skipUnchanged: true,
                        });
                    }
                    finishOne(value === undefined);
                },
            );
        });
    }

    createDevices(devices, callback) {
        this.addFolderObject('devices', 'Devices');

        this.apartmentCircuits.forEach(circuit => {
            this.addFolderObject(`devices.${circuit.dSUID}`, circuit.name || 'Circuit');
            if (!circuit.hasMetering) {
                return;
            }
            this.addStateObject(`devices.${circuit.dSUID}.PowerConsumption`, {
                name: 'Power Consumption',
                type: 'number',
                role: 'value.power',
                unit: 'W',
                read: true,
                write: false,
            });

            this.addStateObject(`devices.${circuit.dSUID}.EnergyMeterValue`, {
                name: 'Energy Meter',
                type: 'number',
                role: 'value.power.consumption',
                unit: 'kWh',
                read: true,
                write: false,
            });

            const circuitStates = this.findStates(`^dsm\\.${circuit.dSUID}\\.(.*)$`);
            if (circuitStates && circuitStates.length) {
                this.addFolderObject(`devices.${circuit.dSUID}.states`, 'DSM States', 'channel');
                circuitStates.forEach(state => {
                    if (!state.matchedName) {
                        return;
                    }
                    const stateId = `devices.${circuit.dSUID}.states.${state.matchedName}`;
                    this.addStateObject(
                        stateId,
                        state.name,
                        {
                            name: state.matchedName,
                            role: 'indicator',
                            type: 'string',
                            read: true,
                            write: false,
                        },
                        value => {
                            value = DSSStructure.toBoolean(value);
                            this.dssQueue.pushQueryQueue(
                                circuit.dSUID,
                                {
                                    dssClass: 'state',
                                    dssFunction: 'set',
                                    params: {
                                        name: state.name,
                                        value: value,
                                    },
                                },
                                'high',
                                (err, res) => {
                                    if (err || (res && !res.ok)) {
                                        this.logQueueError(
                                            `Error while set State for ${circuit.dSUID}: ${err || JSON.stringify(res)}`,
                                            err,
                                        );
                                    }
                                },
                            );
                        },
                    );
                    this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
                });
            }
        });

        let deviceCounter = 0;
        devices.forEach(dev => {
            deviceCounter++;
            setImmediate(() =>
                this.createDevice(dev, () => {
                    !--deviceCounter && callback && callback(null);
                }),
            );
        });
        !deviceCounter && callback && setImmediate(() => callback(null));
    }

    createDevice(dev, callback) {
        if (!dev.isValid || !dev.isPresent) {
            this.adapter.log.debug(`IGNORE DEVICE ${dev.dSUID} because invalid`);
            callback && setImmediate(() => callback(null));
            return;
        }
        this.zoneDevices[dev.zoneID] = this.zoneDevices[dev.zoneID] || {};
        dev.groups &&
            dev.groups.forEach(group => {
                this.zoneDevices[dev.zoneID][group] = this.zoneDevices[dev.zoneID][group] || [];
                this.zoneDevices[dev.zoneID][group].push(dev.dSUID);
            });
        this.devicesByDsuid[dev.dSUID] = dev;
        const devId = `devices.${dev.meterDSUID}.${dev.dSUID}`;
        const devName = dev.name ? `${dev.name}(${dev.hwInfo})` : dev.hwInfo;

        // An unknown output mode used to end up in the object name as the literal
        // "(undefined)" - six devices carried that on the installation this was found on.
        // The name is written without the suffix instead, and the unknown mode is logged
        // once so the next one is noticed instead of being cast into a name forever.
        const outputRole = dssConstants.outputModeToRoleMap[dev.outputMode];
        if (outputRole === undefined) {
            this.adapter.log.debug(
                `Unknown outputMode ${dev.outputMode} on ${dev.hwInfo || 'device'} ${dev.dSUID} - name written without the role suffix`,
            );
        }
        this.addFolderObject(devId, outputRole ? `${devName} (${outputRole})` : devName, 'device');

        if (dev.sensorInputCount) {
            let realSensors = false;
            dev.sensors.forEach((sensor, idx) => {
                if (!dssConstants.sensorUnitRoleMap[sensor.type]) {
                    return;
                }
                if (!realSensors) {
                    this.addFolderObject(`${devId}.sensors`, 'Device Sensor Channels', 'channel');
                    realSensors = true;
                }
                const sensorId = `${devId}.sensors.${idx}`;
                this.addStateObject(
                    sensorId,
                    `${dev.dSUID}.sensors.${idx}`,
                    dssConstants.sensorUnitRoleMap[sensor.type],
                );
                if (sensor.valid) {
                    this.initialObjectValues[sensorId] = sensor.value;
                } else if (INITIAL_READ_SENSOR_TYPES.has(sensor.type)) {
                    // The dSS marks the sensor invalid: its value only ever arrives with
                    // a deviceSensorValue event, and a device with constant consumption
                    // (a printer in standby) may not send one for months. One low
                    // priority bus read fills the state. Only the metering types whose
                    // native 12 bit value IS the event float (1 W / 1 mA / 1 VA steps) -
                    // energy meter and high range current natives have unverified
                    // resolutions and stay with the events.
                    this.dssQueue.queueReadSensorValue(dev, idx, 'low', (err, value) => {
                        if (err || this.isAdapterStopping()) {
                            err && this.adapter.log.debug(`No initial sensor read ${idx} of ${dev.dSUID}: ${err}`);
                            return;
                        }
                        if (typeof value === 'number' && isFinite(value)) {
                            this.setStateSafe(sensorId, value);
                            this.initialObjectValues[sensorId] = value;
                        }
                    });
                }
            });
        }

        if (dev.binaryInputCount) {
            this.addFolderObject(`${devId}.binaryInputs`, 'Device Binary Inputs', 'channel');
            dev.binaryInputs.forEach((input, idx) => {
                if (
                    !dssConstants.binaryInputTypeNames[input.inputType] &&
                    input.inputType === 0 &&
                    !this.groupTypes[input.targetGroup]
                ) {
                    this.adapter.log.warn(`    INVALID BINARYINPUT TYPE ${input.inputType} / ${input.targetGroup}`);
                }
                const inputId = `${devId}.binaryInputs.${idx}`;
                this.addStateObject(inputId, `${dev.dSUID}.binaryInputs.${idx}`, {
                    name:
                        dssConstants.binaryInputTypeNames[input.inputType] ||
                        this.groupTypes[input.targetGroup] ||
                        'Unknown',
                    type: 'number',
                    role: 'value',
                    states: dssConstants.windowHandleInputTypes.includes(input.inputType)
                        ? dssConstants.windowHandleStateNames
                        : dssConstants.binaryInputStateNames,
                    read: true,
                    write: false,
                });
                this.initialObjectValues[inputId] = input.state;
            });
        }

        const devStates = this.findStates(`^dev\\.${dev.dSUID}\\.(.*)$`);
        if (devStates && devStates.length) {
            this.addFolderObject(`${devId}.states`, 'Device States', 'channel');
            devStates.forEach(state => {
                if (!state.matchedName) {
                    return;
                }
                const stateId = `${devId}.states.${state.matchedName}`;
                this.addStateObject(
                    stateId,
                    state.name,
                    {
                        name: state.matchedName,
                        role: 'indicator',
                        type: 'string',
                        read: true,
                        write: false,
                    },
                    value => {
                        this.dssQueue.pushQueryQueue(
                            dev.dSUID,
                            {
                                dssClass: 'state',
                                dssFunction: 'set',
                                params: {
                                    name: state.name,
                                    value: value,
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while set State for ${dev.dSUID}: ${err || JSON.stringify(res)}`,
                                        err,
                                    );
                                }
                            },
                        );
                    },
                );
                this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
            });
        }

        dev.outputChannelList = {};
        if (dev.outputMode && dev.outputChannels && dev.outputChannels.length) {
            dev.outputChannels.forEach(output => {
                if (!dssConstants.outputChannelUnitRoleMap[output.channelType]) {
                    // Channels without a channelType (e.g. the media channels of dS audio
                    // devices) are simply not supported - that is not an error worth a warning.
                    if (!output.channelType) {
                        this.adapter.log.debug(
                            `Unsupported output channel without type for ${dev.dSUID}: ${JSON.stringify(output)}`,
                        );
                    } else {
                        this.adapter.log.info(
                            `Unsupported output channel type "${output.channelType}" for ${dev.dSUID}: ${JSON.stringify(output)}`,
                        );
                    }
                    return;
                }
                const outputChannelId = `${devId}.${output.channelId}`;
                this.addStateObject(
                    outputChannelId,
                    `${dev.dSUID}.${output.channelId}`,
                    dssConstants.outputChannelUnitRoleMap[output.channelType],
                );
                dev.outputChannelList[output.channelType] = outputChannelId;

                // TODO find generic way to get Output value - currently implemented per device type later (light/shade)

                // TODO add way to SET values!!

                /* values:/device/getOutputChannelValue2?dsuid=5a11caa06212578280d826428d15c3d700 ((OPTIONAL &channels=brightness;saturation;hue))

                    const channelList = dev.outputChannels.map(output => output.channelId).join(';');
                    dss.requestAsync('device', 'getOutputChannelValue' , {dsid: dev.id, channels: channelList}).then((outputChannelValues) => {
                        this.adapter.log.debug('getOutputChannelValue for ' + dev.dSUID + ' AND ' + channelList + ': ' + JSON.stringify(outputChannelValues));
                        outputChannelValues = this.convertObject(outputChannelValues.result.channels, 'index');

                    queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[output.channelType].channelIndex, 'medium', (err, value) => {

                    });

                    set /device/setOutputChannelValue2?dsuid=5a11caa06212578280d826428d15c3d700&channels={”brightness”: {”value”: 10, ”automatic”: false}, ”saturation”: {”value”: 100}, ”hue”: {”value”: 235}}
                    */
            });
        }

        if (dev.outputMode) {
            // DEVICE. state (button) true= 5, false = 0
            // sendSceneCommand
            // setDeviceScene: '/device/callScene?dsid=%s&sceneNumber=%s&category=manual',
            // setDeviceValue: '/device/setConfig?&dsuid=%1&class=%2&index=%3&value=%4&category=manual'
            this.addFolderObject(`${devId}.scenes`, 'Device Scenes', 'channel');
            const sceneList = {};
            Object.keys(dssConstants.zoneSceneCommands).forEach(scene => {
                const sceneId = `${devId}.scenes.${this.convertSceneName(dssConstants.zoneSceneCommands[scene])}`;
                sceneList[scene] = dssConstants.zoneSceneCommands[scene];

                this.addStateObject(
                    sceneId,
                    `${dev.dSUID}.scenes.${scene}`,
                    {
                        name: dssConstants.zoneSceneCommands[scene],
                        type: 'boolean',
                        role: 'switch',
                    },
                    value => {
                        value = DSSStructure.toBoolean(value);
                        this.dssQueue.pushQueryQueue(
                            dev.meterDSUID,
                            {
                                dssClass: 'device',
                                dssFunction: value ? 'callScene' : 'undoScene',
                                params: {
                                    dsuid: dev.dSUID,
                                    sceneNumber: scene,
                                    category: 'manual',
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while ${value ? 'callScene' : 'undoScene'} for ${dev.dSUID}: ${
                                            err || JSON.stringify(res)
                                        }`,
                                        err,
                                    );
                                }
                            },
                        );
                    },
                );
                this.initialObjectValues[sceneId] = false;
            });
            for (let sceneId = 67; sceneId <= 70; sceneId++) {
                const sceneStateId = `${devId}.scenes.${this.convertSceneName(dssConstants.apartmentScenes[sceneId])}`;
                sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

                this.addStateObject(
                    sceneStateId,
                    `${dev.dSUID}.scenes.${sceneId}`,
                    {
                        name: dssConstants.apartmentScenes[sceneId],
                        type: 'boolean',
                        role: 'switch',
                    },
                    value => {
                        value = DSSStructure.toBoolean(value);
                        this.dssQueue.pushQueryQueue(
                            'zone',
                            {
                                dssClass: 'device',
                                dssFunction: value ? 'callScene' : 'undoScene',
                                params: {
                                    dsuid: dev.dSUID,
                                    sceneNumber: sceneId,
                                    category: 'manual',
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while ${value ? 'callScene' : 'undoScene'} for ${dev.dSUID}: ${
                                            err || JSON.stringify(res)
                                        }`,
                                        err,
                                    );
                                }
                            },
                        );
                    },
                );
                this.initialObjectValues[sceneStateId] = false;
            }
            if (Object.keys(sceneList).length) {
                this.addStateObject(
                    `${devId}.scenes.sceneId`,
                    {
                        name: 'Device Scene ID',
                        type: 'number',
                        role: 'state',
                        states: sceneList,
                    },
                    value => {
                        if (!sceneList[value]) {
                            this.adapter.log.warn(`Invalid Scene ID ${value} for ${dev.dSUID}.scenes.sceneId`);
                            return;
                        }
                        this.dssQueue.pushQueryQueue(
                            dev.meterDSUID,
                            {
                                dssClass: 'device',
                                dssFunction: 'callScene',
                                params: {
                                    dsuid: dev.dSUID,
                                    sceneNumber: value,
                                    category: 'manual',
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while callScene for ${dev.dSUID}: ${err || JSON.stringify(res)}`,
                                        err,
                                    );
                                }
                            },
                        );
                    },
                );
            }
        }

        if (dev.buttonActiveGroup > 0 && dev.buttonActiveGroup <= 8) {
            this.addStateObject(`${devId}.button`, `${dev.dSUID}.0.button`, {
                name: `${dev.name} Button State`,
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            });
            this.initialObjectValues[`${devId}.button`] = false;
        }

        if (dev.hwInfo.startsWith('SW-') || dev.hwInfo.startsWith('IC SW-')) {
            // Joker / Tasten
            this.createJokerDevice(dev, devId, callback);
        } else if ((dev.hwInfo.startsWith('GE-') || dev.hwInfo.startsWith('IC GE-')) && !dev.hwInfo.includes('-UMV')) {
            // Yellow: Light
            this.createLightDevice(dev, devId, callback);
        } else if (dev.hwInfo.startsWith('GR-') || dev.hwInfo.startsWith('IC GR-')) {
            // Gray: Shades
            this.createShaderDevice(dev, devId, callback);
        } else {
            if (dev.outputMode && dev.outputChannels && dev.outputChannels.length) {
                if (dev.outputChannels.length === 1) {
                    const output = dev.outputChannels[0];
                    const outputStateId = `${devId}.${output.channelId}`;
                    if (
                        dssConstants.outputChannelUnitRoleMap[output.channelType] &&
                        dssConstants.outputChannelUnitRoleMap[output.channelType].native
                    ) {
                        const roleDef = dssConstants.outputChannelUnitRoleMap[output.channelType];
                        const channelIndex =
                            roleDef.native.channelIndex !== undefined
                                ? roleDef.native.channelIndex
                                : output.channelIndex;
                        const nativeMax = roleDef.native.nativeMax;

                        if (
                            output &&
                            this.adapter.config.initializeOutputValues &&
                            !this.queueGenericInitialRead(dev, output.channelType)
                        ) {
                            this.dssQueue.queueUpdateOutputValue(
                                dev,
                                channelIndex,
                                nativeMax,
                                'medium',
                                (err, value) => {
                                    if (err) {
                                        this.logOutputReadError(dev, output.channelType, err);
                                        return;
                                    }
                                    if (roleDef.native.nativeMax && roleDef.max) {
                                        value = Math.round((value * roleDef.max) / roleDef.native.nativeMax);
                                    }
                                    this.setStateSafe(outputStateId, value);
                                    // Auch dieser dritte klassische Lesepfad zaehlt fuer
                                    // info.outputApi - sonst bliebe der State bei Anlagen
                                    // leer, deren Ausgaenge nur solche Geraete sind
                                    this.reportOutputApi('classic');
                                },
                            );
                        }
                        this.dssObjects[outputStateId].onChange = value => {
                            // Some output channels are declared as boolean (e.g. airLouverAuto /
                            // airFlowAuto - the ventilation swing and auto intensity switches).
                            // The DSS represents them as a 0/1 output channel value.
                            if (roleDef.type === 'boolean') {
                                if (
                                    typeof value !== 'boolean' &&
                                    typeof value !== 'number' &&
                                    typeof value !== 'string'
                                ) {
                                    this.adapter.log.warn(
                                        `Only booleans are allowed to set for ${outputStateId}, got ${typeof value}`,
                                    );
                                    return;
                                }
                                const boolValue = DSSStructure.toBoolean(value);
                                this.dssQueue.queueSetOutputValue(
                                    dev,
                                    channelIndex,
                                    1,
                                    boolValue ? 1 : 0,
                                    'high',
                                    err => {
                                        if (err) {
                                            this.logOutputWriteError(dev, err);
                                        } else {
                                            this.setStateSafe(outputStateId, boolValue);
                                        }
                                    },
                                );
                                return;
                            }
                            if (typeof value !== 'number') {
                                this.adapter.log.warn(`Only numbers are allowed to set for ${outputStateId}`);
                                return;
                            }
                            if (nativeMax) {
                                // For Min or Max use the scenes - but not if device is an GE/BL-UMV
                                if (
                                    !dev.hwInfo.includes('-UMV') &&
                                    roleDef.max !== undefined &&
                                    (value === roleDef.min || value === roleDef.max)
                                ) {
                                    value = value > roleDef.min;
                                    this.dssQueue.pushQueryQueue(
                                        dev.meterDSUID,
                                        {
                                            dssClass: 'device',
                                            dssFunction: 'callScene',
                                            params: {
                                                dsuid: dev.dSUID,
                                                sceneNumber: value ? 14 : 13,
                                                category: 'manual',
                                            },
                                        },
                                        'high',
                                        (err, res) => {
                                            if (err || (res && !res.ok)) {
                                                this.logQueueError(
                                                    `Error while ${value ? 'callScene' : 'undoScene'} for ${
                                                        dev.dSUID
                                                    }: ${err || JSON.stringify(res)}`,
                                                    err,
                                                );
                                            } else {
                                                this.setStateSafe(outputStateId, value ? roleDef.max : roleDef.min);
                                            }
                                        },
                                    );
                                } else {
                                    const normalizedValue = Math.round((value * nativeMax) / roleDef.max);
                                    this.dssQueue.queueSetOutputValue(
                                        dev,
                                        channelIndex,
                                        nativeMax,
                                        normalizedValue,
                                        'high',
                                        err => {
                                            if (err) {
                                                this.logOutputWriteError(dev, err);
                                            } else {
                                                this.setStateSafe(outputStateId, value);
                                            }
                                        },
                                    );
                                }
                            } else {
                                // send value directly
                                this.dssQueue.queueSetOutputValue(dev, channelIndex, 1, value, 'high', err => {
                                    if (err) {
                                        this.logOutputWriteError(dev, err);
                                    } else {
                                        this.setStateSafe(outputStateId, value);
                                    }
                                });
                            }
                        };
                    } else {
                        this.adapter.log.warn(
                            `Invalid output channel definition for device ${dev.dSUID}: ${JSON.stringify(output)}`,
                        );
                    }
                } else {
                    // More than one channel: WRITING needs a per-channel handler, which
                    // only the typed devices have. READING works for all of them - the
                    // bundled status request and the named channel read each carry every
                    // channel of the device in one answer.
                    const knownChannel = Object.keys(dev.outputChannelList)[0];
                    const served =
                        this.adapter.config.initializeOutputValues &&
                        knownChannel !== undefined &&
                        this.queueGenericInitialRead(dev, knownChannel);
                    if (!served) {
                        // A static property of the device, not an error - one line per device would
                        // flood the log on every start.
                        this.adapter.log.debug(
                            `${dev.outputChannels.length} Output values for device ${dev.dSUID} are unsupported: ${dev.outputChannels
                                .map(output => output.channelId)
                                .join(', ')}`,
                        );
                    }
                }
                // A scene changes these outputs as well - re-read them, see
                // registerSceneOutputRefresh. Without the sync a vDC device still gets
                // its own named read, but only for a DEVICE scene: that reaches exactly
                // this dSUID and costs one request, while a zone or apartment scene is
                // fanned out to every device of the room.
                this.registerSceneOutputRefresh(dev);
                if (
                    !this.smartHomeSync &&
                    this.adapter.config.initializeOutputValues &&
                    dev.isVdcDevice === true &&
                    Object.keys(dev.outputChannelList).length &&
                    this.dss &&
                    typeof this.dss.on === 'function'
                ) {
                    this.dss.on(dev.dSUID, data => {
                        if (
                            (data.name === 'callScene' || data.name === 'undoScene') &&
                            data.source &&
                            data.source.isDevice
                        ) {
                            this.queueVdcChannelRead(dev, Object.keys(dev.outputChannelList)[0], 'low', true);
                        }
                    });
                }
                if (dev.buttonActiveGroup === 8) {
                    this.createJokerDevice(dev, devId, callback);
                } else {
                    callback && setImmediate(() => callback());
                }
            } else {
                if (dev.buttonActiveGroup === 8) {
                    this.createJokerDevice(dev, devId, callback);
                } else {
                    callback && setImmediate(() => callback());
                }
            }
        }
    }

    createJokerDevice(dev, devId, callback) {
        // The state of button 0 belongs to buttonClickType/buttonHoldCount below: the event
        // handler in main.js aborts the whole buttonClick when it is missing, so creating only
        // two of the three states silently swallowed every press of the first button on
        // devices whose buttonActiveGroup is outside 1..8 (unassigned, broadcast, or > 8).
        if (!this.dssObjects[`${devId}.button`]) {
            this.addStateObject(`${devId}.button`, `${dev.dSUID}.0.button`, {
                name: `${dev.name} Button State`,
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            });
            this.initialObjectValues[`${devId}.button`] = false;
        }

        this.addStateObject(`${devId}.buttonClickType`, `${dev.dSUID}.0.buttonClickType`, {
            name: `${dev.name} Button Click Type`,
            type: 'number',
            role: 'indicator',
            states: {
                0: 'Single Tip',
                1: 'Double Tip',
                2: 'Triple Tip',
                3: 'Quadruple Tip',
                4: 'Hold Start',
                5: 'Hold Repeat',
                6: 'Hold End',
                7: 'Single Click',
                8: 'Double Click',
                9: 'Triple Click',
                10: 'Single Tip (Off)',
                11: 'Single Tip (On/Down)',
                12: 'Single Tip (On/Up)',
                14: 'Single Tip (Stop)',
            },
        });
        this.initialObjectValues[`${devId}.buttonClickType`] = null;

        this.addStateObject(`${devId}.buttonHoldCount`, `${dev.dSUID}.0.buttonHoldCount`, {
            name: `${dev.name} Button Hold Count`,
            type: 'number',
            role: 'indicator',
            unit: 'ms',
            read: true,
            write: false,
        });
        this.initialObjectValues[`${devId}.buttonHoldCount`] = 0;

        if (dev.buttonInputCount > 1) {
            for (let cnt = 1; cnt < dev.buttonInputCount; cnt++) {
                this.addStateObject(`${devId}.button-${cnt}`, `${dev.dSUID}.${cnt}.button`, {
                    name: `${dev.name} Button State`,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                });
                this.initialObjectValues[`${devId}.button-${cnt}`] = false;

                this.addStateObject(`${devId}.buttonClickType-${cnt}`, `${dev.dSUID}.${cnt}.buttonClickType`, {
                    name: `${dev.name} Button Click Type`,
                    type: 'number',
                    role: 'indicator',
                    states: {
                        0: 'Single Tip',
                        1: 'Double Tip',
                        2: 'Triple Tip',
                        3: 'Quadruple Tip',
                        4: 'Hold Start',
                        5: 'Hold Repeat',
                        6: 'Hold End',
                        7: 'Single Click',
                        8: 'Double Click',
                        9: 'Triple Click',
                        10: 'Single Tip (Off)',
                        11: 'Single Tip (On/Down)',
                        12: 'Single Tip (On/Up)',
                        14: 'Single Tip (Stop)',
                    },
                });
                this.initialObjectValues[`${devId}.buttonClickType-${cnt}`] = null;

                this.addStateObject(`${devId}.buttonHoldCount-${cnt}`, `${dev.dSUID}.${cnt}.buttonHoldCount`, {
                    name: `${dev.name} Button Hold Count`,
                    type: 'number',
                    role: 'indicator',
                    unit: 'ms',
                    read: true,
                    write: false,
                });
                this.initialObjectValues[`${devId}.buttonHoldCount-${cnt}`] = 0;
            }
        }

        // A joker with an output - a switched socket, for instance - had no read for it
        // at all: its value only ever arrived with the next reconciliation, up to five
        // minutes after it was switched. The bundled status request is its only working
        // read (the channel has no offset the dSS answers, and the named read is for vDC
        // hardware), so it is asked at startup and right after a scene. A whole room
        // coalesces into ONE status read, and without the sync nothing happens at all -
        // exactly the behaviour of before.
        if (
            this.adapter.config.initializeOutputValues &&
            this.smartHomeSync &&
            dev.outputChannelList &&
            Object.keys(dev.outputChannelList).length
        ) {
            this.smartHomeSync.requestDeviceSync(dev);
        }
        this.registerSceneOutputRefresh(dev);

        callback && setImmediate(() => callback());
    }

    createLightDevice(dev, devId, callback) {
        // options is passed straight through to setStateSafe. The read paths hand in
        // skipUnchanged, the write callbacks below deliberately do not: a command has to
        // reach its acknowledgement even when it sets the value that is already there.
        const setLightValue = (outputType, value, options) => {
            if (outputType !== 'brightness') {
                this.adapter.log.warn(`Not supported ${outputType} for ${dev.dSUID}`);
                return;
            }
            const percentValue = Math.round((value * 100) / 255);
            if (dev.outputMode === 16 && dev.outputSwitchThreshold !== undefined) {
                this.setStateSafe(`${devId}.state`, value >= dev.outputSwitchThreshold, options);
                this.initialObjectValues[`${devId}.state`] = value >= dev.outputSwitchThreshold;
            } else {
                this.setStateSafe(`${devId}.state`, !!percentValue, options);
                this.initialObjectValues[`${devId}.state`] = !!percentValue;
            }

            if (this.stateMap[`${dev.dSUID}.brightness`]) {
                this.setStateSafe(this.stateMap[`${dev.dSUID}.brightness`], percentValue, options);
                this.initialObjectValues[this.stateMap[`${dev.dSUID}.brightness`]] = percentValue;
            }
        };
        // The Smart Home sync and queueClassicOutputRead() deliver through the same
        // helper, so the boolean .state stays consistent no matter which API answered
        dev.applyNativeLightValue = (value, options) => setLightValue('brightness', value, options);

        if (dev.outputMode === 16 && dev.outputSwitchThreshold === undefined) {
            this.dssQueue.pushQueryQueue(
                dev.meterDSUID,
                {
                    dssClass: 'device',
                    dssFunction: 'getSwitchThreshold',
                    params: {
                        dsuid: dev.dSUID,
                        category: 'manual',
                    },
                },
                'high',
                (err, res) => {
                    if (err || !res || !res.ok || !res.result || typeof res.result.threshold !== 'number') {
                        this.logQueueError(`Can not get SwitchThreshold for ${dev.dSUID}, assume 50%`, err);
                        dev.outputSwitchThreshold = 128;
                    } else {
                        dev.outputSwitchThreshold = res.result.threshold;
                    }
                    this.createLightDevice(dev, devId, callback);
                },
            );
            return;
        }

        this.addStateObject(
            `${devId}.state`,
            {
                name: `${dev.name} State`,
                type: 'boolean',
                role: 'switch.light',
            },
            value => {
                value = DSSStructure.toBoolean(value);
                this.dssQueue.pushQueryQueue(
                    dev.meterDSUID,
                    {
                        dssClass: 'device',
                        dssFunction: 'callScene',
                        params: {
                            dsuid: dev.dSUID,
                            sceneNumber: value ? 14 : 13,
                            category: 'manual',
                        },
                    },
                    'high',
                    (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.logQueueError(
                                `Error while ${value ? 'callScene' : 'undoScene'} for ${dev.dSUID}: ${
                                    err || JSON.stringify(res)
                                }`,
                                err,
                            );
                        } else {
                            setLightValue('brightness', value ? 255 : 0);
                        }
                    },
                );
            },
        );
        if (this.dssObjects[`${devId}.brightness`]) {
            this.dssObjects[`${devId}.brightness`].onChange = value => {
                if (value === 0 || value === 100) {
                    value = DSSStructure.toBoolean(value);
                    this.dssQueue.pushQueryQueue(
                        dev.meterDSUID,
                        {
                            dssClass: 'device',
                            dssFunction: 'callScene',
                            params: {
                                dsuid: dev.dSUID,
                                sceneNumber: value ? 14 : 13,
                                category: 'manual',
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while ${value ? 'callScene' : 'undoScene'} for ${dev.dSUID}: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            } else {
                                setLightValue('brightness', value ? 255 : 0);
                            }
                        },
                    );
                } else {
                    value = Math.round(
                        (value * dssConstants.outputChannelUnitRoleMap['brightness'].native.nativeMax) / 100,
                    );
                    this.dssQueue.queueSetOutputValue(
                        dev,
                        dssConstants.outputChannelUnitRoleMap['brightness'].native.channelIndex,
                        dssConstants.outputChannelUnitRoleMap['brightness'].native.nativeMax,
                        value,
                        'high',
                        (err, value) => {
                            if (err) {
                                this.logOutputWriteError(dev, err);
                            } else {
                                setLightValue('brightness', value);
                            }
                        },
                    );
                }
            };
        }

        if (dev.outputChannelList && this.adapter.config.initializeOutputValues) {
            // One status request of the new API covers every channel of every device.
            // Only without it (or when it fails) the classic per-channel reads run.
            if (!(this.smartHomeSync && this.smartHomeSync.requestDeviceSync(dev))) {
                Object.keys(dev.outputChannelList).forEach(outputType =>
                    this.queueClassicOutputRead(dev, outputType, 'medium'),
                );
            }
        }

        this.dss.on(dev.dSUID, data => {
            this.adapter.log.debug(`DEVICE event ${JSON.stringify(data)}`);
            if (data.name !== 'callScene' && data.name !== 'undoScene') {
                return;
            }
            let brightness;
            if (this.adapter.config.usePresetValues) {
                brightness = dssConstants.lightSceneValueMap[data.properties.sceneID];
                if (brightness !== null && brightness !== undefined) {
                    setLightValue('brightness', brightness);
                }
            }
            // Same semantics as for shades: initializeOutputValues controls the reads
            if (!this.adapter.config.initializeOutputValues) {
                return;
            }
            if (this.smartHomeSync && this.smartHomeSync.requestDeviceSync(dev, ['brightness'])) {
                return;
            }
            const prio = (brightness !== null && brightness !== undefined) || data.source.isGroup ? 'low' : 'medium';
            // Every channel, not just brightness: a scene may carry colour values as
            // well. For native lights the extra channels are no-ops (no offset read),
            // for vDC lights they coalesce into the ONE named channel read anyway.
            for (const outputType of Object.keys(dev.outputChannelList || { brightness: true })) {
                this.queueClassicOutputRead(dev, outputType, prio);
            }
        });

        callback && setImmediate(() => callback());
    }

    createShaderDevice(dev, devId, callback) {
        // Both stay null on a blind that declares no such channel - a blind without tilt
        // has no angle at all, and the handlers below check for exactly that.
        /** @type {string|null} */
        let positionName = null;
        /** @type {string|null} */
        let angleName = null;

        // The write handlers are registered independently of initializeOutputValues.
        // That option only controls whether output values are READ from the DSS - a blind
        // must stay controllable (position and angle) even when reading is switched off.
        if (dev.outputChannelList) {
            Object.keys(dev.outputChannelList).forEach(outputType => {
                let relevant = false;
                if (!positionName && outputType.includes('Position')) {
                    positionName = outputType;
                    relevant = true;
                } else if (!angleName && outputType.includes('Angle')) {
                    angleName = outputType;
                    relevant = true;
                }
                if (!relevant) {
                    return;
                }
                this.dssObjects[dev.outputChannelList[outputType]].onChange = value => {
                    const originalValue = value;
                    if (outputType === positionName && (value === 0 || value === 100)) {
                        value = DSSStructure.toBoolean(value);
                        this.dssQueue.pushQueryQueue(
                            dev.meterDSUID,
                            {
                                dssClass: 'device',
                                dssFunction: 'callScene',
                                params: {
                                    dsuid: dev.dSUID,
                                    sceneNumber: value ? 14 : 13,
                                    category: 'manual',
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while ${value ? 'callScene' : 'undoScene'} for ${dev.dSUID}: ${
                                            err || JSON.stringify(res)
                                        }`,
                                        err,
                                    );
                                } else {
                                    this.setStateSafe(dev.outputChannelList[outputType], originalValue);
                                }
                            },
                        );
                    } else {
                        value = Math.round(
                            (value * dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax) / 100,
                        );
                        this.dssQueue.queueSetOutputValue(
                            dev,
                            dssConstants.outputChannelUnitRoleMap[outputType].native.channelIndex,
                            dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax,
                            value,
                            'high',
                            err => {
                                if (err) {
                                    this.logOutputWriteError(dev, err);
                                } else {
                                    this.setStateSafe(dev.outputChannelList[outputType], originalValue);
                                }
                            },
                        );
                    }
                };
                // Only the initial read depends on the option
                if (this.adapter.config.initializeOutputValues) {
                    if (!(this.smartHomeSync && this.smartHomeSync.requestDeviceSync(dev, [outputType]))) {
                        this.queueClassicOutputRead(dev, outputType, 'medium');
                    }
                }
            });
        }

        const valueUpdateTimeouts = {};
        this.dss.on(dev.dSUID, data => {
            this.adapter.log.debug(`DEVICE event ${JSON.stringify(data)}`);
            if (data.name !== 'callScene' && data.name !== 'undoScene') {
                return;
            }
            // The preset stands in for a position that used to be unknowable while the
            // blind travelled. With the sync the real one arrives about two seconds
            // later and follows the movement, so the preset would only add a jump -
            // and it carries the value of the GROUP scene, which is not always the one
            // this device travels to (measured: preset 50 while the device went to 60,
            // and the state stood wrong for 21 seconds until the real value arrived).
            if (this.adapter.config.usePresetValues && !this.smartHomeSync) {
                let shadePos = dssConstants.shadeSceneValueMap[data.properties.sceneID];
                if (shadePos !== null && shadePos !== undefined) {
                    shadePos = Math.round((shadePos * 100) / 65535);
                    positionName && this.setStateSafe(dev.outputChannelList[positionName], shadePos);
                    if ((shadePos === 0 || shadePos === 100) && angleName && dev.outputChannelList[angleName]) {
                        if (!this.dssObjects[dev.outputChannelList[angleName]]) {
                            this.adapter.log.warn(`Can not set unknown state ${dev.outputChannelList[angleName]}`);
                        } else {
                            this.setStateSafe(dev.outputChannelList[angleName], shadePos);
                            this.initialObjectValues[dev.outputChannelList[angleName]] = shadePos;
                        }
                    }
                }
            }
            // Re-reading the real output values after a scene is a read as well, so it follows
            // the same option. Without it the states are still updated from the preset map
            // above (usePresetValues), the adapter just does not query the DSS.
            if (dev.outputChannelList && this.adapter.config.initializeOutputValues) {
                // One debounced status request of the new API replaces the per-channel
                // reads, including the follow-up reads while the blind is still moving
                if (this.smartHomeSync && this.smartHomeSync.requestDeviceSync(dev)) {
                    // Classic re-read timers armed while the sync was in its failure
                    // backoff would now read a second time - the status covers them
                    Object.keys(valueUpdateTimeouts).forEach(outputType => {
                        if (valueUpdateTimeouts[outputType]) {
                            clearTimeout(valueUpdateTimeouts[outputType]);
                            this.pendingTimeouts.delete(valueUpdateTimeouts[outputType]);
                            valueUpdateTimeouts[outputType] = null;
                        }
                    });
                    return;
                }
                Object.keys(dev.outputChannelList).forEach(outputType => {
                    if (valueUpdateTimeouts[outputType]) {
                        clearTimeout(valueUpdateTimeouts[outputType]);
                        this.pendingTimeouts.delete(valueUpdateTimeouts[outputType]);
                        valueUpdateTimeouts[outputType] = null;
                    }
                    valueUpdateTimeouts[outputType] = this.setClearableTimeout(() => {
                        valueUpdateTimeouts[outputType] = null;
                        this.queueClassicOutputRead(dev, outputType, 'medium');
                    }, 2000);
                });
            }
        });

        callback && setImmediate(() => callback());
    }

    /**
     * Reports a failed output value read.
     *
     * Not every device answers for every channel it declares - a blind without tilt
     * answers the angle parameter with HTTP 500. That is a property of the device, not a
     * fault, and the value is re-read after every scene. So it is reported once per device
     * and channel and only at debug afterwards.
     *
     * @param {StructureDevice} dev device as reported by the DSS
     * @param {string} outputType e.g. "shadeOpeningAngleOutside"
     * @param {Error} err
     */
    logOutputReadError(dev, outputType, err) {
        const key = `${dev.dSUID}.${outputType}`;
        const message = `Could not read ${outputType} of ${dev.name || dev.dSUID}: ${(err && err.message) || err}`;
        if (DSSQueue.isExpectedQueueError(err)) {
            // Cancelled by the adapter stop - not a property of the device, so it must
            // neither be reported nor block the "reported once" bookkeeping.
            this.adapter.log.debug(message);
            return;
        }
        if (this.reportedOutputReadErrors.has(key)) {
            this.adapter.log.debug(message);
            return;
        }
        this.reportedOutputReadErrors.add(key);
        this.adapter.log.info(
            `${message}. The device does not deliver this value - the state stays empty. This is only reported once.`,
        );
    }

    /**
     * Single entry point for reporting a failed queued request.
     *
     * Expected cancellations are classified centrally by DSSQueue.isExpectedQueueError():
     * - a queued but not yet sent value that was replaced by a newer one (SupersededError)
     *   is normal last-write-wins coalescing, not a DSS error
     * - a request cancelled by the adapter stop is expected as well
     *
     * Everything else (network errors, DSS error responses, invalid answers) stays a warning.
     *
     * @param {string} message
     * @param {Error} [err]
     */
    logQueueError(message, err) {
        if (DSSQueue.isExpectedQueueError(err)) {
            this.adapter.log.debug(message);
            return;
        }
        this.adapter.log.warn(message);
    }

    /**
     * Remembers what the dSS reports for an apartment user state. Only then can a
     * write of the same value be skipped safely: a state someone changed in the dSS
     * must not look unchanged to us.
     *
     * @param {string} id ioBroker state id
     * @param {any} value
     */
    noteUserStateValue(id, value) {
        const tracked = this.userStates.get(id);
        if (tracked) {
            tracked.value = value;
        }
    }

    /**
     * Sets a state value. Values delivered by the request queue can arrive before
     * processObjectQueue() has created the objects - such a value is parked as an initial
     * value instead of being written to an object that does not exist yet.
     *
     * @param {string} id ioBroker state id
     * @param {any} value
     * @param {{skipUnchanged?: boolean}} [options] skipUnchanged drops a write that would
     *   publish the value that is already there. ONLY for polling and reconciling paths -
     *   see this.publishedValues.
     * @returns {boolean} true when the value really went out, so a caller that counts its
     *   writes counts writes and not attempts
     */
    setStateSafe(id, value, options) {
        if (value === undefined) {
            return false;
        }
        if (!this.objectsReady) {
            this.initialObjectValues[id] = value;
            return false;
        }
        if (options && options.skipUnchanged && this.publishedValues.get(id) === value) {
            return false;
        }
        this.adapter.setDssState(id, value);
        return true;
    }

    /**
     * Remembers what is currently in a state. Fed from setDssState() for everything this
     * adapter writes, and from the acknowledged echo in onStateChange() for everything
     * someone else wrote - without the second half a state overwritten by another adapter
     * could never be corrected by the next reconciliation.
     *
     * @param {string} id
     * @param {any} value
     */
    notePublishedValue(id, value) {
        this.publishedValues.set(id, value);
    }

    /**
     * The value a state property carries at startup.
     *
     * Most states of the property dump describe themselves with a word: {"name":"presence",
     * "state":"present","value":"present"}. A few carry only the raw value and no word at
     * all - measured against a dSS20 1.19.13: {"name":"daylight","value":true,"script_id":
     * "solar_computer"} and {"name":"holiday","value":"off",...}. Reading only .state left
     * those five apartment states without any value from the first start to the next event
     * that happened to mention them, and for daylight and its siblings that event never
     * came. Both forms end up in coerceScalarValue(), which knows what to do with a boolean
     * as well as with "off".
     *
     * @param {Record<string, any>|null|undefined} state one entry of the property dump -
     *   the callers walk a list the dSS delivered, so an unusable entry is a normal case
     * @returns {any} the value to park as the initial one, undefined when there is none
     */
    static initialStateValue(state) {
        if (!state) {
            return undefined;
        }
        return state.state !== undefined ? state.state : state.value;
    }

    /**
     * Converts a written state value into a boolean. Plain !!value would turn the
     * strings "false" and "0" into true.
     *
     * @param {unknown} value
     * @returns {boolean}
     */
    static toBoolean(value) {
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            // The DSS uses different words for the "off" state depending on the state type
            if (DSSStructure.FALSY_STATE_WORDS.includes(normalized)) {
                return false;
            }
            return true;
        }
        return !!value;
    }

    /**
     * Resolves the state id suffix of a scene. Apartment and zone/group scenes live in
     * two disjoint maps, so both have to be considered for every level.
     *
     * A scene id the DSS did not send at all is a normal case for the callers, and the
     * map lookup answers it with null like any unknown scene - so undefined belongs in
     * the type instead of being an unwritten assumption.
     *
     * @param {number|string|undefined} sceneId
     * @returns {string|null} converted scene name or null when the scene is unknown
     */
    resolveSceneStateName(sceneId) {
        const name = dssConstants.apartmentScenes[sceneId] || dssConstants.zoneSceneCommands[sceneId];
        if (!name) {
            return null;
        }
        return this.convertSceneName(name);
    }

    /**
     * Resolves the ioBroker state of a scene exactly like the event handling does.
     *
     * Special groups use their own scene names for the same scene numbers: temperature
     * control (group 48) calls scene 0 "Heating Off" and the ventilation groups (10/64)
     * call it "Off", while the generic map calls it "Preset 0". All of them are registered
     * in the state map under the same DSS key, so the state map is the only authority.
     * Resolving the name generically here would mark the generic state as active while
     * every later event toggles the special one - both would permanently disagree.
     *
     * @param {string} dssSceneKey state map key, e.g. "5.48.scenes.0"
     * @param {number|string} sceneId scene number reported by the DSS
     * @param {string} baseId object path that holds the "scenes" channel
     * @returns {string|null} state id or null when the scene has no state
     */
    resolveSceneStateId(dssSceneKey, sceneId, baseId) {
        const mapped = this.stateMap[dssSceneKey];
        if (mapped) {
            return mapped;
        }
        // Fallback for scenes that exist as an object but were never registered in the
        // state map (keeps the previous behaviour for those)
        const sceneName = this.resolveSceneStateName(sceneId);
        return sceneName ? `${baseId}.scenes.${sceneName}` : null;
    }

    /**
     * Logs a failed output write. A superseded request is normal for fast slider
     * movements and therefore only logged at debug level.
     *
     * @param {StructureDevice} dev
     * @param {any} err whatever the queue rejected with - the DSS layer hands over an
     *   Error, a response message or a bare status code, which is why the callers read it
     *   as `(err && err.message) || err`
     */
    logOutputWriteError(dev, err) {
        if (DSSQueue.isExpectedQueueError(err)) {
            this.adapter.log.debug(
                `Output value for ${dev.dSUID} was not sent: ${(err && err.message) || err} (expected, no error)`,
            );
            return;
        }
        this.adapter.log.warn(`Error when setting output value for ${dev.dSUID}: ${(err && err.message) || err}`);
    }

    convertSceneName(name) {
        if (!name) {
            return name;
        }
        const brackets = name.indexOf(' (');
        if (brackets !== -1) {
            name = name.substr(0, brackets);
        }
        name = name.replace(/ /g, '');
        return name;
    }

    createUserActions() {
        if (!this.userActions || !this.userActions.length) {
            return;
        }

        this.addFolderObject('userActions', 'User Actions', 'channel');

        this.userActions.forEach(action => {
            this.addStateObject(
                `userActions.${action.id}`,
                {
                    name: `User Action ${action.name}`,
                    type: 'boolean',
                    role: 'button',
                },
                value => {
                    if (!value) {
                        return;
                    }
                    this.dssQueue.pushQueryQueue(
                        `event-${action.id}`,
                        {
                            dssClass: 'event',
                            dssFunction: 'raise',
                            params: {
                                name: 'highlevelevent',
                                parameter: `id=${action.id}`,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while raise event for apartment: ${err || JSON.stringify(res)}`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );
            this.initialObjectValues[`userActions.${action.id}`] = false;
        });
    }

    /**
     * The user defined states of the apartment - writable, and each write goes to the
     * dSS. Kept in its own method so the write path can be tested without building a
     * whole apartment.
     */
    createApartmentUserStates() {
        if (this.propertyUserStates && this.propertyUserStates.length) {
            this.addFolderObject('apartment.userStates', 'Apartment User States', 'channel');

            this.propertyUserStates.forEach(state => {
                const stateId = `apartment.userStates.${state.name.replace(/\./g, '-')}`;
                const stateValue = state.state;
                const stateObj = {
                    name: state.displayName,
                    role: 'indicator',
                    type: 'string',
                };
                this.userStates.set(stateId, { name: state.name, value: stateValue });
                this.addStateObject(stateId, state.name, stateObj, stateValue, value => {
                    const tracked = this.userStates.get(stateId);
                    if (tracked && tracked.value === value) {
                        // The dSS already holds this value: setting it again changes
                        // nothing there and emits no event, it only costs a request.
                        // Scripts that re-assert their states every few minutes made
                        // this the biggest remaining load on the classic interface.
                        this.adapter.log.debug(`User state ${state.name} already is ${value}, not sent again`);
                        this.setStateSafe(stateId, value);
                        return;
                    }
                    if (tracked) {
                        tracked.value = value;
                    }
                    this.dssQueue.pushQueryQueue(
                        'apartment-user',
                        {
                            dssClass: 'state',
                            dssFunction: 'set',
                            params: {
                                addon: 'system-addon-user-defined-states',
                                name: state.name,
                                value: value,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                // What the dSS holds is unknown again - the next write
                                // has to go out, even with the same value
                                if (tracked) {
                                    tracked.value = undefined;
                                }
                                this.logQueueError(
                                    `Error while set State for apartment-user: ${err || JSON.stringify(res)}`,
                                    err,
                                );
                            }
                        },
                    );
                });
                this.initialObjectValues[stateId] = stateValue;
            });
        }
    }

    /**
     * Creates the outdoor sensors of the apartment from the last getSensorValues answer.
     *
     * The DSS leaves a value out of that answer once it has gone stale - an outdoor
     * brightness sensor stops sending in the dark, and the value is missing from then on.
     * Creating only what the answer carries made the state disappear on every restart at
     * night, together with its history and its custom settings. A sensor ioBroker already
     * knows therefore keeps its object; only its value is not refreshed. A sensor that was
     * really removed from the installation keeps its object too - deleting it stays a
     * deliberate step of the user.
     */
    createOutdoorSensors() {
        const outdoor = (this.sensorValues && this.sensorValues.outdoor) || {};
        const existingStates = (this.adapter.objectHelper && this.adapter.objectHelper.existingStates) || {};
        const knownWithoutValue = Object.keys(dssConstants.sensorValuesRoleMapOutdoor).filter(
            sensorName => !outdoor[sensorName] && existingStates[`apartment.sensors.outdoor.${sensorName}`],
        );
        if (!Object.keys(outdoor).length && !knownWithoutValue.length) {
            return;
        }
        this.addFolderObject('apartment.sensors.outdoor', 'Apartment Outdoor Sensors', 'channel');

        const addSensor = sensorName =>
            this.addStateObject(
                `apartment.sensors.outdoor.${sensorName}`,
                `0.sensors.${dssConstants.sensorValuesRoleMapOutdoor[sensorName].native.sensorType}`,
                dssConstants.sensorValuesRoleMapOutdoor[sensorName],
            );

        Object.keys(outdoor).forEach(sensorName => {
            if (!dssConstants.sensorValuesRoleMapOutdoor[sensorName]) {
                this.adapter.log.warn(`INVALID Sensor Type! ${sensorName}`);
                return;
            }
            addSensor(sensorName);
            this.initialObjectValues[`apartment.sensors.outdoor.${sensorName}`] = {
                val: outdoor[sensorName].value,
                ts:
                    typeof outdoor[sensorName].time === 'number'
                        ? outdoor[sensorName].time
                        : new Date(outdoor[sensorName].time).getTime(),
            };
        });

        knownWithoutValue.forEach(sensorName => {
            this.adapter.log.debug(
                `The DSS reports no value for apartment.sensors.outdoor.${sensorName}, the known state keeps its last one`,
            );
            addSensor(sensorName);
            // deliberately no entry in initialObjectValues - the old value stays untouched
        });
    }

    createApartment(apartment, reachableZoneGroups, callback) {
        this.addFolderObject('apartment', 'Apartment');

        let callbackCounter = 0;
        /** @type {Set<string>} zones that are assigned to a floor, see the check below */
        const zonesOnAFloor = new Set();
        // Create Floors and Zones and Groups inside
        Object.keys(apartment.floors).forEach(floorId => {
            const floor = apartment.floors[floorId];
            this.addFolderObject(`apartment.${floorId}`, floor.name || `Floor ${floorId}`);

            floor.zones.forEach(zoneId => {
                zonesOnAFloor.add(String(zoneId));
                callbackCounter++;
                const zoneReachableGroups = (reachableZoneGroups[zoneId] && reachableZoneGroups[zoneId].groups) || [];
                setImmediate(() =>
                    this.processZone(
                        `apartment.${floorId}`,
                        apartment.zones[zoneId],
                        zoneReachableGroups,
                        this.sensorValues.zones[zoneId],
                        this.temperatureControlStatus.zones[zoneId],
                        () => {
                            !--callbackCounter && callback && callback(null);
                        },
                    ),
                );
            });
        });

        // Check if we have available Zones that were not assigned to any floor (should not happen).
        // Deliberately NOT via processedZones: the zones above are handed to processZone() through
        // setImmediate, so that map is still empty here and every regular zone would be reported.
        // isValid/isPresent are only evaluated when the DSS really reports them - not every
        // firmware sends isValid for a zone, and a plain truthiness check would silence the
        // whole check on those installations.
        Object.keys(apartment.zones).forEach(zoneId => {
            const zone = apartment.zones[zoneId];
            if (zone.isValid === false || zone.isPresent === false) {
                // processZone() never runs for it, so none of its states gets an object
                this.skippedStatePrefixes.add(`zone.${zoneId}.`);
                return;
            }
            if (zonesOnAFloor.has(String(zoneId))) {
                return;
            }
            this.adapter.log.warn(`EXTRANOUS ZONE found ${zoneId}`);
        });

        this.addFolderObject('apartment.scenes', 'Apartment Scenes', 'channel');

        const sceneList = {};
        Object.keys(dssConstants.apartmentScenes).forEach(sceneId => {
            // Object.keys() delivers strings - compare as numbers instead of relying on
            // the implicit coercion of the relational operators
            if (Number(sceneId) >= 67 && Number(sceneId) <= 70) {
                return;
            } // ignore Zone Scenes?
            const sceneStateId = `apartment.scenes.${this.convertSceneName(dssConstants.apartmentScenes[sceneId])}`;
            sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

            this.addStateObject(
                sceneStateId,
                `0.0.scenes.${sceneId}`,
                {
                    name: `Apartment ${dssConstants.apartmentScenes[sceneId]}`,
                    type: 'boolean',
                    role: 'switch',
                },
                value => {
                    value = DSSStructure.toBoolean(value);
                    this.dssQueue.pushQueryQueue(
                        'apartment',
                        {
                            dssClass: 'apartment',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                sceneNumber: sceneId,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while ${value ? 'callScene' : 'undoScene'} for apartment: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );
            this.initialObjectValues[sceneStateId] = false;
        });
        if (Object.keys(sceneList).length) {
            this.addStateObject(
                'apartment.scenes.sceneId',
                {
                    name: 'Scene ID',
                    type: 'number',
                    role: 'state',
                    states: sceneList,
                },
                value => {
                    if (!sceneList[value]) {
                        this.adapter.log.warn(`Invalid Scene ID ${value} for apartment.scenes.sceneId`);
                        return;
                    }
                    this.dssQueue.pushQueryQueue(
                        'apartment',
                        {
                            dssClass: 'apartment',
                            dssFunction: 'callScene',
                            params: {
                                sceneNumber: value,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while callScene for apartment: ${err || JSON.stringify(res)}`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );

            callbackCounter++;
            this.dssQueue.pushQueryQueue(
                'apartment',
                {
                    dssClass: 'zone',
                    dssFunction: 'getLastCalledScene',
                    params: {
                        id: 0,
                    },
                },
                'high',
                (err, res) => {
                    if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                        this.logQueueError(
                            `Error while getLastCalledScene for apartment: ${err || JSON.stringify(res)}`,
                            err,
                        );
                    } else {
                        this.initialObjectValues['apartment.scenes.sceneId'] = res.result.scene;
                        this.initialScenes['0.0'] = res.result.scene;
                        const sceneStateId = this.resolveSceneStateId(
                            `0.0.scenes.${res.result.scene}`,
                            res.result.scene,
                            'apartment',
                        );
                        if (sceneStateId && this.dssObjects[sceneStateId]) {
                            this.initialObjectValues[sceneStateId] = true;
                        }
                    }
                    !--callbackCounter && callback && callback(null);
                },
            );
        }

        const aptStates = this.findStates('^([^.]*)$');
        if (aptStates && aptStates.length) {
            this.addFolderObject('apartment.states', 'Apartment States', 'channel');

            aptStates.forEach(state => {
                if (!state.matchedName) {
                    return;
                }
                const stateId = `apartment.states.${state.matchedName}`;
                const stateName = state.matchedName;

                let roleMap = dssConstants.apartmentStateRoleMap[stateName];

                if (!roleMap) {
                    roleMap = {
                        name: stateName,
                        role: 'indicator',
                        type: 'boolean',
                        read: true,
                        write: false,
                        native: {
                            valueTrue: 'active',
                            valueFalse: 'inactive',
                        },
                    };
                }
                this.addStateObject(stateId, state.name, roleMap, value => {
                    if (!this.dssObjects[stateId] || !this.dssObjects[stateId].native) {
                        return;
                    }
                    const { valueTrue, valueFalse } = this.dssObjects[stateId].native;
                    if (valueTrue === undefined && valueFalse === undefined) {
                        // A state that carries the wording of the DSS (heating_water_system
                        // answers "hot water") has no active/inactive pair to send, and a
                        // guessed one would write nonsense into the installation
                        this.adapter.log.warn(`Cannot write ${stateId}: this DSS state carries text, not a flag`);
                        return;
                    }
                    this.dssQueue.pushQueryQueue(
                        'apartment',
                        {
                            dssClass: 'state',
                            dssFunction: 'set',
                            params: {
                                name: state.name,
                                value: DSSStructure.toBoolean(value) ? valueTrue : valueFalse,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while set State for apartment: ${err || JSON.stringify(res)}`,
                                    err,
                                );
                            }
                        },
                    );
                });
                // Converted to the declared type of the object when written
                this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
            });
        }

        this.createApartmentUserStates();

        this.addFolderObject('apartment.sensors', 'Apartment Sensors');

        // Ignore weather for now!
        this.createOutdoorSensors();
        // Sensor 60 is not a flag but a status code (0 = OK, 2 = Malfunction, 4 = Service,
        // 6 = Malfunction+Service). A boolean state would collapse every code != 0 to true
        // and lose the distinction, so the declared numeric type incl. its states map is used.
        this.addStateObject('apartment.sensors.VentilationStatusValue', '0.sensors.60', {
            ...dssConstants.sensorUnitRoleMap[60],
            name: 'Ventilation Status',
            read: true,
            write: false,
        });

        // Create Apartment groups, as soon as at least one device is present
        this.addFolderObject('apartment.groups', 'Apartment Groups');

        apartment.zone0.groups.forEach(group => {
            if (!group.devices || !group.devices.length) {
                this.skippedStatePrefixes.add(`zone.0.group.${group.id}.`);
                return;
            }
            callbackCounter++;
            setImmediate(() =>
                this.processGroup(`apartment.groups.${group.id}`, 0, group, () => {
                    !--callbackCounter && callback && callback(null);
                }),
            );

            // setApartmentScene: '/apartment/callScene?sceneNumber=%s&force=true',
            //  setZoneScene: '/zone/callScene?id=%s&sceneNumber=%s&force=true',
            //  setGroupScene: '/zone/callScene?id=%s&groupID=%s&sceneNumber=%s&force=true',
            // undoScene
        });
        !callbackCounter && callback && setImmediate(() => callback(null));
    }

    processZone(baseId, zone, reachableGroups, sensorValues, temperatureControlStatus, callback) {
        if (!zone) {
            this.adapter.log.debug('INVALID ZONE (not contained in apartment structure)');
            return callback && setImmediate(callback, null);
        }
        if (!zone.isPresent) {
            this.adapter.log.debug(`Ignore not present zone ${zone.id}`);
            this.skippedStatePrefixes.add(`zone.${zone.id}.`);
            return callback && setImmediate(callback, null);
        }
        if (this.processedZones[zone.id]) {
            this.adapter.log.debug(`Zone ${zone.id} already processec`);
            return callback && setImmediate(callback, null);
        }

        const zoneBaseId = `${baseId}.${zone.id}`;
        this.addFolderObject(zoneBaseId, zone.name || `Zone ${zone.id}`);

        const zoneStates = this.findStates(`^zone\\.${zone.id}\\.([^.]*)$`);
        if (zoneStates && zoneStates.length) {
            this.addFolderObject(`${zoneBaseId}.states`, 'Zone States', 'channel');

            zoneStates.forEach(state => {
                if (!state.matchedName) {
                    return;
                }
                const stateId = `${zoneBaseId}.states.${state.matchedName}`;
                const stateName = state.matchedName;
                if (!dssConstants.zoneStateRoleMap[stateName]) {
                    this.adapter.log.info(`INVALID Zone State ${state.matchedName}: ${JSON.stringify(state)}`);
                    return;
                }

                this.addStateObject(
                    stateId,
                    state.name,
                    dssConstants.zoneStateRoleMap[stateName],
                    state.state,
                    value => {
                        value = DSSStructure.toBoolean(value);
                        if (!this.dssObjects[stateId] || !this.dssObjects[stateId].native) {
                            return;
                        }
                        this.dssQueue.pushQueryQueue(
                            'zone',
                            {
                                dssClass: 'state',
                                dssFunction: 'set',
                                params: {
                                    name: state.name,
                                    value: value
                                        ? this.dssObjects[stateId].native.valueTrue
                                        : this.dssObjects[stateId].native.valueFalse,
                                },
                            },
                            'high',
                            (err, res) => {
                                if (err || (res && !res.ok)) {
                                    this.logQueueError(
                                        `Error while set State for zone: ${err || JSON.stringify(res)}`,
                                        err,
                                    );
                                }
                            },
                        );
                    },
                );
                // Converted to the declared type of the object when written
                this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
            });
        }
        this.createZoneSensorStates(zoneBaseId, zone);

        let groupCounter = 0;
        zone.groups.forEach(group => {
            if (!reachableGroups.includes(group.id)) {
                this.skippedStatePrefixes.add(`zone.${zone.id}.group.${group.id}.`);
                return;
            }
            groupCounter++;
            setImmediate(() =>
                this.processGroup(`${zoneBaseId}.${group.id}`, zone.id, group, () => {
                    !--groupCounter && callback && callback(null);
                }),
            );
        });
        this.processedZones[zone.id] = true;

        this.addFolderObject(`${zoneBaseId}.scenes`, `${zone.name || `Zone ${zone.id}`} Scenes`, 'channel');

        const sceneList = {};
        this.basicRoomScenes.forEach(sceneId => {
            const sceneStateId = `${zoneBaseId}.scenes.${this.convertSceneName(dssConstants.zoneSceneCommands[sceneId])}`;
            sceneList[sceneId] = dssConstants.zoneSceneCommands[sceneId];

            this.addStateObject(
                sceneStateId,
                `${zone.id}.0.scenes.${sceneId}`,
                {
                    name: `Zone ${zone.id} ${dssConstants.zoneSceneCommands[sceneId]}`,
                    type: 'boolean',
                    role: 'switch',
                },
                value => {
                    value = DSSStructure.toBoolean(value);
                    this.dssQueue.pushQueryQueue(
                        'zone',
                        {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                id: zone.id,
                                sceneNumber: sceneId,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while ${value ? 'callScene' : 'undoScene'} for zone ${zone.id}: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );
            this.initialObjectValues[sceneStateId] = false;
        });
        for (let sceneId = 67; sceneId <= 70; sceneId++) {
            const sceneStateId = `${zoneBaseId}.scenes.${this.convertSceneName(dssConstants.apartmentScenes[sceneId])}`;
            sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

            this.addStateObject(
                sceneStateId,
                `${zone.id}.0.scenes.${sceneId}`,
                {
                    name: `Zone ${zone.id} ${dssConstants.apartmentScenes[sceneId]}`,
                    type: 'boolean',
                    role: 'switch',
                },
                value => {
                    value = DSSStructure.toBoolean(value);
                    this.dssQueue.pushQueryQueue(
                        'zone',
                        {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                id: zone.id,
                                sceneNumber: sceneId,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while ${value ? 'callScene' : 'undoScene'} for zone ${zone.id}: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );
            this.initialObjectValues[sceneStateId] = false;
        }
        if (Object.keys(sceneList).length) {
            this.addStateObject(
                `${zoneBaseId}.scenes.sceneId`,
                {
                    name: 'Scene ID',
                    type: 'number',
                    role: 'value',
                    states: sceneList,
                },
                value => {
                    if (!sceneList[value]) {
                        this.adapter.log.warn(`Invalid Scene ID ${value} for Zone ${zone.id}.scenes.sceneId`);
                        return;
                    }
                    this.dssQueue.pushQueryQueue(
                        'zone',
                        {
                            dssClass: 'zone',
                            dssFunction: 'callScene',
                            params: {
                                id: zone.id,
                                sceneNumber: value,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while ${value ? 'callScene' : 'undoScene'} for Zone ${zone.id}: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );

            groupCounter++;
            this.dssQueue.pushQueryQueue(
                'zone',
                {
                    dssClass: 'zone',
                    dssFunction: 'getLastCalledScene',
                    params: {
                        id: zone.id,
                    },
                },
                'high',
                (err, res) => {
                    if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                        this.logQueueError(
                            `Error while getLastCalledScene for zone ${zone.id}: ${err || JSON.stringify(res)}`,
                            err,
                        );
                    } else {
                        this.initialObjectValues[`${zoneBaseId}.scenes.sceneId`] = res.result.scene;
                        this.initialScenes[`${zone.id}.0`] = res.result.scene;
                        const sceneStateId = this.resolveSceneStateId(
                            `${zone.id}.0.scenes.${res.result.scene}`,
                            res.result.scene,
                            zoneBaseId,
                        );
                        if (sceneStateId && this.dssObjects[sceneStateId]) {
                            this.initialObjectValues[sceneStateId] = true;
                        }
                    }
                    !--groupCounter && callback && callback(null);
                },
            );
        }

        this.addFolderObject(`${zoneBaseId}.sensors`, `${zone.name || `Zone ${zone.id}`} Sensors`, 'channel');
        // Merken, wo die Sensor-States dieser Zone liegen - der Status der neuen API
        // adressiert Zonen ueber ihre Id (als String)
        this.zoneSensorBaseIds[String(zone.id)] = `${zoneBaseId}.sensors`;

        sensorValues = sensorValues || {};
        sensorValues.values = sensorValues.values || [];
        if (temperatureControlStatus) {
            sensorValues.values.push(temperatureControlStatus);
        }
        Object.keys(dssConstants.sensorValuesRoleMapZone).forEach(sensorValueName => {
            const sensor = sensorValues.values.find(val => val && val[sensorValueName] !== undefined) || {};

            this.addStateObject(
                `${zoneBaseId}.sensors.${sensorValueName}`,
                `${zone.id}.sensors.${dssConstants.sensorValuesRoleMapZone[sensorValueName].native.sensorType}`,
                dssConstants.sensorValuesRoleMapZone[sensorValueName],
                value => {
                    this.dssQueue.pushQueryQueue(
                        'zone',
                        {
                            dssClass: 'zone',
                            dssFunction: 'pushSensorValue',
                            params: {
                                id: zone.id,
                                groupID: 0,
                                sensorType: dssConstants.sensorValuesRoleMapZone[sensorValueName].native.sensorType,
                                sensorValue: value,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.logQueueError(
                                    `Error while pushSensorValue for zone: ${err || JSON.stringify(res)}`,
                                    err,
                                );
                            }
                        },
                    );
                },
            );
            if (sensor[sensorValueName] !== undefined) {
                this.initialObjectValues[`${zoneBaseId}.sensors.${sensorValueName}`] = sensor[sensorValueName];
            }
        });

        if (this.hasTemperatureControl(temperatureControlStatus)) {
            groupCounter++;
            this.createTemperatureControl(zoneBaseId, zone, temperatureControlStatus, () => {
                !--groupCounter && callback && callback(null);
            });
        }

        !groupCounter && callback && setImmediate(() => callback(null));
    }

    /**
     * Creates the room sensor states of dSS apps next to the zone states, for example
     * passiveCooling of the climate control.
     *
     * Only group 0 belongs to the room itself; a sensor state of another group is named
     * by reportUnmappedStates(). Read-only and without a write handler, the dSS computes
     * the value from the room sensor. A sensor state knows nothing but active, inactive
     * and unknown (dss-mainline src/model/state.cpp State::toString, a StateSensor has no
     * value list of its own), so an identifier without an entry in zoneSensorStateRoleMap
     * still gets a boolean. Unknown leaves it empty, like every other boolean state.
     *
     * @param {string} zoneBaseId object path of the zone
     * @param {StructureZone} zone zone as reported by the DSS
     */
    createZoneSensorStates(zoneBaseId, zone) {
        const states = this.addonSensorStates.filter(state => state.zoneId === zone.id && state.groupId === 0);
        // A failed read says nothing about the room. The objects of the last start keep their
        // mapping and their last value, the way createOutdoorSensors() keeps a sensor the dSS
        // left out - otherwise they would be listed as unknown ("Delete unknown objects"
        // removes them with their history), and each change would ask for a GitHub issue.
        const known = this.addonSensorStatesRead ? [] : this.knownZoneSensorStates(zoneBaseId, zone);
        if (!states.length && !known.length) {
            return;
        }
        if (!this.dssObjects[`${zoneBaseId}.states`]) {
            this.addFolderObject(`${zoneBaseId}.states`, 'Zone States', 'channel');
        }
        states.forEach(state => {
            let stateId = `${zoneBaseId}.states.${state.identifier.replace(FORBIDDEN_ID_CHARS, '_')}`;
            if (this.dssObjects[stateId]) {
                // A zone state or another sensor type already has this name. The dSS
                // keeps both apart by the sensor type, so the object id does as well.
                stateId = `${stateId}_type${state.sensorType}`;
            }
            // The dSS name stays the key of stateMap, whatever the object id became
            this.addStateObject(stateId, state.name, DSSStructure.zoneSensorStateDefinition(state), state.state);
            // Converted to the declared type of the object when written
            this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
            this.matchedPropertyStates.add(state.name);
        });
        known.forEach(({ id, state }) => {
            this.adapter.log.debug(`The sensor states of dSS apps could not be read, ${id} keeps its last value`);
            // deliberately no entry in initialObjectValues - the old value stays untouched
            this.addStateObject(id, state.name, DSSStructure.zoneSensorStateDefinition(state));
        });
    }

    /**
     * The room sensor state objects a previous start created for this zone, recognised by
     * the dSS name kept in native.dssStateName. Their stored id is kept as it is, with a
     * _type<n> suffix or cleaned characters.
     *
     * @param {string} zoneBaseId object path of the zone
     * @param {StructureZone} zone zone as reported by the DSS
     * @returns {Array<{id: string, state: {name: string, identifier: string}}>}
     */
    knownZoneSensorStates(zoneBaseId, zone) {
        const existingStates = (this.adapter.objectHelper && this.adapter.objectHelper.existingStates) || {};
        const prefix = `${zoneBaseId}.states.`;
        const result = [];
        Object.keys(existingStates).forEach(id => {
            const obj = existingStates[id];
            const name = id.startsWith(prefix) && obj && obj.native ? obj.native.dssStateName : undefined;
            const match = typeof name === 'string' ? ZONE_SENSOR_STATE.exec(name) : null;
            if (match && parseInt(match[1], 10) === zone.id && parseInt(match[2], 10) === 0 && !this.dssObjects[id]) {
                result.push({ id, state: { name, identifier: match[4] } });
            }
        });
        return result;
    }

    /**
     * The object definition of a room sensor state of a dSS app, see createZoneSensorStates().
     *
     * @param {{name: string, identifier: string}} state
     * @returns {Record<string, any>}
     */
    static zoneSensorStateDefinition(state) {
        const definition = dssConstants.zoneSensorStateRoleMap[state.identifier] || {
            name: state.identifier,
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive',
            },
        };
        // The dSS name, by which a start whose read failed finds the object again
        return { ...definition, native: { ...definition.native, dssStateName: state.name } };
    }

    /**
     * True when the DSS really regulates the temperature of this zone.
     *
     * apartment/getTemperatureControlStatus answers for EVERY zone, but a zone without a
     * controller only carries `ControlMode: 0` and no values at all. Creating the control
     * objects for those would only produce states that stay empty forever.
     *
     * @param {TemperatureControlStatus} [status] per zone entry of apartment/getTemperatureControlStatus
     * @returns {boolean}
     */
    hasTemperatureControl(status) {
        return !!status && typeof status.ControlMode === 'number' && status.ControlMode > 0;
    }

    /**
     * Creates the room temperature control of one zone.
     *
     * The operation mode itself is switched through the scenes of group 48, which already
     * exist. What was missing so far is the state of the controller (which zones are
     * regulated at all, who owns the set point) and the configured set point per mode.
     *
     * The set points are read with zone/getTemperatureControlValues. Not every DSS
     * firmware knows that endpoint, so the states are only created when the DSS really
     * answered - an unsupported firmware simply gets no set point objects instead of a
     * folder full of dead states.
     *
     * @param {string} zoneBaseId object path of the zone
     * @param {StructureZone} zone zone as reported by the DSS
     * @param {TemperatureControlStatus} status per zone entry of apartment/getTemperatureControlStatus
     * @param {() => void} callback
     */
    createTemperatureControl(zoneBaseId, zone, status, callback) {
        const baseId = `${zoneBaseId}.temperatureControl`;
        this.addFolderObject(baseId, `${zone.name || `Zone ${zone.id}`} Temperature Control`, 'channel');

        this.addStateObject(`${baseId}.ControlMode`, {
            name: 'Temperature Control Mode',
            type: 'number',
            role: 'value',
            states: dssConstants.temperatureControlModes,
            read: true,
            write: false,
        });
        this.initialObjectValues[`${baseId}.ControlMode`] = status.ControlMode;

        this.addStateObject(`${baseId}.ControlState`, {
            name: 'Temperature Control State',
            type: 'number',
            role: 'value',
            states: dssConstants.temperatureControlStates,
            read: true,
            write: false,
        });
        if (status.ControlState !== undefined) {
            this.initialObjectValues[`${baseId}.ControlState`] = status.ControlState;
        }

        // Mirrors the scenes of group 48 under a name that is findable. Registered in the
        // state map so the event handling keeps it in sync with every scene call.
        this.addStateObject(
            `${baseId}.OperationMode`,
            `${zone.id}.48.operationMode`,
            {
                name: 'Temperature Operation Mode',
                type: 'number',
                role: 'level',
                states: dssConstants.temperatureControlScenes,
                read: true,
                write: true,
            },
            value => {
                if (dssConstants.temperatureControlScenes[value] === undefined) {
                    this.adapter.log.warn(`Invalid operation mode ${value} for ${baseId}.OperationMode`);
                    return;
                }
                this.dssQueue.pushQueryQueue(
                    'zone',
                    {
                        dssClass: 'zone',
                        dssFunction: 'callScene',
                        params: { id: zone.id, groupID: 48, sceneNumber: value },
                    },
                    'high',
                    (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.logQueueError(
                                `Error while setting the operation mode of zone ${zone.id}: ${
                                    err || JSON.stringify(res)
                                }`,
                                err,
                            );
                        }
                    },
                );
            },
        );
        if (status.OperationMode !== undefined) {
            this.initialObjectValues[`${baseId}.OperationMode`] = status.OperationMode;
        }

        this.dssQueue.pushQueryQueue(
            'zone',
            {
                dssClass: 'zone',
                dssFunction: 'getTemperatureControlValues',
                params: { id: zone.id },
            },
            // Every other read of the structure build-up runs 'high'. This one sat on
            // 'medium' and therefore on the 10s grid: measured on a real installation the
            // five zone reads took 50.6s of the 149.7s in which the adapter is deaf to
            // events, each of them answered in 110ms on an otherwise empty queue.
            'high',
            (err, res) => {
                const values = !err && res && res.ok && res.result ? res.result : null;
                if (!values) {
                    this.adapter.log.debug(
                        `No temperature set points for zone ${zone.id}: ${err || JSON.stringify(res)}`,
                    );
                    return void (callback && callback());
                }
                // The field names are the operation modes of the DSS (Off, Comfort, Economy,
                // ...). They are taken as they come instead of being hard coded, so a
                // firmware with different or additional modes works as well.
                const modes = Object.keys(values).filter(name => typeof values[name] === 'number');
                if (modes.length) {
                    this.addFolderObject(`${baseId}.setpoints`, 'Temperature Set Points', 'channel');
                }
                modes.forEach(mode => {
                    const stateId = `${baseId}.setpoints.${mode}`;
                    this.addStateObject(
                        stateId,
                        {
                            name: `Set Point ${mode}`,
                            type: 'number',
                            role: 'level.temperature',
                            unit: '°C',
                            read: true,
                            write: true,
                        },
                        value => {
                            this.dssQueue.pushQueryQueue(
                                'zone',
                                {
                                    dssClass: 'zone',
                                    dssFunction: 'setTemperatureControlValues',
                                    params: { id: zone.id, [mode]: value },
                                },
                                'high',
                                (setErr, setRes) => {
                                    if (setErr || (setRes && !setRes.ok)) {
                                        this.logQueueError(
                                            `Error while setting the ${mode} set point of zone ${zone.id}: ${
                                                setErr || JSON.stringify(setRes)
                                            }`,
                                            setErr,
                                        );
                                    }
                                },
                            );
                        },
                    );
                    this.initialObjectValues[stateId] = values[mode];
                });
                callback && callback();
            },
        );
    }

    processGroup(groupBaseId, zoneId, group, callback) {
        if (!group.isPresent || !group.isValid) {
            return callback && setImmediate(callback, null);
        }
        // Request via the queue to not flood the DSS with a request burst on startup
        this.dssQueue.pushQueryQueue(
            'zone',
            {
                dssClass: 'zone',
                dssFunction: 'getReachableScenes',
                params: { id: zoneId, groupID: group.id },
            },
            'high',
            (err, reachableScenes) => {
                if (err) {
                    // Do not fail the whole initialization because of one broken group - just skip it
                    this.logQueueError(
                        `Err getReachableScenes for zone ${zoneId} group ${group.id} - skip group: ${
                            err.message || JSON.stringify(err)
                        }`,
                        err,
                    );
                    return void (callback && callback(null));
                }
                this.adapter.log.debug(`getReachableScenes ${zoneId}-${group.id}: ${JSON.stringify(reachableScenes)}`);

                this.addFolderObject(groupBaseId, group.name || `Group ${group.id}`);
                this.addFolderObject(`${groupBaseId}.scenes`, `${group.name || `Group ${group.id}`} Scenes`, 'channel');

                const sceneList = {};
                const reachableResult = (reachableScenes && reachableScenes.result) || {};
                const scenesToProcess = reachableResult.reachableScenes || [];
                this.basicRoomScenes.forEach(sceneId => scenesToProcess.push(sceneId)); // enhance
                if (scenesToProcess.length) {
                    const userNames = this.convertObject(reachableResult.userSceneNames, 'sceneNr');
                    if (scenesToProcess.includes(0)) {
                        scenesToProcess.push(40); // Add Auto-Off if we support off
                    }
                    scenesToProcess.forEach(sceneId => {
                        let sceneStateId;
                        let sceneName;
                        if (zoneId === 0) {
                            if (!dssConstants.apartmentScenes[sceneId] && !dssConstants.zoneSceneCommands[sceneId]) {
                                this.adapter.log.warn(`IGNORE INVALID SCENEID ${sceneId}`);
                                return;
                            }
                            sceneStateId = `${groupBaseId}.scenes.${this.convertSceneName(
                                dssConstants.apartmentScenes[sceneId] || dssConstants.zoneSceneCommands[sceneId],
                            )}`;
                            sceneName =
                                dssConstants.apartmentScenes[sceneId] || dssConstants.zoneSceneCommands[sceneId];
                        } else {
                            if (!dssConstants.zoneSceneCommands[sceneId]) {
                                this.adapter.log.warn(`IGNORE INVALID SCENEID ${sceneId}`);
                                return;
                            }
                            sceneStateId = `${groupBaseId}.scenes.${this.convertSceneName(
                                dssConstants.zoneSceneCommands[sceneId],
                            )}`;
                            sceneName =
                                (userNames[sceneId] && userNames[sceneId].sceneName) ||
                                // Die neue API kennt auch Namen, die die klassische
                                // getReachableScenes-Antwort nicht liefert
                                this.scenarioNames[`${zoneId}.${group.id}.${sceneId}`] ||
                                dssConstants.zoneSceneCommands[sceneId];
                        }
                        sceneList[sceneId] = sceneName;

                        this.addStateObject(
                            sceneStateId,
                            `${zoneId}.${group.id}.scenes.${sceneId}`,
                            {
                                name: `Group ${group.id} ${sceneName}`,
                                type: 'boolean',
                                role: 'switch',
                            },
                            value => {
                                value = DSSStructure.toBoolean(value);
                                this.dssQueue.pushQueryQueue(
                                    'zone',
                                    {
                                        dssClass: 'zone',
                                        dssFunction: value ? 'callScene' : 'undoScene',
                                        params: {
                                            sceneNumber: sceneId,
                                            groupID: group.id,
                                            id: zoneId,
                                        },
                                    },
                                    'high',
                                    (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.logQueueError(
                                                `Error while ${value ? 'callScene' : 'undoScene'} for group: ${
                                                    err || JSON.stringify(res)
                                                }`,
                                                err,
                                            );
                                        }
                                    },
                                );
                            },
                        );
                        this.initialObjectValues[sceneStateId] = false;
                    });
                    for (let sceneId = 67; sceneId <= 70; sceneId++) {
                        const sceneStateId = `${groupBaseId}.scenes.${this.convertSceneName(dssConstants.apartmentScenes[sceneId])}`;
                        sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

                        this.addStateObject(
                            sceneStateId,
                            `${zoneId}.${group.id}.scenes.${sceneId}`,
                            {
                                name: `Group ${group.id} ${dssConstants.apartmentScenes[sceneId]}`,
                                type: 'boolean',
                                role: 'switch',
                            },
                            value => {
                                value = DSSStructure.toBoolean(value);
                                this.dssQueue.pushQueryQueue(
                                    'zone',
                                    {
                                        dssClass: 'zone',
                                        dssFunction: value ? 'callScene' : 'undoScene',
                                        params: {
                                            id: zoneId,
                                            groupID: group.id,
                                            sceneNumber: sceneId,
                                        },
                                    },
                                    'high',
                                    (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.logQueueError(
                                                `Error while ${value ? 'callScene' : 'undoScene'} for group: ${
                                                    err || JSON.stringify(res)
                                                }`,
                                                err,
                                            );
                                        }
                                    },
                                );
                            },
                        );
                        this.initialObjectValues[sceneStateId] = false;
                    }
                }
                if (group.id === 48 && zoneId !== 0) {
                    Object.keys(dssConstants.temperatureControlScenes).forEach(sceneId => {
                        const sceneStateId = `${groupBaseId}.scenes.${this.convertSceneName(
                            dssConstants.temperatureControlScenes[sceneId],
                        )}`;
                        const sceneName = dssConstants.temperatureControlScenes[sceneId];
                        sceneList[sceneId] = sceneName;

                        this.addStateObject(
                            sceneStateId,
                            `${zoneId}.${group.id}.scenes.${sceneId}`,
                            {
                                name: `Group ${group.id} ${sceneName}`,
                                type: 'boolean',
                                role: 'switch',
                            },
                            value => {
                                value = DSSStructure.toBoolean(value);
                                this.dssQueue.pushQueryQueue(
                                    'zone',
                                    {
                                        dssClass: 'zone',
                                        dssFunction: value ? 'callScene' : 'undoScene',
                                        params: {
                                            sceneNumber: sceneId,
                                            groupID: group.id,
                                            id: zoneId,
                                        },
                                    },
                                    'high',
                                    (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.logQueueError(
                                                `Error while ${value ? 'callScene' : 'undoScene'} for group: ${
                                                    err || JSON.stringify(res)
                                                }`,
                                                err,
                                            );
                                        }
                                    },
                                );
                            },
                        );
                        this.initialObjectValues[sceneStateId] = false;
                    });
                }
                if ((group.id === 10 || group.id === 64) && zoneId !== 0) {
                    Object.keys(dssConstants.ventilationControlScenes).forEach(sceneId => {
                        const sceneStateId = `${groupBaseId}.scenes.${this.convertSceneName(
                            dssConstants.ventilationControlScenes[sceneId],
                        )}`;
                        const sceneName = dssConstants.ventilationControlScenes[sceneId];
                        sceneList[sceneId] = sceneName;

                        this.addStateObject(
                            sceneStateId,
                            `${zoneId}.${group.id}.scenes.${sceneId}`,
                            {
                                name: `Group ${group.id} ${sceneName}`,
                                type: 'boolean',
                                role: 'switch',
                            },
                            value => {
                                value = DSSStructure.toBoolean(value);
                                this.dssQueue.pushQueryQueue(
                                    'zone',
                                    {
                                        dssClass: 'zone',
                                        dssFunction: value ? 'callScene' : 'undoScene',
                                        params: {
                                            sceneNumber: sceneId,
                                            groupID: group.id,
                                            id: zoneId,
                                        },
                                    },
                                    'high',
                                    (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.logQueueError(
                                                `Error while ${value ? 'callScene' : 'undoScene'} for group: ${
                                                    err || JSON.stringify(res)
                                                }`,
                                                err,
                                            );
                                        }
                                    },
                                );
                            },
                        );
                        this.initialObjectValues[sceneStateId] = false;
                    });
                }
                if (Object.keys(sceneList).length) {
                    this.addStateObject(
                        `${groupBaseId}.scenes.sceneId`,
                        {
                            name: 'Group Scene ID',
                            type: 'number',
                            role: 'value',
                            states: sceneList,
                        },
                        value => {
                            if (!sceneList[value]) {
                                this.adapter.log.warn(`Invalid Scene ID ${value} for ${groupBaseId}.scenes.sceneId`);
                                return;
                            }
                            this.dssQueue.pushQueryQueue(
                                'zone',
                                {
                                    dssClass: 'zone',
                                    dssFunction: 'callScene',
                                    params: {
                                        sceneNumber: value,
                                        groupID: group.id,
                                        id: zoneId,
                                    },
                                },
                                'high',
                                (err, res) => {
                                    if (err || (res && !res.ok)) {
                                        this.logQueueError(
                                            `Error while callScene for ${groupBaseId}.scenes.sceneId: ${
                                                err || JSON.stringify(res)
                                            }`,
                                            err,
                                        );
                                    }
                                },
                            );
                        },
                    );

                    this.dssQueue.pushQueryQueue(
                        'zone',
                        {
                            dssClass: 'zone',
                            dssFunction: 'getLastCalledScene',
                            params: {
                                id: zoneId,
                                groupID: group.id,
                            },
                        },
                        'high',
                        (err, res) => {
                            if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                                this.logQueueError(
                                    `Error while getLastCalledScene for group ${zoneId}.${group.id}: ${
                                        err || JSON.stringify(res)
                                    }`,
                                    err,
                                );
                            } else {
                                this.initialObjectValues[`${groupBaseId}.scenes.sceneId`] = res.result.scene;
                                this.initialScenes[`${zoneId}.${group.id}`] = res.result.scene;
                                const sceneStateId = this.resolveSceneStateId(
                                    `${zoneId}.${group.id}.scenes.${res.result.scene}`,
                                    res.result.scene,
                                    groupBaseId,
                                );
                                if (sceneStateId && this.dssObjects[sceneStateId]) {
                                    this.initialObjectValues[sceneStateId] = true;
                                }
                            }
                            callback && callback(null);
                        },
                    );
                }

                // Two naming schemes end up here:
                // - `zone.<zone>.group.<group>.<name>` for the groups of a room. The name may
                //   contain dots itself (`status.malfunction` of the ventilation groups), so
                //   everything behind the group is taken and turned into a nested state.
                // - `cluster.<id>.<name>` for the apartment wide clusters (17, 18, ...). Their
                //   group folders exist, but their states used to have no object at all.
                const groupStates = this.findStates(`^zone\\.${zoneId}\\.group\\.${group.id}\\.(.+)$`).concat(
                    zoneId === 0 ? this.findStates(`^cluster\\.${group.id}\\.(.+)$`) : [],
                );
                if (groupStates && groupStates.length) {
                    this.addFolderObject(
                        `${groupBaseId}.states`,
                        `${group.name || `Group ${group.id}`} Scenes`,
                        'channel',
                    );

                    groupStates.forEach(state => {
                        if (!state.matchedName) {
                            return;
                        }
                        const stateId = `${groupBaseId}.states.${state.matchedName}`;
                        // `status.malfunction` becomes a nested state - create the folder in
                        // between so the object tree has no gap
                        if (state.matchedName.includes('.')) {
                            const parts = state.matchedName.split('.');
                            parts.slice(0, -1).forEach((part, idx) => {
                                const folderId = `${groupBaseId}.states.${parts.slice(0, idx + 1).join('.')}`;
                                if (!this.dssObjects[folderId]) {
                                    this.addFolderObject(folderId, part, 'channel');
                                }
                            });
                        }
                        this.addStateObject(
                            stateId,
                            state.name,
                            {
                                name: state.matchedName,
                                role: 'indicator',
                                type: 'boolean',
                                read: true,
                                write: false,
                                // Without a mapping the write handler below can only warn -
                                // it was the ONLY branch it ever took, because nothing else
                                // filled this native. The zone path (zoneStateRoleMap) is the
                                // working counterpart and this mirrors it: same vocabulary,
                                // same write: false, and a state the dSS computes itself
                                // still gets no mapping and keeps warning.
                                native: { ...(dssConstants.groupStateRoleMap[state.matchedName] || {}) },
                            },
                            value => {
                                value = DSSStructure.toBoolean(value);
                                const groupNative = this.dssObjects[stateId] && this.dssObjects[stateId].native;
                                // Without a value mapping the DSS would receive "undefined"
                                if (!groupNative || groupNative.valueTrue === undefined) {
                                    this.adapter.log.warn(
                                        `Can not write ${stateId}: no value mapping known for this group state`,
                                    );
                                    return;
                                }
                                this.dssQueue.pushQueryQueue(
                                    'group',
                                    {
                                        dssClass: 'state',
                                        dssFunction: 'set',
                                        params: {
                                            name: state.name,
                                            value: value
                                                ? this.dssObjects[stateId].native.valueTrue
                                                : this.dssObjects[stateId].native.valueFalse,
                                        },
                                    },
                                    'high',
                                    (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.logQueueError(
                                                `Error while set State for group: ${err || JSON.stringify(res)}`,
                                                err,
                                            );
                                        }
                                    },
                                );
                            },
                        );
                        this.initialObjectValues[stateId] = DSSStructure.initialStateValue(state);
                    });
                }

                !Object.keys(sceneList).length && callback && callback(null);
            },
        );
    }

    addFolderObject(id, name, type) {
        const obj = {
            type: type || 'folder',
            common: {
                // Circuits, rooms and devices carry the names of the dSS. One the dSS still
                // stores with HTML codes is shown with the real characters, see
                // decodeDssEntities() - the ID is never derived from it
                name: typeof name === 'string' ? decodeDssEntities(name) : name,
            },
        };
        this.dssObjects[id] = obj;

        const idLength = id.replace(/[^.]/g, '').length;
        const spacesStr = '                              ';
        this.adapter.log.debug(
            `${spacesStr.substr(0, idLength * 2)}CREATE ${obj.type} ${id} WITH ${JSON.stringify(obj)}`,
        );
    }

    addStateObject(id, dssId, objData, value, onChange) {
        if (typeof dssId === 'object') {
            onChange = value;
            value = objData;
            objData = dssId;
            dssId = null;
        }
        if (typeof value === 'function') {
            onChange = value;
            value = undefined;
        }

        objData = JSON.parse(JSON.stringify(objData));
        let native = {};
        if (objData.native) {
            native = objData.native;
            delete objData.native;
        }
        // Names of user states, scenes and sensors come from the dSS as well
        if (typeof objData.name === 'string') {
            objData.name = decodeDssEntities(objData.name);
        }
        const obj = {
            type: 'state',
            common: objData,
            native,
            value,
            onChange,
        };
        this.dssObjects[id] = obj;
        if (dssId) {
            this.stateMap[dssId] = id;
        }

        const idLength = id.replace(/[^.]/g, '').length;
        const spacesStr = '                              ';
        this.adapter.log.debug(
            `${spacesStr.substr(0, idLength * 2)}CREATE state ${id} value = ${value} WITH ${JSON.stringify(obj)}`,
        );
    }
}

DSSStructure.FALSY_STATE_WORDS = ['', '0', 'false', 'off', 'inactive', 'no', 'disabled', 'closed'];
// The word the dSS uses for a state it has no information about. A state without words of
// its own counts 1 = active, 2 = inactive, 3 = unknown; one with its own words numbers
// those instead (a window handle: 1 = closed, 2 = open, 3 = tilted). So only the word
// says "unknown", never the number (dss-mainline src/model/modelconst.h eState,
// src/model/state.cpp State::toString()). Neither true nor false, see
// Digitalstrom.coerceScalarValue().
DSSStructure.UNKNOWN_STATE_WORD = 'unknown';
DSSStructure.decodeDssEntities = decodeDssEntities;
DSSStructure.wattSecondsToKwh = wattSecondsToKwh;

module.exports = DSSStructure;
