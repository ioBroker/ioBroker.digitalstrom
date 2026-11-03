const { expect } = require('chai');
const { waitFor } = require('./lib/helpers');
const proxyquire = require('proxyquire');
const DSS = require('../lib/dss');
const dssConstants = require('../lib/constants');

// adapter-core needs a running js-controller, which is not available in unit tests.
// Only prototype methods and statics are used here, no instance is created.
const { Digitalstrom } = proxyquire('../main', {
    '@iobroker/adapter-core': {
        Adapter: class FakeAdapter {
            on() {}
        },
        // The value js-controller defines for START_IMMEDIATELY_AFTER_STOP, see
        // packages/common-db/src/lib/common/exitCodes.ts of ioBroker.js-controller
        EXIT_CODES: { START_IMMEDIATELY_AFTER_STOP: 156 },
        '@noCallThru': true,
    },
    '@apollon/iobroker-tools': {
        objectHelper: { init: () => {} },
        '@noCallThru': true,
    },
});

const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Shape of a real digitalSTROM application token (64 hex characters)
const VALID_APP_TOKEN = 'a1b2c3d4'.repeat(8);

/**
 * Builds a minimal adapter-like context so the adapter methods can be tested
 * without a running js-controller.
 *
 * Typed as a bag on purpose. Every test hangs its own fields on the context through
 * overrides, so a closed type would be wrong the moment somebody adds one - and a bare
 * `object` has no index signature, which makes every single property access an error
 * under a stricter TypeScript.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>} fake adapter context
 */
function createContext(overrides = {}) {
    const ctx = {
        log: silentLog,
        config: {},
        connected: null,
        states: {},
        stateMapEntries: {},
        /** @type {any[]} */ restarts: [],
        lastScenes: {},
        stopping: false,
        stopped: false,
        stopCallbacks: [],
        tokenConnections: new Set(),
        unmappedBooleanStates: new Set(),
        unhandledStateNames: new Set(),
        unmappedSceneCalls: new Set(),
        logUnmappedSceneCall: Digitalstrom.prototype.logUnmappedSceneCall,
        momentaryReleases: new Map(),
        momentaryReleaseDelay: 500,
        eventHandlersRegistered: false,
        setState(id, value) {
            this.states[id] = value;
        },
        isStopping: Digitalstrom.prototype.isStopping,
        registerEventHandlers: Digitalstrom.prototype.registerEventHandlers,
        resyncSceneStates: Digitalstrom.prototype.resyncSceneStates,
        setConnected: Digitalstrom.prototype.setConnected,
        coerceScalarValue: Digitalstrom.prototype.coerceScalarValue,
        coerceStateValue: Digitalstrom.prototype.coerceStateValue,
        setDssState: Digitalstrom.prototype.setDssState,
        normalizeConfig: Digitalstrom.prototype.normalizeConfig,
        restartAdapter(timeout) {
            this.restarts.push(timeout);
        },
        waitForDss: Digitalstrom.prototype.waitForDss,
        noteDssReachable: Digitalstrom.prototype.noteDssReachable,
        noteDssUnreachable: Digitalstrom.prototype.noteDssUnreachable,
        /** @type {NodeJS.Timeout|null} */
        dssRetryTimeout: null,
        dssRetryDelay: 5,
        /** @type {{since: number, failures: number, reported: Set<string>}|null} */
        dssOutage: null,
        eventLog: Digitalstrom.prototype.eventLog,
        releaseMomentaryState: Digitalstrom.prototype.releaseMomentaryState,
        parkable: Digitalstrom.prototype.parkable,
        liveOnly: Digitalstrom.prototype.liveOnly,
        replayStartupEvents: Digitalstrom.prototype.replayStartupEvents,
        settlePendingModelReady: Digitalstrom.prototype.settlePendingModelReady,
        pendingModelReady: false,
        ensureEventSubscription: Digitalstrom.prototype.ensureEventSubscription,
        startEarlyEventSubscription: Digitalstrom.prototype.startEarlyEventSubscription,
        failEarlyEventSubscription: Digitalstrom.prototype.failEarlyEventSubscription,
        /** @type {Array<{apply: () => void, at: number}>|null} */
        pendingEvents: null,
        pendingEventsDropped: 0,
        startupEventLimit: 2000,
        eventSubscriptionStarted: false,
        /** @type {Error|null|undefined} */
        eventSubscriptionResult: undefined,
        /** @type {Array<(err: Error|null) => void>} */
        eventSubscriptionWaiters: [],
        subscribeStates: () => {},
        startDataPolling: () => {},
        clearAdditionalObjects: () => {},
        ...overrides,
    };
    return ctx;
}

