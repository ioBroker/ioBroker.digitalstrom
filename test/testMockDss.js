const assert = require('node:assert');
const proxyquire = require('proxyquire');
const { DSS } = require('../build/lib/dss');
const { DSSQueue } = require('../build/lib/dssQueue');
const { DSSStructure } = require('../build/lib/dssStructure');
const { createMockDss, APP_TOKEN } = require('./lib/mockDss');
const { delay, callbackPromise, nodeCallbackPromise, waitFor, adapterTimers } = require('./lib/helpers');

// adapter-core needs a running js-controller, which is not available here. Only the
// prototype methods are used, exactly like in testAdapter.js.
const { Digitalstrom } = proxyquire('../build/main', {
    '@iobroker/adapter-core': {
        Adapter: class FakeAdapter {
            on() {}
        },
        '@noCallThru': true,
    },
    '@apollon/iobroker-tools': {
        objectHelper: { init: () => {} },
        '@noCallThru': true,
    },
});

const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Builds an adapter context that talks to the mock DSS through the real DSS client,
 * the real queue and the real structure - only js-controller is replaced.
 *
 * @param {string} host mock DSS host
 * @param {Record<string, any>} [config] adapter configuration overrides
 * @returns {Record<string, any>} adapter-like context, carrying the adapter prototype
 * methods next to the state a test wants to inspect
 */
function createAdapterContext(host, config = {}) {
    const ctx = {
        ...adapterTimers,
        log: silentLog,
        config: {
            host,
            appToken: APP_TOKEN,
            validateCertificate: false,
            usePresetValues: true,
            initializeOutputValues: true,
            deleteUnknownObjects: false,
            dataPollInterval: 0,
            ...config,
        },
        connected: null,
        states: {},
        lastScenes: {},
        stopping: false,
        stopped: false,
        stopCallbacks: [],
        tokenConnections: new Set(),
        unhandledStateNames: new Set(),
        eventHandlersRegistered: false,
        /** @type {number[]} */
        restarts: [],
        dataPollTimeout: null,
        restartTimeout: null,
        startupTimeout: null,
        stopGuardTimeout: 500,

        setState(id, value) {
            this.states[id] = value && typeof value === 'object' && value.val !== undefined ? value.val : value;
        },
        isStopping: Digitalstrom.prototype.isStopping,
        setConnected: Digitalstrom.prototype.setConnected,
        coerceScalarValue: Digitalstrom.prototype.coerceScalarValue,
        coerceStateValue: Digitalstrom.prototype.coerceStateValue,
        setDssState: Digitalstrom.prototype.setDssState,
        eventLog: Digitalstrom.prototype.eventLog,
        registerEventHandlers: Digitalstrom.prototype.registerEventHandlers,
        parkable: Digitalstrom.prototype.parkable,
        liveOnly: Digitalstrom.prototype.liveOnly,
        resyncSceneStates: Digitalstrom.prototype.resyncSceneStates,
        initializeSubscriptions: Digitalstrom.prototype.initializeSubscriptions,
        stopAdapter: Digitalstrom.prototype.stopAdapter,
        /**
         * @param {number} timeout
         */
        restartAdapter(timeout) {
            this.restarts.push(timeout);
        },
        waitForDss: Digitalstrom.prototype.waitForDss,
        noteDssReachable: Digitalstrom.prototype.noteDssReachable,
        noteDssUnreachable: Digitalstrom.prototype.noteDssUnreachable,
        /** @type {NodeJS.Timeout|null} */
        dssRetryTimeout: null,
        dssRetryDelay: 50,
        /** @type {{since: number, failures: number, reported: Set<string>}|null} */
        dssOutage: null,
        subscribeStates: () => {},
        clearAdditionalObjects: () => {},
    };

    ctx.dss = new DSS({
        host: ctx.config.host,
        appToken: ctx.config.appToken,
        validateCertificate: false,
        logger: silentLog,
        // Keep the long-polls short so the tests stay fast
        subScriptionTimeout: 500,
    });
    ctx.dssQueue = new DSSQueue({
        logger: silentLog,
        prioTimeouts: { high: 1, medium: 2, low: 3 },
        dss: ctx.dss,
    });
    ctx.dssStruct = new DSSStructure({ dss: ctx.dss, dssQueue: ctx.dssQueue, adapter: ctx });
    return ctx;
}