describe('Adapter logic', () => {
    describe('normalizePollInterval', () => {
        const cases = [
            // A cycle reads two values per circuit and the timer only starts afterwards, so
            // 100s is the first interval that stays within DSS rules 8/9
            [undefined, 100000, 'default when unset'],
            [null, 100000, 'default when null'],
            ['', 100000, 'default when empty'],
            [60, 60000, 'the configured minimum stays possible'],
            [100, 100000, 'the default itself'],
            ['120', 120000, 'numeric string'],
            [0, 0, 'zero disables polling'],
            ['0', 0, 'zero as string disables polling'],
            [-5, 0, 'negative disables instead of firing immediately'],
            [NaN, 100000, 'NaN falls back to default'],
            [Infinity, 100000, 'Infinity falls back to default'],
            ['abc', 100000, 'garbage falls back to default'],
            [1, 60000, 'too small values are raised to the minimum'],
            ['30', 60000, 'values below the minimum are raised to 60s'],
            [59, 60000, 'just below the minimum is raised to 60s'],
            [999999999, 24 * 60 * 60 * 1000, 'huge values are capped'],
            [120.4, 120000, 'fractions are rounded'],
        ];
        cases.forEach(([input, expected, label]) => {
            it(String(label), () => {
                expect(Digitalstrom.normalizePollInterval(input)).to.equal(expected);
            });
        });

        it('never produces an interval below the configured minimum', () => {
            [-1000, -1, 0.4, '-99', 1, 10, 59].forEach(input => {
                const result = Digitalstrom.normalizePollInterval(input);
                expect(result === 0 || result >= 60000, `bad interval for ${input}: ${result}`).to.equal(true);
            });
        });

        // Two requests per circuit and cycle plus roughly 20s until the timer restarts:
        // only from 100s on the adapter stays at or below one request per minute and circuit
        it('keeps the default within the request limit of the DSS', () => {
            const cycleSeconds = Digitalstrom.normalizePollInterval(undefined) / 1000 + 20;
            const requestsPerMinute = (2 / cycleSeconds) * 60;
            expect(requestsPerMinute, `default results in ${requestsPerMinute}/min`).to.be.at.most(1);
        });
    });

    describe('events that arrive while the objects are being created', () => {
        function parkingContext(overrides = {}) {
            const pending = [];
            const ctx = createContext({
                initializeSubscriptions(cb) {
                    pending.push(cb);
                },
                ...overrides,
            });
            return { ctx, pending };
        }

        // The whole point of subscribing before the objects exist: an event that arrives
        // during the 150 s build-up has to survive it.
        it('applies a parked level event only after the initial snapshot', () => {
            const { ctx } = parkingContext();
            const written = [];
            const handler = value => written.push(value);
            const parked = Digitalstrom.prototype.parkable.call(ctx, handler);

            ctx.pendingEvents = [];
            parked('event-value');
            expect(written, 'nothing may reach a state that does not exist yet').to.deep.equal([]);

            // setInitialValues writes the older snapshot first ...
            written.push('snapshot');
            ctx.replayStartupEvents();

            expect(written, 'the event is newer than the snapshot and must win').to.deep.equal([
                'snapshot',
                'event-value',
            ]);
        });

        it('keeps the arrival order of the parked events', () => {
            const { ctx } = parkingContext();
            const written = [];
            const parked = Digitalstrom.prototype.parkable.call(ctx, value => written.push(value));
            ctx.pendingEvents = [];
            parked(1);
            parked(2);
            parked(3);
            ctx.replayStartupEvents();
            expect(written).to.deep.equal([1, 2, 3]);
        });

        it('passes an event straight through once the objects are there', () => {
            const { ctx } = parkingContext();
            const written = [];
            const parked = Digitalstrom.prototype.parkable.call(ctx, value => written.push(value));
            ctx.pendingEvents = null;
            parked('live');
            expect(written).to.deep.equal(['live']);
        });

        // A button press replayed two minutes late would make every rule act two minutes
        // late. It is dropped instead - exactly what happened before the subscription moved
        // forward - and the scenes are re-read by resyncSceneStates() at the end.
        it('drops an action instead of catching it up later', () => {
            const { ctx } = parkingContext();
            const acted = [];
            const live = Digitalstrom.prototype.liveOnly.call(ctx, value => acted.push(value));
            ctx.pendingEvents = [];
            live('button press during the startup');
            ctx.replayStartupEvents();
            expect(acted, 'a late press must never be acted on').to.deep.equal([]);
            live('after the startup');
            expect(acted).to.deep.equal(['after the startup']);
        });

        it('drops the oldest when the parking overflows and says so', () => {
            const { ctx } = parkingContext();
            const written = [];
            const parked = Digitalstrom.prototype.parkable.call(ctx, value => written.push(value));
            ctx.pendingEvents = [];
            ctx.startupEventLimit = 2;
            parked('oldest');
            parked('middle');
            parked('newest');
            expect(ctx.pendingEventsDropped, 'exactly one was too many').to.equal(1);
            ctx.replayStartupEvents();
            expect(written, 'the newest value of a state is the one worth keeping').to.deep.equal(['middle', 'newest']);
        });

        // Regression risk of the early subscription: firing the nine subscribes a second
        // time while the first round is still in flight.
        it('does not subscribe a second time while the first is in flight', () => {
            const { ctx, pending } = parkingContext();
            ctx.startEarlyEventSubscription();
            expect(pending, 'the early attempt went out').to.have.lengthOf(1);

            let finished = 0;
            ctx.ensureEventSubscription(() => finished++);
            expect(pending, 'the authoritative attempt waits instead of subscribing again').to.have.lengthOf(1);
            expect(finished, 'and it does not report success before the dSS answered').to.equal(0);

            pending[0](null);
            expect(finished, 'the waiting caller is answered by the early result').to.equal(1);
        });

        it('subscribes again when the early attempt failed', () => {
            const { ctx, pending } = parkingContext();
            ctx.startEarlyEventSubscription();
            pending[0](new Error('dSS was busy'));

            const errs = [];
            ctx.ensureEventSubscription(err => errs.push(err));
            expect(pending, 'a failed early attempt must not decide the whole start').to.have.lengthOf(2);
            pending[1](null);
            expect(errs).to.deep.equal([null]);
        });

        // Since the subscription moved to the front, a model_ready can arrive WHILE the
        // objects are being created - a phase in which it structurally could not before.
        it('does not restart in the middle of the object creation on a model_ready', () => {
            const ctx = createContext({
                dss: new DSS({ host: 'http://127.0.0.1:1', appToken: 'x' }),
                dssStruct: { stateMap: {}, dssObjects: {}, zoneDevices: {}, apartmentStructure: { zones: [] } },
            });
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['model_ready']);
            ctx.pendingEvents = [];

            ctx.dss.emit('model_ready');
            expect(ctx.restarts, 'restarting here would loop without ever writing a value').to.deep.equal([]);
            expect(ctx.pendingModelReady, 'but it must not be forgotten either').to.equal(true);

            ctx.replayStartupEvents();
            expect(ctx.restarts, 'the structure read during that is stale, so it restarts after').to.deep.equal([
                10000,
            ]);
            ctx.dss.stop();
        });

        it('still restarts right away when the model changes during normal operation', () => {
            const ctx = createContext({
                dss: new DSS({ host: 'http://127.0.0.1:1', appToken: 'x' }),
                dssStruct: { stateMap: {}, dssObjects: {}, zoneDevices: {}, apartmentStructure: { zones: [] } },
            });
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['model_ready']);
            ctx.pendingEvents = null;

            ctx.dss.emit('model_ready');
            expect(ctx.restarts).to.deep.equal([10000]);
            ctx.dss.stop();
        });

        it('lets a poll error during the build-up subscribe again instead of restarting', () => {
            const { ctx, pending } = parkingContext();
            ctx.pendingEvents = [];
            ctx.startEarlyEventSubscription();
            ctx.failEarlyEventSubscription(new Error('event/get keeps failing'));

            const errs = [];
            ctx.ensureEventSubscription(err => errs.push(err));
            expect(pending, 'the authoritative attempt starts a fresh subscription').to.have.lengthOf(2);
            expect(ctx.restarts, 'restarting before a single value was written is a loop').to.deep.equal([]);
        });
    });

    describe('coerceStateValue', () => {
        function ctxWith(objects) {
            return createContext({ dssStruct: { dssObjects: objects, stateMap: {}, zoneDevices: {} } });
        }

        it('converts DSS strings to numbers', () => {
            const ctx = ctxWith({ 'apartment.sensors.outdoor.temperature': { common: { type: 'number' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.sensors.outdoor.temperature', '18.5')).to.equal(18.5);
            expect(coerce('apartment.sensors.outdoor.temperature', '-3')).to.equal(-3);
            expect(coerce('apartment.sensors.outdoor.temperature', 21)).to.equal(21);
        });

        it('converts DSS strings to booleans', () => {
            const ctx = ctxWith({ 'apartment.states.daynight_indoors_state': { common: { type: 'boolean' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.states.daynight_indoors_state', 'true')).to.equal(true);
            expect(coerce('apartment.states.daynight_indoors_state', 'false')).to.equal(false);
        });

        it('uses the value mapping of the object for booleans', () => {
            const ctx = ctxWith({
                'apartment.0.4.states.heating': {
                    common: { type: 'boolean' },
                    native: { valueTrue: 'active', valueFalse: 'inactive' },
                },
            });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.0.4.states.heating', 'active')).to.equal(true);
            expect(coerce('apartment.0.4.states.heating', 'inactive')).to.equal(false);
            // an unmapped value must still end up as a boolean, never as a string
            expect(coerce('apartment.0.4.states.heating', 'off')).to.equal(false);
            expect(coerce('apartment.0.4.states.heating', 'on')).to.equal(true);
        });

        // A dSS20 1.19.13 answers zone.<id>.heating with "unknown" in all eight rooms of a
        // real installation. The toBoolean fallback made that true - heating active in
        // eight rooms at once - and warned eight times on every start.
        it('writes "unknown" as null for a boolean state, without a warning', () => {
            const warnings = [];
            const ctx = createContext({
                log: { ...silentLog, warn: msg => warnings.push(String(msg)) },
                dssStruct: {
                    dssObjects: {
                        'apartment.0.4.states.heating': {
                            common: { type: 'boolean' },
                            native: { valueTrue: 'active', valueFalse: 'inactive' },
                        },
                    },
                    stateMap: {},
                    zoneDevices: {},
                },
            });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.0.4.states.heating', 'unknown'), 'neither true nor false').to.equal(null);
            expect(warnings, 'unknown is no stale vocabulary').to.deep.equal([]);
            // the next word of the dSS sets the state again
            expect(coerce('apartment.0.4.states.heating', 'active')).to.equal(true);
            expect(coerce('apartment.0.4.states.heating', 'inactive')).to.equal(false);
        });

        it('writes "unknown" as null for a boolean state without a vocabulary as well', () => {
            // status.malfunction of a group: true would announce a malfunction nobody reported
            const id = 'apartment.groups.64.states.status.malfunction';
            const ctx = ctxWith({ [id]: { common: { type: 'boolean' }, native: {} } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, id, 'unknown')).to.equal(null);
        });

        it('keeps "unknown" as text for a state that carries the wording of the dSS', () => {
            const ctx = ctxWith({ 'devices.c1.d1.states.0': { common: { type: 'string' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, 'devices.c1.d1.states.0', 'unknown')).to.equal(
                'unknown',
            );
        });

        // A user state is an on/off state in the dSS, but its object keeps the words - the
        // README names it as the exception to the null rule
        it('keeps "unknown" as text for a user state', () => {
            const id = 'apartment.userStates.x';
            const ctx = ctxWith({ [id]: { common: { type: 'string' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, id, 'unknown')).to.equal('unknown');
        });

        it('still reports a word outside the vocabulary, once', () => {
            const warnings = [];
            const ctx = createContext({
                log: { ...silentLog, warn: msg => warnings.push(String(msg)) },
                dssStruct: {
                    dssObjects: {
                        'apartment.0.4.states.heating': {
                            common: { type: 'boolean' },
                            native: { valueTrue: 'active', valueFalse: 'inactive' },
                        },
                    },
                },
            });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.0.4.states.heating', 'off')).to.equal(false);
            expect(coerce('apartment.0.4.states.heating', 'off')).to.equal(false);
            expect(warnings).to.have.lengthOf(1);
            expect(warnings[0]).to.contain('"off"').and.to.contain('apartment.0.4.states.heating');
        });

        it('converts numbers to strings for string states', () => {
            const ctx = ctxWith({ 'some.state': { common: { type: 'string' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, 'some.state', 5)).to.equal('5');
        });

        it('keeps null and undefined and passes unknown ids through', () => {
            const ctx = ctxWith({ 'a.number': { common: { type: 'number' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('a.number', null)).to.equal(null);
            expect(coerce('a.number', undefined)).to.equal(undefined);
            expect(coerce('unknown.id', 'text')).to.equal('text');
        });

        it('maps a non numeric string to null instead of NaN', () => {
            const ctx = ctxWith({ 'a.number': { common: { type: 'number' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, 'a.number', 'n/a')).to.equal(null);
        });

        it('converts only the value of a state object with timestamp', () => {
            // The outdoor sensors bring their own DSS timestamp as { val, ts }
            const ctx = ctxWith({ 'apartment.sensors.outdoor.humidity': { common: { type: 'number' } } });
            const res = Digitalstrom.prototype.coerceStateValue.call(ctx, 'apartment.sensors.outdoor.humidity', {
                val: '54.4',
                ts: 1700000000000,
            });
            expect(res).to.deep.equal({ val: 54.4, ts: 1700000000000 });
        });
    });

    describe('state changes during unload', () => {
        function changeContext() {
            const handled = [];
            return createContext({
                objectHelper: { handleStateChange: (id, state) => handled.push([id, state.val]) },
                handled,
            });
        }

        it('forwards a state change before the stop', () => {
            const ctx = changeContext();
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled).to.deep.equal([['digitalstrom.0.x', 5]]);
        });

        it('does not turn a null into a command', () => {
            // objectHelper makes false of it for a boolean state (!!null), and the write
            // handler would send "inactive" to the dSS
            const ctx = changeContext();
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.apartment.0.4.states.heating', {
                val: null,
                ack: false,
            });
            expect(ctx.handled).to.deep.equal([]);
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.apartment.0.4.states.heating', {
                val: false,
                ack: false,
            });
            expect(ctx.handled, 'a real false still is a command').to.deep.equal([
                ['digitalstrom.0.apartment.0.4.states.heating', false],
            ]);
        });

        // Regression: the echo arrives as "digitalstrom.0.devices.X.PowerConsumption", the
        // structure tracks "devices.X.PowerConsumption". Stored under the full id, a value
        // another adapter wrote was never seen, and a skipped poll left it standing.
        it('tracks a foreign write under the id the structure uses', async () => {
            const DSSStructure = require('../lib/dssStructure');
            const writes = [];
            const struct = /** @type {any} */ (
                new DSSStructure({
                    dss: {},
                    dssQueue: {
                        pushQueryQueue: (dSUID, entryId, entry, prio, callback) =>
                            setImmediate(() =>
                                callback(null, { ok: true, result: { consumption: 0, meterValue: 3600000 } }),
                            ),
                    },
                    adapter: {
                        log: silentLog,
                        config: {},
                        setState: () => {},
                        setDssState: (id, value) => {
                            writes.push([id, value]);
                            struct.notePublishedValue(id, value);
                        },
                    },
                })
            );
            struct.apartmentCircuits = [{ hasMetering: true, dSUID: 'meter1' }];
            struct.objectsReady = true;
            const ctx = changeContext();
            ctx.namespace = 'digitalstrom.0';
            ctx.dssStruct = struct;
            const poll = () => new Promise(resolve => struct.updateMeterData(() => resolve(undefined)));

            await poll();
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.devices.meter1.PowerConsumption', {
                val: 999,
                ack: true,
            });
            expect(struct.publishedValues.has('digitalstrom.0.devices.meter1.PowerConsumption')).to.equal(false);
            await poll();
            expect(writes.filter(w => w[0] === 'devices.meter1.PowerConsumption')).to.deep.equal([
                ['devices.meter1.PowerConsumption', 0],
                ['devices.meter1.PowerConsumption', 0],
            ]);
        });

        it('logs a command at debug and an acknowledged value at silly', () => {
            const ctx = changeContext();
            /** @type {string[][]} */
            const lines = [];
            ctx.log = {
                ...silentLog,
                silly: msg => lines.push(['silly', String(msg)]),
                debug: msg => lines.push(['debug', String(msg)]),
            };
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.info.apiActivity', { val: '{}', ack: true });
            expect(lines).to.deep.equal([
                ['debug', 'state digitalstrom.0.x changed: 5 (ack = false)'],
                ['silly', 'state digitalstrom.0.info.apiActivity changed: {} (ack = true)'],
            ]);
        });

        it('ignores a state change while the adapter is stopping', () => {
            const ctx = changeContext();
            ctx.stopping = true;
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled, 'no new command may be started during the unload').to.deep.equal([]);
        });

        it('ignores a state change after the adapter stopped', () => {
            const ctx = changeContext();
            ctx.stopping = true;
            ctx.stopped = true;
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled).to.deep.equal([]);
        });

        it('stops the queue during the unload instead of only clearing it', done => {
            const DSSQueue = require('../lib/dssQueue');
            const queue = new DSSQueue({
                logger: silentLog,
                prioTimeouts: { high: 1, medium: 2, low: 3 },
                dss: { requestAsync: async () => ({ ok: true }) },
            });
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = createContext({
                dss,
                dssQueue: queue,
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 20,
            });
            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(queue.stopped, 'the queue must be closed after the unload').to.equal(true);
                // a late command must not reach the already closed DSS client
                queue.pushQueryQueue(
                    'c1',
                    'late',
                    { dssClass: 'zone', dssFunction: 'callScene', params: {} },
                    'high',
                    err => {
                        expect(err.shutdown).to.equal(true);
                        done();
                    },
                );
            });
        });
    });

    describe('deleteUnknownObjects safety', () => {
        function deleteContext(configValue) {
            const deleted = [];
            const ctx = createContext({
                config: { deleteUnknownObjects: configValue },
                objectHelper: { existingStates: { 'devices.a.b': {}, 'devices.c.d': {} } },
                delObject: (id, cb) => {
                    deleted.push(id);
                    cb(null);
                },
                clearAdditionalObjects: Digitalstrom.prototype.clearAdditionalObjects,
            });
            ctx.deleted = deleted;
            return ctx;
        }

        // Everything that is not unambiguously true must keep the objects
        const mustNotDelete = [
            ['boolean false', false],
            ['string "false"', 'false'],
            ['string "0"', '0'],
            ['string "no"', 'no'],
            ['string "off"', 'off'],
            ['empty string', ''],
            ['whitespace', '   '],
            ['null', null],
            ['undefined', undefined],
            ['object', {}],
            ['invalid string', 'vielleicht'],
            ['number 0', 0],
        ];

        mustNotDelete.forEach(([label, value]) => {
            it(`keeps the objects for ${label}`, done => {
                const ctx = deleteContext(value);
                ctx.clearAdditionalObjects(() => {
                    expect(ctx.deleted, `${label} must never delete objects`).to.deep.equal([]);
                    done();
                });
            });
        });

        [
            ['boolean true', true],
            ['string "true"', 'true'],
            ['number 1', 1],
        ].forEach(([label, value]) => {
            it(`deletes the objects only for ${label}`, done => {
                const ctx = deleteContext(value);
                ctx.clearAdditionalObjects(() => {
                    expect(ctx.deleted).to.deep.equal(['devices.a.b', 'devices.c.d']);
                    done();
                });
            });
        });
    });

    describe('normalizeConfig', () => {
        function configContext(config) {
            const warnings = [];
            return createContext({
                config,
                warnings,
                log: { ...silentLog, warn: msg => warnings.push(String(msg)) },
                normalizeConfig: Digitalstrom.prototype.normalizeConfig,
            });
        }

        it('turns the string "false" into a real false', () => {
            const ctx = configContext({
                deleteUnknownObjects: 'false',
                initializeOutputValues: 'false',
                usePresetValues: 'false',
                validateCertificate: 'false',
            });
            ctx.normalizeConfig();
            expect(ctx.config.deleteUnknownObjects).to.equal(false);
            expect(ctx.config.initializeOutputValues).to.equal(false);
            expect(ctx.config.usePresetValues).to.equal(false);
            expect(ctx.config.validateCertificate).to.equal(false);
            expect(ctx.warnings, 'a clean string value needs no warning').to.deep.equal([]);
        });

        it('applies the documented defaults when values are missing', () => {
            const ctx = configContext({});
            ctx.normalizeConfig();
            expect(ctx.config.usePresetValues, 'default true').to.equal(true);
            expect(ctx.config.initializeOutputValues, 'default true').to.equal(true);
            expect(ctx.config.deleteUnknownObjects, 'destructive - default false').to.equal(false);
            expect(ctx.config.validateCertificate, 'documented default false').to.equal(false);
            expect(ctx.warnings, 'missing values are normal, no warning').to.deep.equal([]);
        });

        it('warns about uninterpretable values instead of failing silently', () => {
            const ctx = configContext({ validateCertificate: 'vielleicht', deleteUnknownObjects: {} });
            ctx.normalizeConfig();
            expect(ctx.config.validateCertificate).to.equal(false);
            expect(ctx.config.deleteUnknownObjects).to.equal(false);
            expect(ctx.warnings).to.have.lengthOf(2);
            expect(ctx.warnings.join('\n')).to.contain('validateCertificate');
            expect(ctx.warnings.join('\n')).to.contain('deleteUnknownObjects');
        });

        it('counts a named vDC channel read as an output read', () => {
            // The classic reads of a vDC device are called getOutputChannelValue2 and were
            // sorted into no counter at all: on an installation with Sonos players the
            // status tab showed "classic" next to 0 reads while 136 of them were running.
            const counted = [];
            const ctx = createContext({ apiActivity: { count: metric => counted.push(metric) } });
            const count = Digitalstrom.prototype.countClassicActivity.bind(ctx);

            count('request', '/json/device/getOutputChannelValue2?dsuid=abc');
            count('request', '/json/device/getOutputChannelValue?dsuid=abc&offset=0');
            count('request', '/json/device/getOutputValue?dsuid=abc&offset=0');
            count('request', '/json/metering/getValues?type=consumption');
            count('request', '/json/zone/callScene?id=4&sceneNumber=5');

            const outputReads = counted.filter(m => m === 'classic.outputReads').length;
            expect(outputReads, 'all three spellings of an output read count').to.equal(3);
            expect(counted.filter(m => m === 'classic.meterReads')).to.have.lengthOf(1);
            expect(counted.filter(m => m === 'classic.commands')).to.have.lengthOf(1);
            expect(counted.filter(m => m === 'classic.requests')).to.have.lengthOf(5);
        });

        it('keeps real booleans untouched', () => {
            const ctx = configContext({
                deleteUnknownObjects: true,
                usePresetValues: false,
                validateCertificate: true,
            });
            ctx.normalizeConfig();
            expect(ctx.config.deleteUnknownObjects).to.equal(true);
            expect(ctx.config.usePresetValues).to.equal(false);
            expect(ctx.config.validateCertificate).to.equal(true);
            expect(ctx.warnings).to.deep.equal([]);
        });
    });

    describe('invalid host handling', () => {
        // Every one of these makes the DSS constructor throw synchronously
        const invalidHosts = [
            ['empty', ''],
            ['whitespace', '   '],
            ['null', null],
            ['undefined', undefined],
            ['object instead of string', { host: '1.2.3.4' }],
            ['unsupported scheme', 'ftp://192.168.1.10'],
            ['with path', 'https://192.168.1.10/path'],
            ['with credentials', 'https://user:password@192.168.1.10'],
            ['with query string', 'https://192.168.1.10?a=b'],
            ['with fragment', 'https://192.168.1.10#x'],
            ['invalid port', 'https://192.168.1.10:notaport'],
            ['incomplete IPv6', 'https://[2001:db8'],
        ];

        invalidHosts.forEach(([label, host]) => {
            it(`buildBaseUrl rejects ${label}`, () => {
                expect(() => DSS.buildBaseUrl(/** @type {string} */ (host))).to.throw();
            });
        });

        describe('adapter start', () => {
            function startContext(host) {
                const log = {
                    ...silentLog,
                    /** @type {string[]} */
                    errors: [],
                    /**
                     * @param {unknown} msg
                     */
                    error(msg) {
                        // Reads the property instead of a captured array, so a test may
                        // replace log.errors before it runs
                        log.errors.push(String(msg));
                    },
                };
                return createContext({
                    // A real DSS app token is a long hex string - a placeholder would trigger
                    // the plausibility check of main() and produce an extra error line
                    config: { host, appToken: VALID_APP_TOKEN },
                    errors: log.errors,
                    log,
                    objectHelper: { loadExistingObjects: cb => cb() },
                    normalizePollInterval: Digitalstrom.normalizePollInterval,
                    // main() fragt den Client der neuen API an. Ohne konfigurierten
                    // Schalter liefert die Methode null, der Start laeuft also wie bisher.
                    createSmartHomeClient: Digitalstrom.prototype.createSmartHomeClient,
                });
            }

            invalidHosts.forEach(([label, host]) => {
                it(`does not throw on start with ${label}`, () => {
                    const ctx = startContext(host);
                    ctx.log.errors = [];
                    ctx.errors = ctx.log.errors;
                    expect(() => Digitalstrom.prototype.main.call(ctx)).to.not.throw();
                    // no DSS client, no timers, no restart loop. An empty host is already
                    // rejected by the config check before the client is built, so dss stays unset.
                    expect(
                        ctx.dss === null || ctx.dss === undefined,
                        'no half initialized client must be kept',
                    ).to.equal(true);
                    expect(ctx.startupTimeout, 'no watchdog timer must be started').to.equal(undefined);
                    expect(ctx.restarts, 'an invalid host must not trigger a restart loop').to.deep.equal([]);
                    expect(ctx.states['info.connection'], 'connection must be reported as false').to.equal(false);
                });
            });

            it('logs a helpful error without leaking the app token', () => {
                const ctx = startContext('ftp://192.168.1.10');
                ctx.log.errors = [];
                // Same shape as a real token so only the host error is reported
                ctx.config.appToken = 'deadbeef'.repeat(8);
                Digitalstrom.prototype.main.call(ctx);
                expect(ctx.log.errors).to.have.lengthOf(1);
                expect(ctx.log.errors[0]).to.contain('only https and http are supported');
                expect(ctx.log.errors[0]).to.not.contain('deadbeef');
            });

            // A token js-controller could not decrypt comes back as garbage. Without this
            // check the user would only see "Login failed" and had no idea what to do.
            it('warns about a token that could not be read back', () => {
                const ctx = startContext('192.168.1.10');
                ctx.log.errors = [];
                ctx.config.appToken = '\u0012\u00a4garbled-token\u0099';
                Digitalstrom.prototype.main.call(ctx);
                const hint = ctx.log.errors.find(msg => msg.includes('does not look like a valid'));
                expect(hint, 'the user must get an actionable message').to.be.a('string');
                expect(hint).to.contain('enter the App-Token again');
                // The login is still attempted, the check never blocks the start
                expect(ctx.dss, 'the client must still be created').to.not.equal(null);
                ctx.dss.stop();
                clearTimeout(ctx.startupTimeout);
                // main() armed the activity publisher - on the bare ctx it would fire
                // into nothing and crash the mocha process 30 s after the suite
                clearInterval(ctx.apiActivityTimer);
            });

            it('accepts a real looking app token without complaining', () => {
                expect(Digitalstrom.looksLikeAppToken('deadbeef'.repeat(8))).to.equal(true);
                expect(Digitalstrom.looksLikeAppToken('ABCDEF0123456789'.repeat(2))).to.equal(true);
                expect(Digitalstrom.looksLikeAppToken('garbled token'), 'spaces are impossible').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken('abc'), 'too short').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken(''), 'empty').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken(undefined)).to.equal(false);
            });

            it('starts normally with a valid host', () => {
                const ctx = startContext('192.168.1.10');
                ctx.log.errors = [];
                Digitalstrom.prototype.main.call(ctx);
                expect(ctx.dss, 'a valid host must create the client').to.not.equal(null);
                expect(ctx.log.errors).to.deep.equal([]);
                ctx.dss.stop();
                clearTimeout(ctx.startupTimeout);
                clearInterval(ctx.apiActivityTimer);
            });
        });

        describe('createAppToken message', () => {
            function messageContext(host) {
                const answers = [];
                const ctx = createContext({
                    config: {},
                    log: { ...silentLog },
                    sendTo: (from, command, result, callback) => answers.push({ from, command, result, callback }),
                });
                ctx.answers = answers;
                ctx.msg = {
                    command: 'createAppToken',
                    from: 'system.adapter.admin.0',
                    callback: { id: 1 },
                    message: { host, username: 'user', password: 'p@ss"\\word' },
                };
                return ctx;
            }

            invalidHosts.forEach(([label, host]) => {
                it(`answers the admin dialog instead of crashing with ${label}`, () => {
                    const ctx = messageContext(host);
                    expect(() => Digitalstrom.prototype.onMessage.call(ctx, ctx.msg)).to.not.throw();
                    expect(ctx.answers, 'the dialog must always get an answer').to.have.lengthOf(1);
                    expect(ctx.answers[0].result).to.have.property('error');
                    expect(ctx.answers[0].callback).to.deep.equal({ id: 1 });
                    // the password must never end up in the answer
                    expect(JSON.stringify(ctx.answers[0].result)).to.not.contain('p@ss');
                });
            });

            it('does not log the username or password', () => {
                const logged = [];
                const ctx = messageContext('ftp://192.168.1.10');
                ['silly', 'debug', 'info', 'warn', 'error'].forEach(level => {
                    ctx.log[level] = msg => logged.push(String(msg));
                });
                Digitalstrom.prototype.onMessage.call(ctx, ctx.msg);
                const all = logged.join('\n');
                expect(all).to.not.contain('p@ss');
                expect(all, 'the username is part of the credentials').to.not.contain('user');
            });
        });
    });

    describe('registerObjects', () => {
        it('converts the initial value to the declared type of the object', () => {
            const created = [];
            const dssObjects = {
                'apartment.0.4.states.heating': {
                    type: 'state',
                    common: { type: 'boolean', role: 'indicator' },
                    native: { valueTrue: 'active', valueFalse: 'inactive' },
                    value: 'inactive',
                },
                'apartment.sensors.outdoor.temperature': {
                    type: 'state',
                    common: { type: 'number', role: 'value.temperature' },
                    native: {},
                    value: { val: '18.5', ts: 42 },
                },
            };
            const ctx = createContext({
                dssStruct: { dssObjects },
                objectHelper: {
                    setOrUpdateObject: (id, obj, preserve, value) => created.push([id, value]),
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            expect(created).to.deep.equal([
                ['apartment.0.4.states.heating', false],
                ['apartment.sensors.outdoor.temperature', { val: 18.5, ts: 42 }],
            ]);
            // value/onChange must not end up in the created object
            expect(dssObjects['apartment.0.4.states.heating']).to.not.have.property('value');
        });

        // Production export: 274 states had no common.write at all - the Hue channels,
        // the Sonos, the indoor channels of a GR-KL300, every device sensor, the outdoor
        // sensors and buttonClickType. The admin offered to edit them, nothing handled it.
        it('derives common.write from the write handler when the definition leaves it open', () => {
            const created = {};
            const handler = () => {};
            const dssObjects = {
                'devices.m1.hue1.hue': {
                    type: 'state',
                    common: { type: 'number', role: 'level.color.hue' },
                    native: {},
                },
                'devices.m1.ge1.brightness': {
                    type: 'state',
                    common: { type: 'number', role: 'level.brightness' },
                    native: {},
                    onChange: handler,
                },
                // dSS computed indicator: declared read-only, the handler only serves scripts
                'apartment.states.presence': {
                    type: 'state',
                    common: { type: 'boolean', role: 'indicator', read: true, write: false },
                    native: {},
                    onChange: handler,
                },
                'devices.m1.ge1': { type: 'device', common: { name: 'Licht' } },
            };
            const ctx = createContext({
                dssStruct: { dssObjects },
                objectHelper: {
                    setOrUpdateObject: (id, obj, preserve, value, onChange) => {
                        created[id] = { common: { ...obj.common }, onChange };
                    },
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            expect(created['devices.m1.hue1.hue'].common.write, 'no handler - read-only').to.equal(false);
            expect(created['devices.m1.ge1.brightness'].common.write).to.equal(true);
            expect(created['devices.m1.ge1.brightness'].onChange, 'the handler still reaches the helper').to.equal(
                handler,
            );
            expect(created['apartment.states.presence'].common.write, 'an explicit flag stays').to.equal(false);
            expect(created['devices.m1.ge1'].common, 'only states carry the flag').to.not.have.property('write');
        });

        // The handler of a light, a shade or a single channel device is hung onto the
        // generic output channel AFTER addStateObject - deciding the flag any earlier would
        // freeze it at false, because the objectHelper keeps an explicit value
        it('gives a real device structure an explicit and correct flag on every state', async () => {
            const DSSStructure = require('../lib/dssStructure');
            const EventEmitter = require('node:events');
            const struct = new DSSStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (d, i, l, v, p, cb) => setImmediate(() => cb && cb(null, v)),
                    queueUpdateOutputValue: (d, i, l, p, cb) => setImmediate(() => cb && cb(null, 0)),
                    queueReadOutputChannels: (d, p, cb) => setImmediate(() => cb && cb(null, {})),
                    pushQueryQueue: (...args) => {
                        const cb = args[args.length - 1];
                        setImmediate(() => cb && cb(null, { ok: true }));
                    },
                },
                adapter: { log: silentLog, config: { initializeOutputValues: false, usePresetValues: false } },
            });
            const device = (dSUID, hwInfo, channels, extra = {}) => ({
                dSUID,
                meterDSUID: 'm1',
                zoneID: 5,
                name: dSUID,
                hwInfo,
                isValid: true,
                isPresent: true,
                outputMode: 22,
                outputChannels: channels.map((channelId, index) => ({
                    channelId,
                    channelType: channelId,
                    channelIndex: index,
                })),
                ...extra,
            });
            const devices = [
                device(
                    'hue1',
                    'Extended color light: LCG002',
                    ['brightness', 'hue', 'saturation', 'colortemp', 'x', 'y'],
                    {
                        isVdcDevice: true,
                    },
                ),
                device('lwv1', 'Dimmable light: LWV001', ['brightness'], { isVdcDevice: true }),
                device('ge1', 'GE-KM200', ['brightness']),
                device(
                    'gr1',
                    'GR-KL300',
                    [
                        'shadePositionOutside',
                        'shadeOpeningAngleOutside',
                        'shadePositionIndoor',
                        'shadeOpeningAngleIndoor',
                    ],
                    {
                        sensorInputCount: 2,
                        sensors: [
                            { type: 4, valid: true, value: 3 },
                            // Room Temperature Set Point: the value of the device, not the set point of the room
                            { type: 50, valid: true, value: 21 },
                        ],
                    },
                ),
                device('sw1', 'SW-KL200', ['powerLevel'], { buttonInputCount: 1 }),
            ];
            for (const dev of devices) {
                await new Promise(resolve => struct.createDevice(dev, resolve));
            }
            const created = {};
            const ctx = createContext({
                dssStruct: struct,
                objectHelper: {
                    setOrUpdateObject: (id, obj, preserve, value, onChange) => {
                        created[id] = { common: { ...obj.common }, onChange };
                    },
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            const write = id => created[`devices.m1.${id}`].common.write;
            ['brightness', 'hue', 'saturation', 'colortemp', 'x', 'y'].forEach(channel =>
                expect(write(`hue1.${channel}`), `multi channel vDC ${channel}`).to.equal(false),
            );
            expect(write('lwv1.brightness'), 'single channel device').to.equal(true);
            expect(write('ge1.brightness'), 'light').to.equal(true);
            expect(write('ge1.state')).to.equal(true);
            expect(write('gr1.shadePositionOutside'), 'shade').to.equal(true);
            expect(write('gr1.shadeOpeningAngleOutside')).to.equal(true);
            expect(write('gr1.shadePositionIndoor'), 'no handler for the indoor channels').to.equal(false);
            expect(write('gr1.shadeOpeningAngleIndoor')).to.equal(false);
            expect(write('gr1.sensors.0'), 'device sensor').to.equal(false);
            expect(created['devices.m1.gr1.sensors.1'].common.role).to.equal('level.temperature');
            expect(write('gr1.sensors.1'), 'a set point reported by a device').to.equal(false);
            expect(write('sw1.powerLevel'), 'joker output without handler').to.equal(false);
            expect(write('sw1.buttonClickType')).to.equal(false);

            Object.keys(created)
                .filter(id => struct.dssObjects[id].type === 'state')
                .forEach(id => {
                    const { common, onChange } = created[id];
                    expect(common.write, `${id} needs an explicit flag`).to.be.a('boolean');
                    // A writable state nobody handles would swallow every write silently
                    if (common.write) {
                        expect(onChange, `${id} is writable without a handler`).to.be.a('function');
                    }
                });
            struct.clearTimeouts();
        });

        it('replaces a stored name only when it is the old dSS escaping of the current one', () => {
            const preserved = {};
            const infos = [];
            // Measured on a real installation: three circuit folders were named
            // "Schlafen &amp; Bad" while getCircuits delivers "Schlafen & Bad"
            const ctx = createContext({
                log: { ...silentLog, info: msg => infos.push(String(msg)) },
                dssStruct: {
                    dssObjects: {
                        'devices.m1': { type: 'folder', common: { name: 'Schlafen & Bad' } },
                        'devices.m2': { type: 'folder', common: { name: 'Keller & Heizung' } },
                        'devices.m3': { type: 'folder', common: { name: 'Küche' } },
                        'devices.m4': { type: 'folder', common: { name: 'Büro & Duschbad' } },
                        'apartment.0.5': { type: 'folder', common: { name: "Eltern's Zimmer" } },
                    },
                },
                objectHelper: {
                    existingStates: {
                        'devices.m1': { type: 'folder', common: { name: 'Schlafen &amp; Bad' } },
                        // renamed by the user - must survive
                        'devices.m2': { type: 'folder', common: { name: 'Heizungskeller' } },
                        'devices.m3': { type: 'folder', common: { name: 'Küche' } },
                        // devices.m4 is new
                        'apartment.0.5': { type: 'folder', common: { name: 'Eltern&#039;s Zimmer' } },
                    },
                    setOrUpdateObject: (id, obj, keep) => (preserved[id] = keep),
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            expect(preserved).to.deep.equal({
                'devices.m1': [],
                'devices.m2': ['name'],
                'devices.m3': ['name'],
                'devices.m4': ['name'],
                'apartment.0.5': [],
            });
            expect(infos.filter(msg => msg.includes('corrected'))).to.have.lengthOf(2);
            expect(infos.join('\n')).to.contain('"Schlafen &amp; Bad" to "Schlafen & Bad"');
        });
    });

    describe('names the dSS still delivers with HTML codes', () => {
        // Measured on a real installation with 2.4.26: the three circuit folders still read
        // "Büro &amp; Duschbad" after the start and no "corrected" line was logged. The
        // repair compared the stored name with what getCircuits answered - the very same
        // escaped text - and found nothing to do.
        it('repairs a stored name when getCircuits answers with the same codes', () => {
            const DSSStructure = require('../lib/dssStructure');
            const struct = /** @type {any} */ (
                new DSSStructure({ dss: {}, dssQueue: {}, adapter: { log: silentLog, config: {} } })
            );
            struct.addFolderObject('devices.m1', 'Büro &amp; Duschbad');
            struct.addFolderObject('devices.m2', 'Wohnen, Flur &amp; Garten');
            const preserved = {};
            const infos = [];
            const ctx = createContext({
                log: { ...silentLog, info: msg => infos.push(String(msg)) },
                dssStruct: struct,
                objectHelper: {
                    existingStates: {
                        'devices.m1': { type: 'folder', common: { name: 'Büro &amp; Duschbad' } },
                        // renamed by the user - must survive
                        'devices.m2': { type: 'folder', common: { name: 'Wohnzimmer' } },
                    },
                    setOrUpdateObject: (id, obj, keep) => (preserved[id] = [keep, obj.common.name]),
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            expect(preserved).to.deep.equal({
                'devices.m1': [[], 'Büro & Duschbad'],
                'devices.m2': [['name'], 'Wohnen, Flur & Garten'],
            });
            expect(infos).to.contain('Name of devices.m1 corrected from "Büro &amp; Duschbad" to "Büro & Duschbad"');
        });
    });

    describe('isDssEscapedName', () => {
        it('decodes exactly what escapeHTML() of the dSS produced, in one pass', () => {
            expect(Digitalstrom.decodeDssEntities('Wohnen, Flur &amp; Garten')).to.equal('Wohnen, Flur & Garten');
            expect(Digitalstrom.decodeDssEntities('&quot;a&quot; &#039;b&#039; &lt;c&gt;')).to.equal(`"a" 'b' <c>`);
            expect(Digitalstrom.decodeDssEntities('&amp;lt;'), 'a literal "&lt;" stays one').to.equal('&lt;');
            expect(Digitalstrom.decodeDssEntities('A&nbsp;B'), 'the dSS never produced it').to.equal('A&nbsp;B');
            expect(Digitalstrom.decodeDssEntities('Küche')).to.equal('Küche');
        });

        it('only accepts the escaped form of the current name', () => {
            expect(Digitalstrom.isDssEscapedName('Schlafen &amp; Bad', 'Schlafen & Bad')).to.equal(true);
            expect(Digitalstrom.isDssEscapedName('Schlafen &amp; Bad Scenes', 'Schlafen & Bad Scenes')).to.equal(true);
            expect(Digitalstrom.isDssEscapedName('Schlafen & Bad', 'Schlafen & Bad'), 'already right').to.equal(false);
            expect(Digitalstrom.isDssEscapedName('Mein Bad', 'Schlafen & Bad'), 'user rename').to.equal(false);
            expect(Digitalstrom.isDssEscapedName('A & B', 'A &amp; B'), 'never towards the entity').to.equal(false);
            expect(Digitalstrom.isDssEscapedName({ de: 'Bad &amp; WC' }, 'Bad & WC'), 'translated').to.equal(false);
            expect(Digitalstrom.isDssEscapedName(undefined, 'Bad & WC'), 'new object').to.equal(false);
        });
    });

    describe('setInitialValues', () => {
        it('writes null for a state the dSS reports as unknown instead of skipping it', done => {
            const written = [];
            const ctx = createContext({
                dssStruct: {
                    dssObjects: {
                        'apartment.0.4.states.heating': {
                            common: { type: 'boolean' },
                            native: { valueTrue: 'active', valueFalse: 'inactive' },
                        },
                    },
                    initialObjectValues: { 'apartment.0.4.states.heating': 'unknown' },
                },
                setInitialValues: Digitalstrom.prototype.setInitialValues,
                setState(id, value, ack, cb) {
                    written.push([id, value, ack]);
                    cb && cb();
                },
            });
            ctx.setInitialValues(() => {
                // This is the only write at startup: objectHelper does not write a null
                // initial value, and it replaces the true of the earlier versions
                expect(written).to.deep.equal([['apartment.0.4.states.heating', null, true]]);
                done();
            });
        });
    });

    describe('event handlers', () => {
        function subscribedContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            // no real polling in this test
            dss.pollChannel = () => {};

            const ctx = createContext({
                dss,
                dssStruct: {
                    stateMap: {
                        'dev1.0.button': 'devices.m1.dev1.button',
                        'dev1.0.buttonClickType': 'devices.m1.dev1.buttonClickType',
                        'dev1.0.buttonHoldCount': 'devices.m1.dev1.buttonHoldCount',
                    },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        it('keeps clickType 0 instead of turning it into -1', done => {
            const { ctx, dss } = subscribedContext();
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err).to.equal(null);
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: { clickType: 0, holdCount: 0 },
                });
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'clickType 0 must stay 0').to.equal(0);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount']).to.equal(0);
                dss.stop();
                done();
            });
        });

        it('writes zone sensor values as numbers, not as DSS strings', done => {
            const { ctx, dss } = subscribedContext();
            ctx.dssStruct.stateMap['4.sensors.9'] = 'apartment.0.4.sensors.TemperatureValue';
            ctx.dssStruct.dssObjects['apartment.0.4.sensors.TemperatureValue'] = { common: { type: 'number' } };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                dss.emit('zoneSensorValue', {
                    name: 'zoneSensorValue',
                    source: { zoneID: '4' },
                    properties: { sensorType: '9', sensorValueFloat: '21.5' },
                });
                expect(ctx.states['apartment.0.4.sensors.TemperatureValue']).to.equal(21.5);
                dss.stop();
                done();
            });
        });

        it('writes null for a zone state the dSS reports as unknown, and true for the next active', done => {
            const { ctx, dss } = subscribedContext();
            ctx.dssStruct.stateMap['zone.4.heating'] = 'apartment.0.4.states.heating';
            ctx.dssStruct.dssObjects['apartment.0.4.states.heating'] = {
                common: { type: 'boolean' },
                native: { valueTrue: 'active', valueFalse: 'inactive' },
            };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                const emit = (state, value) =>
                    dss.emit('stateChange', {
                        name: 'stateChange',
                        properties: { statename: 'zone.4.heating', state, value, oldvalue: '2' },
                    });
                emit('unknown', '3');
                expect(ctx.states, 'null is written, not dropped as "no value"').to.have.property(
                    'apartment.0.4.states.heating',
                    null,
                );
                emit('active', '1');
                expect(ctx.states['apartment.0.4.states.heating']).to.equal(true);
                dss.stop();
                done();
            });
        });

        it('still maps a missing clickType to -1', done => {
            const { ctx, dss } = subscribedContext();
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: {},
                });
                expect(ctx.states['devices.m1.dev1.buttonClickType']).to.equal(-1);
                dss.stop();
                done();
            });
        });

        it('maps a passiveCooling change to its boolean state', done => {
            const { ctx, dss } = subscribedContext();
            const id = 'apartment.0.4.states.passiveCooling';
            const { native, ...common } = dssConstants.zoneSensorStateRoleMap.passiveCooling;
            ctx.dssStruct.stateMap['zone.zone4.group0.type9.passiveCooling'] = id;
            ctx.dssStruct.dssObjects[id] = { common, native };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                // The event exactly as a dSS20 1.19.13 sent it when the room crossed 22 °C
                const emit = (state, value, oldvalue) =>
                    dss.emit('stateChange', {
                        name: 'stateChange',
                        properties: {
                            callOrigin: '9',
                            oldvalue,
                            value,
                            statename: 'zone.zone4.group0.type9.passiveCooling',
                            state,
                        },
                        source: {},
                    });
                emit('active', '1', '2');
                expect(ctx.states[id]).to.equal(true);
                emit('inactive', '2', '1');
                expect(ctx.states[id]).to.equal(false);
                expect(ctx.unmappedBooleanStates.size, 'the vocabulary matches').to.equal(0);
                dss.stop();
                done();
            });
        });

        it('names an unknown state once at info, then at debug', done => {
            const { ctx, dss } = subscribedContext();
            /** @type {string[]} */
            const infos = [];
            /** @type {string[]} */
            const debugs = [];
            ctx.log = {
                ...silentLog,
                info: msg => infos.push(String(msg)),
                debug: msg => debugs.push(String(msg)),
            };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                const emit = (statename, state) =>
                    dss.emit('stateChange', {
                        name: 'stateChange',
                        properties: { callOrigin: '9', statename, state },
                        source: {},
                    });
                emit('zone.zone4.group0.type9.passiveCooling', 'active');
                emit('zone.zone4.group0.type9.passiveCooling', 'inactive');
                const first = infos.filter(msg => msg.includes('zone.zone4.group0.type9.passiveCooling'));
                expect(first, 'the first change names the state').to.have.length(1);
                expect(first[0]).to.include('Unhandled State Change');
                // A state the dSS added while the adapter runs gets its object at the next
                // start - the line says so before it asks for an issue
                expect(first[0]).to.include('next start');
                expect(first[0].indexOf('next start')).to.be.below(first[0].indexOf('GitHub issue'));
                // eventLog() writes every event at debug as well, so only the log line counts
                expect(
                    debugs.filter(msg => msg.startsWith('Unhandled State Change: zone.zone4.')),
                    'the repeat goes to debug',
                ).to.have.length(1);
                emit('zone.zone2.group0.type9.passiveCooling', 'active');
                expect(
                    infos.filter(msg => msg.includes('zone.zone2.group0.type9.passiveCooling')),
                    'a different name gets its own line',
                ).to.have.length(1);
                expect(infos.filter(msg => msg.includes('Unhandled State Change'))).to.have.length(2);
                dss.stop();
                done();
            });
        });

        it('keeps helper states of addons at debug', done => {
            const { ctx, dss } = subscribedContext();
            /** @type {string[]} */
            const infos = [];
            /** @type {string[]} */
            const debugs = [];
            ctx.log = {
                ...silentLog,
                info: msg => infos.push(String(msg)),
                debug: msg => debugs.push(String(msg)),
            };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                dss.emit('addonStateChange', {
                    name: 'addonStateChange',
                    properties: {
                        statename: '9be5e52c9e465cd880b6b06494f9dcf600_open-tilded',
                        state: 'inactive',
                        scriptID: 'system-addon-user-defined-states-helper',
                    },
                });
                // The climate control raises "queue-active" at each of its switch times
                dss.emit('addonStateChange', {
                    name: 'addonStateChange',
                    properties: {
                        statename: 'queue-active',
                        state: 'active',
                        scriptID: 'system-addon-heating-controller',
                    },
                });
                expect(infos.filter(msg => msg.includes('Unhandled State Change'))).to.deep.equal([]);
                expect(debugs.filter(msg => msg.startsWith('Unhandled State Change: '))).to.have.length(2);
                dss.stop();
                done();
            });
        });

        // Measured on a real installation: the climate control reported the mode of the
        // bathroom as "operationmode.3.NotUsed" twice a day, and only a debug log showed it
        it('names any other unknown addon state once at info', done => {
            const { ctx, dss } = subscribedContext();
            /** @type {string[]} */
            const infos = [];
            /** @type {string[]} */
            const debugs = [];
            ctx.log = {
                ...silentLog,
                info: msg => infos.push(String(msg)),
                debug: msg => debugs.push(String(msg)),
            };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                const emit = state =>
                    dss.emit('addonStateChange', {
                        name: 'addonStateChange',
                        properties: {
                            statename: 'operationmode.3.NotUsed',
                            state,
                            scriptID: 'system-addon-heating-controller',
                        },
                    });
                emit('active');
                emit('inactive');
                expect(infos.filter(msg => msg.includes('operationmode.3.NotUsed'))).to.have.length(1);
                expect(debugs.filter(msg => msg === 'Unhandled State Change: operationmode.3.NotUsed')).to.have.length(
                    1,
                );
                dss.stop();
                done();
            });
        });

        it('knows the helper states of the addons by name', () => {
            expect(Digitalstrom.isAddonHelperState('9be5e52c9e465cd880b6b06494f9dcf600_open-tilded')).to.equal(true);
            expect(Digitalstrom.isAddonHelperState('queue-active')).to.equal(true);
            expect(Digitalstrom.isAddonHelperState('operationmode.3.NotUsed')).to.equal(false);
            expect(Digitalstrom.isAddonHelperState('zone.zone4.group0.type9.passiveCooling')).to.equal(false);
        });
    });

    describe('subscription failures during startup', () => {
        it('reports an error when part of the subscriptions failed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const activeEvents = Object.keys(dssConstants.availableEvents).filter(
                name => dssConstants.availableEvents[name],
            );
            let call = 0;
            dss.requestAsync = async () => {
                call++;
                if (call % 2 === 0) {
                    throw new Error('subscribe denied');
                }
                return { ok: true };
            };
            dss.pollChannel = () => {};

            const ctx = createContext({ dss, dssStruct: { stateMap: {}, zoneDevices: {} } });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err, 'a failed subscription must be reported').to.be.an('error');
                expect(err.message).to.contain('event subscriptions failed');
                expect(err.message).to.contain(`of ${activeEvents.length}`);
                dss.stop();
                done();
            });
        });

        it('reports no error when all subscriptions succeed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({ dss, dssStruct: { stateMap: {}, zoneDevices: {} } });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err).to.equal(null);
                dss.stop();
                done();
            });
        });

        it('does not report a connection when the subscriptions failed', () => {
            // Mirrors the startup path: on a subscription error info.connection stays false
            const ctx = createContext();
            ctx.setConnected(false);
            expect(ctx.states['info.connection']).to.equal(false);
            expect(ctx.connected).to.equal(false);
        });
    });

    describe('restart through js-controller', () => {
        // Production log of 26.09.2026: every restart said "Terminated (-100): Without
        // reason" as a warning. -100 only became 156 because a process exit code is cut to
        // 8 bits - in compact mode the host got -100 itself, logged an error and waited 30 s.
        it('stops with START_IMMEDIATELY_AFTER_STOP and says why', async () => {
            /** @type {any[]} */
            const stops = [];
            const ctx = createContext({
                restartTimeout: null,
                stop: async params => {
                    stops.push(params);
                },
            });
            Digitalstrom.prototype.restartAdapter.call(ctx, 1, 'of too many event polling errors (callScene)');
            await waitFor(() => stops.length > 0);
            expect(stops).to.deep.equal([
                { exitCode: 156, reason: 'restarting because of too many event polling errors (callScene)' },
            ]);
        });

        // stop() runs onUnload before it terminates - terminate() alone would leave the
        // event polls, timers and the websocket of this instance running in compact mode
        it('prefers stop() and only falls back to terminate() without it', async () => {
            /** @type {any[]} */
            const terminated = [];
            const ctx = createContext({
                restartTimeout: null,
                terminate: (reason, exitCode) => terminated.push([reason, exitCode]),
            });
            Digitalstrom.prototype.restartAdapter.call(
                ctx,
                1,
                'the dSS re-initialized its apartment model (model_ready)',
            );
            await waitFor(() => terminated.length > 0);
            expect(terminated).to.deep.equal([
                ['restarting because the dSS re-initialized its apartment model (model_ready)', 156],
            ]);
        });

        it('still terminates when stop() fails', async () => {
            /** @type {any[]} */
            const terminated = [];
            const ctx = createContext({
                restartTimeout: null,
                stop: () => Promise.reject(new Error('stop failed')),
                terminate: (reason, exitCode) => terminated.push([reason, exitCode]),
            });
            Digitalstrom.prototype.restartAdapter.call(ctx, 1, 'reading the DSS structure failed');
            await waitFor(() => terminated.length > 0);
            expect(terminated).to.deep.equal([['restarting because reading the DSS structure failed', 156]]);
        });

        // In compact mode js-controller 7.2.2 emits exit(code, reason), and the host logs a
        // reason as "instance ... terminated due to <reason>" at warn level
        it('logs the reason itself and stops without one in compact mode', async () => {
            /** @type {any[]} */
            const stops = [];
            /** @type {string[]} */
            const infos = [];
            const ctx = createContext({
                restartTimeout: null,
                compactMode: true,
                log: { ...silentLog, info: msg => infos.push(msg) },
                stop: async params => {
                    stops.push(params);
                },
            });
            Digitalstrom.prototype.restartAdapter.call(ctx, 1, 'of too many event polling errors (callScene)');
            await waitFor(() => stops.length > 0);
            expect(stops).to.deep.equal([{ exitCode: 156, reason: undefined }]);
            expect(infos).to.deep.equal(['restarting because of too many event polling errors (callScene)']);
        });

        it('falls back to terminate() without a reason in compact mode', async () => {
            /** @type {any[]} */
            const terminated = [];
            const ctx = createContext({
                restartTimeout: null,
                compactMode: true,
                stop: () => Promise.reject(new Error('stop failed')),
                terminate: (reason, exitCode) => terminated.push([reason, exitCode]),
            });
            Digitalstrom.prototype.restartAdapter.call(ctx, 1, 'reading the DSS structure failed');
            await waitFor(() => terminated.length > 0);
            expect(terminated, 'a bare 156 would become the signal').to.deep.equal([[undefined, 156]]);
        });

        // The second reason comes with the shorter delay: a second timer would fire first
        it('schedules a single restart for several reasons', async () => {
            /** @type {any[]} */
            const stops = [];
            const ctx = createContext({
                restartTimeout: null,
                stop: async params => {
                    stops.push(params);
                },
            });
            Digitalstrom.prototype.restartAdapter.call(ctx, 30, 'first');
            Digitalstrom.prototype.restartAdapter.call(ctx, 1, 'second');
            await waitFor(() => stops.length > 0);
            expect(stops.map(params => params.reason)).to.deep.equal(['restarting because first']);
        });
    });

    describe('a dSS that does not answer at startup', () => {
        const refused = () =>
            new Error('Request error for /json/system/loginApplication: connect ECONNREFUSED 10.13.10.4:8080');
        const loginFailed = () => new Error('Login failed: Application Authentication failed');
        const answer = { ok: true, result: { name: 'dSS' } };

        /**
         * @param {Array<Error|Record<string, any>|Promise<any>>} answers one per check, the last one repeats; an
         *   Error rejects, a promise is handed out as it is
         * @param {Record<string, any>} [overrides]
         * @returns {Record<string, any>} context whose log lines are collected in ctx.lines
         */
        function outageContext(answers, overrides = {}) {
            /** @type {Array<[string, string]>} */
            const lines = [];
            const log = {
                silly: () => {},
                debug: msg => lines.push(['debug', String(msg)]),
                info: msg => lines.push(['info', String(msg)]),
                warn: msg => lines.push(['warn', String(msg)]),
                error: msg => lines.push(['error', String(msg)]),
            };
            let checks = 0;
            const dss = {
                stopped: false,
                requestAsync: (dssClass, dssFunction) => {
                    expect(`${dssClass}/${dssFunction}`).to.equal('apartment/getName');
                    const next = answers[Math.min(checks++, answers.length - 1)];
                    if (next instanceof Promise) {
                        return next;
                    }
                    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
                },
                unsubscribeAllEvents: cb => cb(0),
                stop() {
                    this.stopped = true;
                },
            };
            return createContext({
                log,
                lines,
                dss,
                config: { host: '10.13.10.4' },
                checks: () => checks,
                dssQueue: { stop: () => {} },
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 20,
                ...overrides,
            });
        }

        const linesOf = (ctx, level) => ctx.lines.filter(([lineLevel]) => lineLevel === level).map(([, msg]) => msg);

        // The night of 26.09.2026: 102 process restarts in 8.5 hours, each with two error
        // lines and a js-controller warning - for a dSS that simply refused connections
        it('waits in the same process and reports the outage once', async () => {
            const ctx = outageContext([refused(), refused(), refused(), answer]);
            /** @type {any[]} */
            const started = [];
            Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
            await waitFor(() => started.length > 0);

            expect(ctx.checks(), 'three failed checks and the answer').to.equal(4);
            expect(started, 'the start continues exactly once').to.deep.equal([answer]);
            expect(ctx.restarts, 'no process restart for an outage').to.deep.equal([]);
            const errors = linesOf(ctx, 'error');
            expect(errors, 'one error for the whole outage').to.have.lengthOf(1);
            expect(errors[0]).to.contain('10.13.10.4').and.to.contain('ECONNREFUSED').and.to.contain('App-Token');
            // The line for the answer is info: somebody running at warn must not wait for it
            expect(errors[0]).to.contain('logs at info level when the DSS answers again');
            expect(linesOf(ctx, 'debug').filter(msg => msg.includes('still fails'))).to.have.lengthOf(2);
            const infos = linesOf(ctx, 'info');
            expect(infos, 'one line when it is back').to.have.lengthOf(1);
            expect(infos[0]).to.match(/answers again after \d+ s \(3 failed checks\)/);
            expect(ctx.dssOutage, 'the outage is closed').to.equal(null);
        });

        // A dSS that accepts the connection again but refuses the login needs somebody to act
        it('reports a different error once more, and each error only once', async () => {
            const ctx = outageContext([refused(), loginFailed(), refused(), loginFailed(), answer]);
            /** @type {any[]} */
            const started = [];
            Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
            await waitFor(() => started.length > 0);
            const errors = linesOf(ctx, 'error');
            expect(errors).to.have.lengthOf(2);
            expect(errors[1]).to.contain('different error').and.to.contain('Login failed');
            // A refused login is an answer of the dSS - the line must not claim it is silent
            expect(errors[1]).to.contain('refuses the login').and.to.contain('App-Token');
            expect(errors[1]).to.not.contain('does not answer');
            expect(linesOf(ctx, 'info')).to.have.lengthOf(1);
            expect(linesOf(ctx, 'info')[0]).to.contain('(4 failed checks)');
        });

        // loginApplication answered ok:false: the dSS was reached and refused the App-Token.
        // "Cannot reach the DSS" sent the user to the network, and every later check said
        // "still not reachable" - for a token that never comes back by itself.
        it('names a refused App-Token as a refused login, not as an unreachable dSS', async () => {
            const ctx = outageContext([loginFailed(), loginFailed(), loginFailed(), answer]);
            /** @type {any[]} */
            const started = [];
            Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
            await waitFor(() => started.length > 0);
            const errors = linesOf(ctx, 'error');
            expect(errors).to.have.lengthOf(1);
            expect(errors[0]).to.contain('refused the login').and.to.contain('App-Token').and.to.contain('10.13.10.4');
            expect(errors[0]).to.not.contain('Cannot reach');
            const debug = linesOf(ctx, 'debug');
            expect(debug.filter(msg => msg.includes('still fails'))).to.have.lengthOf(2);
            expect(debug.join('\n')).to.not.contain('not reachable');
        });

        // A Raspberry Pi boots with the clock of its last shutdown (fake-hwclock), and NTP sets
        // it forward once the network is up - between the failed check and the answer
        it('measures the outage independent of a clock correction', async () => {
            const ctx = outageContext([refused(), answer]);
            const realNow = Date.now;
            /** @type {any[]} */
            const started = [];
            try {
                // The clock jumps right before the second check, which gets the answer
                const ask = ctx.dss.requestAsync;
                let asked = 0;
                ctx.dss.requestAsync = (...args) => {
                    if (asked++ === 1) {
                        Date.now = () => realNow() + 3 * 3600 * 1000;
                    }
                    return ask(...args);
                };
                Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
                await waitFor(() => started.length > 0);
            } finally {
                Date.now = realNow;
            }
            const infos = linesOf(ctx, 'info');
            expect(infos).to.have.lengthOf(1);
            expect(infos[0]).to.match(/answers again after \d+ s \(1 failed check\)/);
        });

        it('says nothing extra when the dSS answers right away', async () => {
            const ctx = outageContext([answer]);
            /** @type {any[]} */
            const started = [];
            Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
            await waitFor(() => started.length > 0);
            expect(ctx.lines).to.deep.equal([]);
            expect(ctx.dssRetryTimeout).to.equal(null);
        });

        // A long delay on purpose: the check must end because the timer is gone, not
        // because the test is over before it fires
        it('stops asking when the adapter is unloaded while it waits', async () => {
            const ctx = outageContext([refused()], { dssRetryDelay: 60000 });
            /** @type {any[]} */
            const started = [];
            Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
            await waitFor(() => ctx.dssRetryTimeout !== null);
            const pendingRetry = ctx.dssRetryTimeout;
            try {
                await new Promise(resolve => Digitalstrom.prototype.stopAdapter.call(ctx, resolve));
                expect(ctx.dssRetryTimeout, 'the retry timer is gone').to.equal(null);
                // The retry timer firing anyway, or any other late caller
                Digitalstrom.prototype.waitForDss.call(ctx, name => started.push(name));
                expect(ctx.checks(), 'no check after the unload').to.equal(1);
                expect(started).to.deep.equal([]);
            } finally {
                clearTimeout(pendingRetry);
            }
        });

        // stopAdapter() aborts a check that is still running - its rejection is the shutdown,
        // not the next failure of an outage
        it('treats a check the unload aborted as a shutdown, not as an outage', async () => {
            /** @type {(err: Error) => void} */
            let abort = () => {};
            const inFlight = new Promise((resolve, reject) => (abort = reject));
            const ctx = outageContext([inFlight]);
            Digitalstrom.prototype.waitForDss.call(ctx, () => {});
            await new Promise(resolve => Digitalstrom.prototype.stopAdapter.call(ctx, resolve));
            abort(new Error('Client is stopped, not requesting /json/apartment/getName'));
            // One turn of the event loop runs every promise reaction that is due
            await new Promise(resolve => setImmediate(resolve));
            expect(ctx.dssRetryTimeout, 'no retry after the unload').to.equal(null);
            expect(ctx.dssOutage, 'no outage either').to.equal(null);
            expect(linesOf(ctx, 'error')).to.deep.equal([]);
        });

        // Armed before the check, the 10 minute watchdog restarted the process during every
        // outage longer than that - the very restart loop the waiting replaces
        it('arms the startup watchdog only once the dSS answered', () => {
            /** @type {any} */
            let continueStart;
            const ctx = createContext({
                config: { host: '192.168.1.10', appToken: VALID_APP_TOKEN },
                log: silentLog,
                // never calls back, so the start stops right after the watchdog
                objectHelper: { loadExistingObjects: () => {} },
                createSmartHomeClient: Digitalstrom.prototype.createSmartHomeClient,
                startEarlyEventSubscription: () => {},
                waitForDss: cb => (continueStart = cb),
            });
            Digitalstrom.prototype.main.call(ctx);
            try {
                expect(continueStart, 'main() waits for the dSS').to.be.a('function');
                expect(ctx.startupTimeout, 'no watchdog while the dSS does not answer').to.equal(undefined);
                continueStart(answer);
                expect(ctx.startupTimeout, 'the watchdog runs once the dSS answered').to.not.equal(undefined);
            } finally {
                clearTimeout(ctx.startupTimeout);
                clearInterval(ctx.apiActivityTimer);
                ctx.dss.stop();
            }
        });

        it('formats the outage duration for the log', () => {
            expect(Digitalstrom.formatDuration(0)).to.equal('0 s');
            expect(Digitalstrom.formatDuration(45400)).to.equal('45 s');
            expect(Digitalstrom.formatDuration(300000)).to.equal('5 min');
            expect(Digitalstrom.formatDuration(252000)).to.equal('4 min 12 s');
            expect(Digitalstrom.formatDuration((8 * 60 + 37) * 60000 + 12000)).to.equal('8 h 37 min');
            expect(Digitalstrom.formatDuration(2 * 3600000)).to.equal('2 h');
        });
    });

    describe('stop handling', () => {
        function stoppableContext(dss) {
            return createContext({
                dss,
                dssQueue: { stop: () => {}, clearQueues: () => {} },
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 50,
            });
        }

        it('answers every caller exactly once', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.subscriptions.eventA = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            const ctx = stoppableContext(dss);

            let firstCalls = 0;
            let secondCalls = 0;
            Digitalstrom.prototype.stopAdapter.call(ctx, () => firstCalls++);
            Digitalstrom.prototype.stopAdapter.call(ctx, () => secondCalls++);

            setTimeout(() => {
                expect(firstCalls, 'first caller answered once').to.equal(1);
                expect(secondCalls, 'second caller answered once').to.equal(1);
                // A caller after the stop finished must still be answered
                let lateCalls = 0;
                Digitalstrom.prototype.stopAdapter.call(ctx, () => lateCalls++);
                expect(lateCalls, 'late caller answered once').to.equal(1);
                done();
            }, 120);
        });

        it('closes the DSS client even when unsubscribing hangs', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = () => new Promise(() => {}); // unsubscribe never returns
            dss.subscriptions.eventA = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            const ctx = stoppableContext(dss);

            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(dss.stopped, 'the DSS client must be closed by the guard path').to.equal(true);
                done();
            });
        });
    });

    describe('the stop is a barrier for late startup callbacks', () => {
        // Regression: asynchronous startup callbacks kept running after the unload and
        // created timers, subscriptions and connected = true on an already stopped adapter.
        it('never reports connected again after the stop', () => {
            const ctx = createContext();
            ctx.setConnected(true);
            expect(ctx.states['info.connection']).to.equal(true);

            ctx.stopping = true;
            ctx.stopped = true;
            ctx.connected = false;
            ctx.states['info.connection'] = false;

            // A startup callback that only now reaches setConnected(true)
            ctx.setConnected(true);
            expect(ctx.states['info.connection'], 'a stopped adapter must stay disconnected').to.equal(false);
            expect(ctx.connected).to.equal(false);
        });

        it('starts no data polling after the stop', () => {
            let meterReads = 0;
            const ctx = createContext({
                dataPollInterval: 60000,
                dataPollTimeout: null,
                dssStruct: {
                    updateMeterData: cb => {
                        meterReads++;
                        cb(0, 1);
                    },
                },
            });
            ctx.stopping = true;
            Digitalstrom.prototype.startDataPolling.call(ctx);
            expect(meterReads, 'no meter read after the stop').to.equal(0);
            expect(ctx.dataPollTimeout, 'and no new timer').to.equal(null);
        });

        it('schedules no restart after the stop', () => {
            const ctx = createContext({ restartTimeout: null });
            ctx.stopped = true;
            Digitalstrom.prototype.restartAdapter.call(ctx, 1000);
            expect(ctx.restartTimeout, 'a stopped adapter must not restart itself').to.equal(null);
        });

        it('closes an App-Token client that is still running during the unload', done => {
            const tokenClient = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = createContext({
                dssQueue: { stop: () => {}, clearQueues: () => {} },
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 20,
            });
            ctx.tokenConnections.add(tokenClient);

            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(tokenClient.stopped, 'the token client must be closed by the unload').to.equal(true);
                expect(ctx.tokenConnections.size, 'and must not be kept afterwards').to.equal(0);
                done();
            });
        });

        it('answers no App-Token request that finishes after the unload', done => {
            const sent = [];
            const infos = [];
            const ctx = createContext({
                log: Object.assign({}, silentLog, { info: msg => infos.push(String(msg)) }),
                sendTo: (from, command, result, callback) => sent.push({ result, callback }),
                config: { validateCertificate: false },
            });

            /** @type {((token: string) => void)|undefined} */
            let resolveToken;
            const tokenClient = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            tokenClient.createAppTokenAsync = () =>
                new Promise(resolve => {
                    resolveToken = resolve;
                });
            ctx.tokenConnections.add(tokenClient);

            // Simulates the message handler: the answer only arrives after the unload
            tokenClient.createAppTokenAsync('user', 'pass').then(appToken => {
                ctx.tokenConnections.delete(tokenClient);
                tokenClient.stop();
                if (Digitalstrom.prototype.isStopping.call(ctx)) {
                    expect(sent, 'no late sendTo into a closed admin dialog').to.deep.equal([]);
                    expect(appToken).to.equal('token');
                    return done();
                }
                done(new Error('the stop barrier did not take effect'));
            });

            ctx.stopping = true;
            ctx.stopped = true;
            resolveToken && resolveToken('token');
        });

        it('refuses a new App-Token request during the unload', () => {
            const sent = [];
            const ctx = createContext({
                sendTo: (from, command, result) => sent.push(result),
                config: { validateCertificate: false },
            });
            ctx.stopping = true;
            Digitalstrom.prototype.onMessage.call(ctx, {
                command: 'createAppToken',
                from: 'system.adapter.admin.0',
                callback: { id: 1 },
                message: { host: 'localhost', username: 'u', password: 'p' },
            });
            expect(ctx.tokenConnections.size, 'no new client during the unload').to.equal(0);
            expect(sent).to.deep.equal([]);
        });
    });

    describe('event handler registration order', () => {
        function eventContext(dss) {
            return createContext({
                dss,
                dssStruct: {
                    stateMap: { '5.1.scenes.17': 'apartment.zones.5.groups.1.scenes.Preset2' },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
        }

        // Regression: the handlers were registered only in the completion callback of
        // subscribeEvents(). A fast subscription already polls and emits while a slow one is
        // still pending - those events had no listener and were lost for good.
        it('processes an event that arrives before all subscriptions are done', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            let emitted = false;
            const slowSubscribes = [];
            dss.pollChannel = () => {};
            /**
             * @param {string} dssClass
             * @param {string} dssFunction
             * @param {Record<string, any>} params every call of the adapter carries them
             * @returns {Promise<import('../lib/configUtils').DssResponse>} DSS answer
             */
            dss.requestAsync = async (dssClass, dssFunction, params) => {
                if (dssFunction !== 'subscribe') {
                    return { ok: true };
                }
                if (params.name === 'callScene') {
                    // The fast subscription immediately delivers an event
                    if (!emitted) {
                        emitted = true;
                        setImmediate(() =>
                            dss.emit('callScene', {
                                name: 'callScene',
                                source: { isGroup: true },
                                properties: { zoneID: '5', groupID: '1', sceneID: '17' },
                            }),
                        );
                    }
                    return { ok: true };
                }
                // Every other subscription is slow and only finishes at the end of the test
                await new Promise(resolve => slowSubscribes.push(resolve));
                return { ok: true };
            };

            const ctx = eventContext(dss);
            let earlyState;
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                expect(earlyState, 'the early event must be applied before all subscriptions are done').to.equal(true);
                dss.stop();
                done();
            });

            setTimeout(() => {
                earlyState = ctx.states['apartment.zones.5.groups.1.scenes.Preset2'];
                expect(earlyState, 'an early event must not be lost').to.equal(true);
                slowSubscribes.forEach(resolve => resolve());
            }, 30);
        });

        it('registers the handlers before the first subscription is sent', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            let listenersAtFirstSubscribe = -1;
            dss.pollChannel = () => {};
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe' && listenersAtFirstSubscribe === -1) {
                    listenersAtFirstSubscribe = dss.listenerCount('callScene');
                }
                return { ok: true };
            };
            const ctx = eventContext(dss);
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                expect(listenersAtFirstSubscribe, 'callScene must already have a listener').to.be.above(0);
                dss.stop();
                done();
            });
        });

        it('registers no listener twice when called again', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = eventContext(dss);
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                const afterFirst = dss.listenerCount('callScene');
                Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                    expect(dss.listenerCount('callScene'), 'no duplicated handlers').to.equal(afterFirst);
                    expect(afterFirst).to.equal(1);
                    dss.stop();
                    done();
                });
            });
        });
    });

    describe('scene fan-out to the devices', () => {
        function sceneContext(config) {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const deviceEvents = [];
            const ctx = createContext({
                dss,
                config: Object.assign({ initializeOutputValues: true, usePresetValues: true }, config),
                dssStruct: {
                    // Room 5 with one device in the light group - the broadcast group 0 is
                    // never a key here, the DSS does not list devices in it
                    zoneDevices: { 5: { 1: ['dev1'], 2: ['dev2'] } },
                    stateMap: {
                        '5.1.scenes.0': 'apartment.0.5.1.scenes.Preset0',
                        '5.2.scenes.0': 'apartment.0.5.2.scenes.Preset0',
                        '0.0.scenes.0': 'apartment.scenes.Preset0',
                    },
                    dssObjects: {},
                    apartmentStructure: { zones: [{ id: 5 }] },
                },
            });
            dss.on('dev1', data => deviceEvents.push(['dev1', data.properties.sceneID]));
            dss.on('dev2', data => deviceEvents.push(['dev2', data.properties.sceneID]));
            return { ctx, dss, deviceEvents };
        }

        /**
         * Context for a single device that carries a momentary and a lasting scene.
         *
         * @param {Record<string, any>} [overrides]
         */
        function momentaryContext(overrides = {}) {
            const writes = [];
            const dss = new DSS({ host: 'http://127.0.0.1:1', appToken: 'x' });
            const ctx = createContext({
                dss,
                dssQueue: { pushQueryQueue: () => {} },
                momentaryReleaseDelay: 5,
                setState(id, value) {
                    this.states[id] = value;
                    writes.push([id, value]);
                },
                dssStruct: {
                    stateMap: {
                        'dev1.scenes.15': 'devices.m1.dev1.scenes.Stop',
                        'dev1.scenes.14': 'devices.m1.dev1.scenes.Maximum',
                        '5.48.scenes.10': 'apartment.0.5.48.scenes.CoolingNight',
                    },
                    dssObjects: {},
                    zoneDevices: {},
                    apartmentStructure: { zones: [] },
                },
                ...overrides,
            });
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            return { ctx, dss, writes };
        }

        /**
         * @param {any} dss
         * @param {string} sceneID
         * @param {Record<string, any>} [source]
         * @param {Record<string, any>} [props]
         */
        function deviceScene(dss, sceneID, source = {}, props = {}) {
            dss.emit('callScene', {
                name: 'callScene',
                source: { isDevice: true, isGroup: false, isApartment: false, dSUID: 'dev1', ...source },
                properties: { sceneID, callOrigin: '-1', ...props },
            });
        }

        // Regression: the dSS sends a callScene for Stop and never the matching undoScene -
        // measured over three hours: six of them, not one undoScene - so the state stayed
        // true from the first press to the end of the run and a rule on it fired once.
        it('lets a Stop fall back to false again', async () => {
            const { dss, writes } = momentaryContext();
            const stop = w => w[0] === 'devices.m1.dev1.scenes.Stop';
            deviceScene(dss, '15');
            expect(writes, 'true first, the release must not overtake it').to.deep.include([
                'devices.m1.dev1.scenes.Stop',
                true,
            ]);
            await waitFor(() => writes.some(w => stop(w) && w[1] === false));
            expect(writes.filter(stop)).to.deep.equal([
                ['devices.m1.dev1.scenes.Stop', true],
                ['devices.m1.dev1.scenes.Stop', false],
            ]);
            dss.stop();
        });

        // A wall switch repeats its Stop - measured three times within 481 ms while the
        // blind never moved. That is ONE press, and a rule on it has to fire once.
        it('makes a repeated Stop one edge, not three', async () => {
            const { dss, writes } = momentaryContext();
            const released = w => w[0] === 'devices.m1.dev1.scenes.Stop' && w[1] === false;
            deviceScene(dss, '15');
            deviceScene(dss, '15');
            deviceScene(dss, '15');
            await waitFor(() => writes.some(released));
            // A second release would arrive after the first, so give one more window a
            // chance to produce it before claiming there was only one
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(writes.filter(released), 'the release is re-armed, not queued three times').to.have.lengthOf(1);
            expect(writes[writes.length - 1][1], 'and it is the last thing that happens').to.equal(false);
            dss.stop();
        });

        // A blind driven to Maximum really IS at Maximum - that latch is correct and the
        // fix must be keyed on the scene number, not on "the state never went false"
        it('leaves a scene that really is a position alone', done => {
            const { dss, writes } = momentaryContext();
            deviceScene(dss, '14');
            setTimeout(() => {
                expect(writes.filter(w => w[0] === 'devices.m1.dev1.scenes.Maximum')).to.deep.equal([
                    ['devices.m1.dev1.scenes.Maximum', true],
                ]);
                dss.stop();
                done();
            }, 40);
        });

        // Group 48 reads scene 10 as "Cooling Night", a lasting operation mode. Releasing
        // it would clear the heating mode of the room half a second after it was set.
        it('does not touch scene 10 of the temperature control group', done => {
            const { dss, writes } = momentaryContext();
            dss.emit('callScene', {
                name: 'callScene',
                source: { isDevice: false, isGroup: true, isApartment: false },
                properties: { zoneID: '5', groupID: '48', sceneID: '10', callOrigin: '-1' },
            });
            setTimeout(() => {
                const scene = writes.filter(w => w[0] === 'apartment.0.5.48.scenes.CoolingNight');
                expect(scene, 'a cooling mode is not a momentary command').to.deep.equal([
                    ['apartment.0.5.48.scenes.CoolingNight', true],
                ]);
                dss.stop();
                done();
            }, 40);
        });

        it('keeps sceneId answering which scene was called last', done => {
            const { dss, writes } = momentaryContext();
            deviceScene(dss, '15');
            setTimeout(() => {
                const sceneId = writes.filter(w => w[0] === 'devices.m1.dev1.scenes.sceneId');
                expect(sceneId, 'only the boolean pulses, the number stays').to.deep.equal([
                    ['devices.m1.dev1.scenes.sceneId', '15'],
                ]);
                dss.stop();
                done();
            }, 40);
        });

        describe('a scene call without scene state', () => {
            function loggingContext() {
                /** @type {string[]} */
                const infos = [];
                /** @type {string[]} */
                const debugs = [];
                const { ctx, dss } = momentaryContext({
                    log: {
                        ...silentLog,
                        info: msg => infos.push(String(msg)),
                        debug: msg => debugs.push(String(msg)),
                    },
                    dssStruct: {
                        stateMap: {
                            'dev1.scenes.15': 'devices.m1.dev1.scenes.Stop',
                            '5.48.scenes.10': 'apartment.0.5.48.scenes.CoolingNight',
                            '2274.2.scenes.0': 'apartment.0.2274.2.scenes.Preset0',
                        },
                        dssObjects: {},
                        zoneDevices: {},
                        apartmentStructure: { zones: [] },
                    },
                });
                const unmapped = () => debugs.filter(msg => msg.includes('without scene state'));
                return { ctx, dss, infos, unmapped };
            }

            /**
             * @param {any} dss
             * @param {string} zoneID
             * @param {string} groupID
             * @param {string} sceneID
             */
            function groupScene(dss, zoneID, groupID, sceneID) {
                dss.emit('callScene', {
                    name: 'callScene',
                    source: { isGroup: true, isDevice: false, isApartment: false },
                    properties: { zoneID, groupID, sceneID, callOrigin: '1' },
                });
            }

            // Measured on a real installation: at 05:00 the climate control called scene 0 of
            // group 48 in every room, also in three without heating, and each call logged
            // "INVALID scenecall" at info without saying which one
            it('keeps a room without objects for the group at debug, with zone, group and scene', () => {
                const { dss, infos, unmapped } = loggingContext();
                groupScene(dss, '65534', '48', '0');
                groupScene(dss, '2186', '48', '0');
                expect(infos).to.deep.equal([]);
                expect(unmapped()).to.deep.equal([
                    'callScene without scene state: zone 65534, group 48, scene 0 - this room has no scene objects for that group',
                    'callScene without scene state: zone 2186, group 48, scene 0 - this room has no scene objects for that group',
                ]);
                dss.stop();
            });

            // The same day: a wall switch stopped the blinds of a room, Stop (15) on group 2
            it('keeps a command scene on group level at debug', () => {
                const { dss, infos, unmapped } = loggingContext();
                groupScene(dss, '2274', '2', '15');
                expect(infos).to.deep.equal([]);
                expect(unmapped()).to.deep.equal([
                    'callScene without scene state: zone 2274, group 2, scene 15 - a command scene, only devices have a state for it',
                ]);
                dss.stop();
            });

            it('names any other one once at info, then at debug', () => {
                const { dss, infos, unmapped } = loggingContext();
                groupScene(dss, '5', '48', '2');
                groupScene(dss, '5', '48', '2');
                deviceScene(dss, '5');
                expect(infos).to.have.lengthOf(2);
                expect(infos[0]).to.contain('zone 5, group 48, scene 2');
                expect(infos[1]).to.contain('device dev1, scene 5');
                expect(unmapped()).to.deep.equal(['callScene without scene state: zone 5, group 48, scene 2']);
                expect(infos.join('\n')).to.not.contain('INVALID');
                dss.stop();
            });
        });

        function callScene(dss, zoneID, groupID) {
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true, isDevice: false, isApartment: false },
                properties: { zoneID, groupID, sceneID: '0', callOrigin: '-1' },
            });
        }

        // Regression: a scene for a whole room arrives with groupID "0". zoneDevices is only
        // keyed by the real device groups, so the fan-out found nothing and the forwarding
        // loop that runs afterwards is marked as "forwarded", which disabled it as well.
        // Result: brightness and shade position kept their old value forever.
        it('reaches every device of the room on a room wide scene (groupID 0)', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                expect(deviceEvents.map(e => e[0]).sort(), 'both devices of the room must be refreshed').to.deep.equal([
                    'dev1',
                    'dev2',
                ]);
                dss.stop();
                done();
            }, 10);
        });

        it('still reaches exactly the devices of one group on a group scene', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '1');
            setTimeout(() => {
                expect(deviceEvents).to.deep.equal([['dev1', '0']]);
                dss.stop();
                done();
            }, 10);
        });

        it('delivers every device exactly once on a room wide scene', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            ctx.dssStruct.zoneDevices = { 5: { 1: ['dev1'], 2: ['dev1', 'dev2'], 8: ['dev1'] } };
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                const perDevice = {};
                deviceEvents.forEach(e => (perDevice[e[0]] = (perDevice[e[0]] || 0) + 1));
                expect(perDevice, 'a device in several groups must not be handled twice').to.deep.equal({
                    dev1: 1,
                    dev2: 1,
                });
                dss.stop();
                done();
            }, 10);
        });

        // Regression: the fan-out was gated on initializeOutputValues, but the device handlers
        // also apply the scene preset values, which is controlled by usePresetValues. With
        // reading switched off the preset values were silently dead too.
        it('reaches the devices even when initializeOutputValues is off', done => {
            const { ctx, dss, deviceEvents } = sceneContext({ initializeOutputValues: false });
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '1');
            setTimeout(() => {
                expect(deviceEvents, 'the preset values must still be applied').to.deep.equal([['dev1', '0']]);
                dss.stop();
                done();
            }, 10);
        });

        it('does not fan out again for the forwarded frames', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                expect(deviceEvents.length, 'exactly one event per device, not one per group').to.equal(2);
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('button events', () => {
        function buttonContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({
                dss,
                dssStruct: {
                    dssObjects: {
                        'devices.m1.dev1.buttonClickType': { common: { type: 'number' } },
                        'devices.m1.dev1.buttonHoldCount': { common: { type: 'number' } },
                    },
                    stateMap: {
                        'dev1.0.button': 'devices.m1.dev1.button',
                        'dev1.0.buttonClickType': 'devices.m1.dev1.buttonClickType',
                        'dev1.0.buttonHoldCount': 'devices.m1.dev1.buttonHoldCount',
                    },
                    zoneDevices: {},
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        // Regression: both states are declared as numbers, but the DSS sends strings and the
        // handler wrote them with setState instead of setDssState
        it('converts the DSS strings of a button click into numbers', done => {
            const { ctx, dss } = buttonContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            dss.emit('buttonClick', {
                name: 'buttonClick',
                source: { isDevice: true, dSUID: 'dev1' },
                properties: { clickType: '7', holdCount: '3' },
            });
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.button']).to.equal(true);
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'must be the number 7').to.equal(7);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount']).to.equal(3);
                dss.stop();
                done();
            }, 10);
        });

        // Regression: the dSS reports a press and never takes it back, so the state stayed
        // true from the first press to the end of the run - the same defect the momentary
        // scenes had, on the state right next to them.
        it('lets a pressed button go again', async () => {
            const { ctx, dss } = buttonContext();
            ctx.momentaryReleaseDelay = 5;
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            dss.emit('buttonClick', {
                name: 'buttonClick',
                source: { isDevice: true, dSUID: 'dev1' },
                properties: { clickType: '7', holdCount: '3' },
            });
            expect(ctx.states['devices.m1.dev1.button'], 'true first').to.equal(true);
            await waitFor(() => ctx.states['devices.m1.dev1.button'] === false);
            expect(ctx.states['devices.m1.dev1.buttonClickType'], 'the click type is not a moment').to.equal(7);
            dss.stop();
        });

        it('keeps the click type 0 and the defaults working', done => {
            const { ctx, dss } = buttonContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            dss.emit('buttonClick', {
                name: 'buttonClick',
                source: { isDevice: true, dSUID: 'dev1' },
                properties: { clickType: 0 },
            });
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'clickType 0 stays 0').to.equal(0);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount'], 'default 0').to.equal(0);
                dss.stop();
                done();
            }, 10);
        });

        it('does not write anything when only the plain button state exists', done => {
            const { ctx, dss } = buttonContext();
            delete ctx.dssStruct.stateMap['dev1.0.buttonClickType'];
            delete ctx.dssStruct.stateMap['dev1.0.buttonHoldCount'];
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            expect(() =>
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: { clickType: '7' },
                }),
            ).to.not.throw();
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.button']).to.equal(true);
                expect(Object.keys(ctx.states), 'no write with an undefined id').to.deep.equal([
                    'devices.m1.dev1.button',
                ]);
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('temperature operation mode', () => {
        // The room temperature control is switched through the scenes of group 48. The
        // readable OperationMode state has to follow every scene call.
        function tempContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({
                dss,
                dssStruct: {
                    zoneDevices: {},
                    dssObjects: {
                        'apartment.0.2.temperatureControl.OperationMode': { common: { type: 'number' } },
                    },
                    stateMap: {
                        '2.48.scenes.1': 'apartment.0.2.48.scenes.HeatingComfort',
                        '2.48.operationMode': 'apartment.0.2.temperatureControl.OperationMode',
                    },
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        it('follows a scene call of group 48', done => {
            const { ctx, dss } = tempContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true },
                properties: { zoneID: '2', groupID: '48', sceneID: '1', callOrigin: '-1' },
            });
            setTimeout(() => {
                expect(ctx.states['apartment.0.2.48.scenes.HeatingComfort'], 'the scene itself').to.equal(true);
                expect(
                    ctx.states['apartment.0.2.temperatureControl.OperationMode'],
                    'the readable mode must follow as a number',
                ).to.equal(1);
                dss.stop();
                done();
            }, 10);
        });

        it('does not touch the mode for a scene of another group', done => {
            const { ctx, dss } = tempContext();
            ctx.dssStruct.stateMap['2.1.scenes.1'] = 'apartment.0.2.1.scenes.Preset1';
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true },
                properties: { zoneID: '2', groupID: '1', sceneID: '1', callOrigin: '-1' },
            });
            setTimeout(() => {
                expect(ctx.states['apartment.0.2.temperatureControl.OperationMode']).to.equal(undefined);
                dss.stop();
                done();
            }, 10);
        });

        it('survives a room without temperature control', done => {
            const { ctx, dss } = tempContext();
            delete ctx.dssStruct.stateMap['2.48.operationMode'];
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            expect(() =>
                dss.emit('callScene', {
                    name: 'callScene',
                    source: { isGroup: true },
                    properties: { zoneID: '2', groupID: '48', sceneID: '1', callOrigin: '-1' },
                }),
            ).to.not.throw();
            setTimeout(() => {
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('scene resync after the subscription', () => {
        function resyncContext(dss, answers) {
            return createContext({
                dss,
                lastScenes: { 5.1: 17, 5.2: 0, dev1abcdef: 5 },
                dssQueue: {
                    /** @type {Array<{key: string, prio: string}>} */
                    asked: [],
                    pushQueryQueue(circuit, entry, prio, callback) {
                        const key = `${entry.params.id}.${entry.params.groupID}`;
                        this.asked.push({ key, prio });
                        setImmediate(() => callback(null, { ok: true, result: { scene: answers[key] } }));
                    },
                },
                dssStruct: {
                    stateMap: {
                        '5.1.scenes.17': 'apartment.zones.5.groups.1.scenes.Preset2',
                        '5.1.scenes.5': 'apartment.zones.5.groups.1.scenes.Preset1',
                        '5.2.scenes.0': 'apartment.zones.5.groups.2.scenes.Preset0',
                    },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
        }

        it('applies a scene that changed while the adapter was starting', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = resyncContext(dss, { 5.1: 5, 5.2: 0 });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                    expect(
                        ctx.states['apartment.zones.5.groups.1.scenes.Preset1'],
                        'the scene missed during the startup must be applied',
                    ).to.equal(true);
                    expect(
                        ctx.states['apartment.zones.5.groups.1.scenes.Preset2'],
                        'and the old one must be released',
                    ).to.equal(false);
                    expect(ctx.lastScenes['5.1'], 'the bookkeeping must follow').to.equal('5');
                    dss.stop();
                    done();
                });
            });
        });

        it('changes nothing when no scene changed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = resyncContext(dss, { 5.1: 17, 5.2: 0 });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                    expect(ctx.states, 'an unchanged scene must not produce a write').to.deep.equal({});
                    dss.stop();
                    done();
                });
            });
        });

        it('only asks for zone groups, not for devices, and only with low priority', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = resyncContext(dss, { 5.1: 17, 5.2: 0 });
            Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                expect(ctx.dssQueue.asked.map(a => a.key).sort()).to.deep.equal(['5.1', '5.2']);
                ctx.dssQueue.asked.forEach(a => expect(a.prio, 'must never delay a user command').to.equal('low'));
                dss.stop();
                done();
            });
        });

        it('does nothing while the adapter is stopping', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = resyncContext(dss, {});
            ctx.stopping = true;
            Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                expect(ctx.dssQueue.asked, 'no request during the unload').to.deep.equal([]);
                dss.stop();
                done();
            });
        });
    });
});