describe('Integration against a local mock DSS', function () {
    this.timeout(20000);

    let mock;
    let ctx;

    beforeEach(async () => {
        mock = createMockDss();
        const host = await mock.start();
        ctx = createAdapterContext(host);
    });

    afterEach(async () => {
        if (ctx && !ctx.stopped) {
            await callbackPromise(done => Digitalstrom.prototype.stopAdapter.call(ctx, done));
        }
        ctx.dssStruct.clearTimeouts();
        await mock.stop();
    });

    describe('authentication', () => {
        it('logs in with the app token and reuses the session', async () => {
            const first = await ctx.dss.requestAsync('apartment', 'getName');
            const second = await ctx.dss.requestAsync('system', 'version');
            assert.strictEqual(first.result.name, 'Test Apartment');
            assert.strictEqual(second.result.version, '1.19.4');
            assert.strictEqual(mock.pathsCalled('system/loginApplication').length, 1, 'one login for both requests');
            assert.strictEqual(mock.pathsCalled('apartment/getName')[0].query.token, 'test-session-token');
        });

        it('reports a wrong app token instead of pretending a connection', async () => {
            const badCtx = createAdapterContext(mock.host(), { appToken: 'wrong' });
            /** @type {any} */
            let caught = null;
            try {
                await badCtx.dss.requestAsync('apartment', 'getName');
            } catch (err) {
                caught = err;
            }
            assert.notStrictEqual(caught, null, 'a wrong token must fail');
            assert.ok(caught.message.includes('Login failed'));
            badCtx.dss.stop();
        });

        it('renews the session when the DSS reports "not logged in"', async () => {
            await ctx.dss.requestAsync('apartment', 'getName');
            // The DSS invalidated the session, e.g. after a restart
            ctx.dss.sessionToken = 'stale';
            const res = await ctx.dss.requestAsync('system', 'version');
            assert.strictEqual(res.ok, true);
            assert.strictEqual(mock.pathsCalled('system/loginApplication').length, 2, 'a second login was needed');
        });
    });

    describe('initialization', () => {
        it('reads the whole structure and creates the expected objects', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));

            const ids = Object.keys(ctx.dssStruct.dssObjects);
            assert.ok(ids.includes('devices.meter1.dev1.brightness'), 'the device must exist');
            assert.ok(ids.includes('devices.meter1.EnergyMeterValue'), 'the circuit meter states must exist');
            assert.ok(ids.includes('apartment.scenes.Panic'), 'the apartment scenes must exist');
            assert.ok(ids.includes('apartment.0.5'), 'the zone must exist');
            assert.ok(ids.includes('apartment.0.5.scenes.Preset0'), 'the zone scenes must exist');
            assert.ok(ids.includes('apartment.userStates.testUserState'), 'the user state must exist');
            assert.ok(
                ids.includes('apartment.0.5.states.passiveCooling'),
                'the passive cooling state of the room must exist',
            );
            assert.strictEqual(ctx.dssStruct.initialObjectValues['apartment.0.5.states.passiveCooling'], 'active');
            // The mock lists the climate control under two app ids, as a real dSS does
            assert.ok(
                !ids.includes('apartment.0.5.states.passiveCooling_type9'),
                'one object per state, not a second one per app id',
            );
            assert.strictEqual(
                ctx.dssStruct.stateMap['zone.zone5.group0.type9.passiveCooling'],
                'apartment.0.5.states.passiveCooling',
            );
            assert.strictEqual(ctx.dssStruct.stateMap['dev1.brightness'], 'devices.meter1.dev1.brightness');
            assert.strictEqual(ctx.dssStruct.stateMap['5.1.scenes.5'], 'apartment.0.5.1.scenes.Preset1');
            // Regression guard for the scene 22/25 collision
            assert.ok(ids.includes('devices.meter1.dev1.scenes.Preset14'), 'scene 22 must have its own state');
            assert.ok(ids.includes('devices.meter1.dev1.scenes.Preset24'), 'scene 25 must have its own state');

            // Every request really went to the mock DSS
            const paths = mock.requests.map(entry => entry.path);
            [
                'apartment/getStructure',
                'apartment/getCircuits',
                'apartment/getSensorValues',
                'property/query',
                'property/query2',
            ].forEach(path => assert.ok(paths.includes(path), `${path} must have been requested`));
        });

        it('reads the device output values when the option is on', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await delay(300);
            assert.ok(mock.pathsCalled('device/getOutputValue').length > 0, 'the output value must be read');
        });

        it('reads no output values when the option is off, but stays controllable', async () => {
            const offCtx = createAdapterContext(mock.host(), { initializeOutputValues: false });
            await nodeCallbackPromise(done => offCtx.dssStruct.init(done));
            await delay(300);
            assert.strictEqual(mock.pathsCalled('device/getOutputValue').length, 0, 'no read when switched off');
            assert.strictEqual(
                typeof offCtx.dssStruct.dssObjects['devices.meter1.dev1.brightness'].onChange,
                'function',
                'but the write handler must exist',
            );
            offCtx.dssStruct.clearTimeouts();
            offCtx.dssQueue.stop();
            offCtx.dss.stop();
        });
    });

    describe('event subscription', () => {
        it('subscribes, receives an event and writes the state', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;
            ctx.lastScenes = ctx.dssStruct.initialScenes;

            await nodeCallbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));

            assert.ok(mock.subscribedEvents().includes('callScene'), 'callScene must be subscribed');
            assert.ok(mock.pathsCalled('event/subscribe').length > 0);

            mock.emitEvent('callScene', {
                name: 'callScene',
                source: { isGroup: true, isDevice: false, isApartment: false },
                properties: { zoneID: '5', groupID: '1', sceneID: '5', callOrigin: '-1' },
            });

            await delay(400);
            const sceneStateId = ctx.dssStruct.stateMap['5.1.scenes.5'];
            assert.strictEqual(typeof sceneStateId, 'string', 'the scene state must be known');
            assert.strictEqual(ctx.states[sceneStateId], true, 'the event must have been applied');
        });

        // The load on the DSS comes from the permanently open long-polls. All nine events
        // the adapter uses must therefore end up on ONE subscription id with ONE event/get.
        it('opens exactly one long-poll for all subscribed events', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;

            await nodeCallbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            await delay(200);

            assert.ok(mock.subscribedEvents().length > 1, 'several events are subscribed');
            assert.strictEqual(mock.subscriptionIds().length, 1, 'all of them on one subscription id');
            assert.strictEqual(mock.pathsCalled('event/get').length, 1, 'exactly one long-poll');
        });

        it('registers every handler only once', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            const listeners = ctx.dss.listenerCount('callScene');
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            assert.strictEqual(ctx.dss.listenerCount('callScene'), listeners);
        });
    });

    describe('superseded writes', () => {
        it('sends only the newest value of a fast slider movement', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;

            const onChange = ctx.dssStruct.dssObjects['devices.meter1.dev1.brightness'].onChange;
            assert.strictEqual(typeof onChange, 'function', 'the brightness must be writable');
            onChange(10);
            onChange(50);
            onChange(80);

            await delay(400);
            const values = mock.writtenOutputValues.map(entry => entry.value);
            assert.strictEqual(values.length, 1, 'only one write may reach the DSS');
            assert.strictEqual(values[0], Math.round((80 * 255) / 100), 'and it must carry the newest value');
        });

        it('logs a superseded write only as debug, a real error as warning', async () => {
            const levels = [];
            const logger = {
                silly: () => {},
                debug: () => levels.push('debug'),
                info: () => levels.push('info'),
                warn: () => levels.push('warn'),
                error: () => levels.push('error'),
            };
            ctx.log = logger;
            ctx.dssQueue.options.logger = logger;

            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;
            levels.length = 0;

            const onChange = ctx.dssStruct.dssObjects['devices.meter1.dev1.brightness'].onChange;
            onChange(10);
            onChange(80);
            await delay(300);
            assert.ok(!levels.includes('warn'), 'a coalesced write is not a failure');
            assert.ok(!levels.includes('error'));

            // A real failure of the DSS must still be visible
            levels.length = 0;
            ctx.dssStruct.logQueueError('Error while set State for apartment-user', new Error('HTTP 500'));
            assert.ok(levels.includes('warn'));
        });
    });

    describe('a dSS that refuses connections', () => {
        // The real client against a port nobody listens on - what the production log of
        // 26.09.2026 showed for 8.5 hours: connect ECONNREFUSED on the login
        it('is asked again in the same process until it answers', async () => {
            const port = new URL(mock.host()).port;
            await mock.stop();
            /** @type {string[]} */
            const errors = [];
            /** @type {string[]} */
            const infos = [];
            ctx.log = { ...silentLog, error: msg => errors.push(String(msg)), info: msg => infos.push(String(msg)) };
            /** @type {any[]} */
            const answers = [];
            Digitalstrom.prototype.waitForDss.call(ctx, dssName => answers.push(dssName));
            await waitFor(() => !!ctx.dssOutage && ctx.dssOutage.failures >= 3);
            assert.strictEqual(errors.length, 1, 'one error, not one per check');
            assert.ok(errors[0].includes('ECONNREFUSED'));

            // The dSS is back on the same address
            mock = createMockDss();
            await new Promise(resolve => mock.server.listen(Number(port), '127.0.0.1', () => resolve(undefined)));
            await waitFor(() => answers.length > 0);

            assert.strictEqual(answers[0].result.name, 'Test Apartment');
            assert.deepStrictEqual(ctx.restarts, [], 'the process was never restarted');
            assert.strictEqual(infos.filter(msg => msg.includes('answers again')).length, 1);
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(mock.pathsCalled('apartment/getName').length, 1, 'one check reached the dSS');
        });
    });

    describe('unload', () => {
        it('closes everything and starts nothing new afterwards', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            ctx.setConnected(true);
            assert.strictEqual(ctx.states['info.connection'], true);

            await callbackPromise(done => Digitalstrom.prototype.stopAdapter.call(ctx, done));

            assert.strictEqual(ctx.stopped, true, 'the stop must be finished');
            assert.strictEqual(ctx.dss.stopped, true, 'the DSS client must be closed');
            assert.strictEqual(ctx.dssQueue.stopped, true, 'the queue must be closed');
            assert.strictEqual(ctx.states['info.connection'], false, 'connected must be false');
            assert.strictEqual(ctx.dss.activeRequests.size, 0, 'no request may be left over');

            const requestsAfterStop = mock.requests.length;
            // A late startup callback and a late control command
            ctx.setConnected(true);
            Digitalstrom.prototype.startDataPolling.call(ctx);
            Digitalstrom.prototype.restartAdapter.call(ctx, 10);
            await delay(400);

            assert.strictEqual(ctx.states['info.connection'], false, 'connected must not become true again');
            assert.strictEqual(ctx.restartTimeout, null, 'no restart timer after the stop');
            assert.strictEqual(ctx.dataPollTimeout, null, 'no polling timer after the stop');
            assert.strictEqual(mock.requests.length, requestsAfterStop, 'no request after the stop');
        });

        it('answers every unload caller exactly once', async () => {
            let first = 0;
            let second = 0;
            Digitalstrom.prototype.stopAdapter.call(ctx, () => first++);
            Digitalstrom.prototype.stopAdapter.call(ctx, () => second++);
            await delay(800);
            assert.strictEqual(first, 1);
            assert.strictEqual(second, 1);
        });
    });
});
