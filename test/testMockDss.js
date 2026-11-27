const { expect } = require('chai');
const proxyquire = require('proxyquire');
const DSS = require('../lib/dss');
const DSSQueue = require('../lib/dssQueue');
const DSSStructure = require('../lib/dssStructure');
const { createMockDss, APP_TOKEN } = require('./lib/mockDss');
const { delay, callbackPromise, nodeCallbackPromise, waitFor } = require('./lib/helpers');

// adapter-core needs a running js-controller, which is not available here. Only the
// prototype methods are used, exactly like in testAdapter.js.
const { Digitalstrom } = proxyquire('../main', {
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
            expect(first.result.name).to.equal('Test Apartment');
            expect(second.result.version).to.equal('1.19.4');
            expect(mock.pathsCalled('system/loginApplication').length, 'one login for both requests').to.equal(1);
            expect(mock.pathsCalled('apartment/getName')[0].query.token).to.equal('test-session-token');
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
            expect(caught, 'a wrong token must fail').to.not.equal(null);
            expect(caught.message).to.contain('Login failed');
            badCtx.dss.stop();
        });

        it('renews the session when the DSS reports "not logged in"', async () => {
            await ctx.dss.requestAsync('apartment', 'getName');
            // The DSS invalidated the session, e.g. after a restart
            ctx.dss.sessionToken = 'stale';
            const res = await ctx.dss.requestAsync('system', 'version');
            expect(res.ok).to.equal(true);
            expect(mock.pathsCalled('system/loginApplication').length, 'a second login was needed').to.equal(2);
        });
    });

    describe('initialization', () => {
        it('reads the whole structure and creates the expected objects', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));

            const ids = Object.keys(ctx.dssStruct.dssObjects);
            expect(ids, 'the device must exist').to.include('devices.meter1.dev1.brightness');
            expect(ids, 'the circuit meter states must exist').to.include('devices.meter1.EnergyMeterValue');
            expect(ids, 'the apartment scenes must exist').to.include('apartment.scenes.Panic');
            expect(ids, 'the zone must exist').to.include('apartment.0.5');
            expect(ids, 'the zone scenes must exist').to.include('apartment.0.5.scenes.Preset0');
            expect(ids, 'the user state must exist').to.include('apartment.userStates.testUserState');
            expect(ids, 'the passive cooling state of the room must exist').to.include(
                'apartment.0.5.states.passiveCooling',
            );
            expect(ctx.dssStruct.initialObjectValues['apartment.0.5.states.passiveCooling']).to.equal('active');
            // The mock lists the climate control under two app ids, as a real dSS does
            expect(ids, 'one object per state, not a second one per app id').to.not.include(
                'apartment.0.5.states.passiveCooling_type9',
            );
            expect(ctx.dssStruct.stateMap['zone.zone5.group0.type9.passiveCooling']).to.equal(
                'apartment.0.5.states.passiveCooling',
            );
            expect(ctx.dssStruct.stateMap['dev1.brightness']).to.equal('devices.meter1.dev1.brightness');
            expect(ctx.dssStruct.stateMap['5.1.scenes.5']).to.equal('apartment.0.5.1.scenes.Preset1');
            // Regression guard for the scene 22/25 collision
            expect(ids, 'scene 22 must have its own state').to.include('devices.meter1.dev1.scenes.Preset14');
            expect(ids, 'scene 25 must have its own state').to.include('devices.meter1.dev1.scenes.Preset24');

            // Every request really went to the mock DSS
            const paths = mock.requests.map(entry => entry.path);
            [
                'apartment/getStructure',
                'apartment/getCircuits',
                'apartment/getSensorValues',
                'property/query',
                'property/query2',
            ].forEach(path => expect(paths, `${path} must have been requested`).to.include(path));
        });

        it('reads the device output values when the option is on', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await delay(300);
            expect(mock.pathsCalled('device/getOutputValue').length, 'the output value must be read').to.be.above(0);
        });

        it('reads no output values when the option is off, but stays controllable', async () => {
            const offCtx = createAdapterContext(mock.host(), { initializeOutputValues: false });
            await nodeCallbackPromise(done => offCtx.dssStruct.init(done));
            await delay(300);
            expect(mock.pathsCalled('device/getOutputValue').length, 'no read when switched off').to.equal(0);
            expect(
                offCtx.dssStruct.dssObjects['devices.meter1.dev1.brightness'].onChange,
                'but the write handler must exist',
            ).to.be.a('function');
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

            expect(mock.subscribedEvents(), 'callScene must be subscribed').to.include('callScene');
            expect(mock.pathsCalled('event/subscribe').length).to.be.above(0);

            mock.emitEvent('callScene', {
                name: 'callScene',
                source: { isGroup: true, isDevice: false, isApartment: false },
                properties: { zoneID: '5', groupID: '1', sceneID: '5', callOrigin: '-1' },
            });

            await delay(400);
            const sceneStateId = ctx.dssStruct.stateMap['5.1.scenes.5'];
            expect(sceneStateId, 'the scene state must be known').to.be.a('string');
            expect(ctx.states[sceneStateId], 'the event must have been applied').to.equal(true);
        });

        // The load on the DSS comes from the permanently open long-polls. All nine events
        // the adapter uses must therefore end up on ONE subscription id with ONE event/get.
        it('opens exactly one long-poll for all subscribed events', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;

            await nodeCallbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            await delay(200);

            expect(mock.subscribedEvents().length, 'several events are subscribed').to.be.above(1);
            expect(mock.subscriptionIds(), 'all of them on one subscription id').to.have.lengthOf(1);
            expect(mock.pathsCalled('event/get').length, 'exactly one long-poll').to.equal(1);
        });

        it('registers every handler only once', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            const listeners = ctx.dss.listenerCount('callScene');
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            expect(ctx.dss.listenerCount('callScene')).to.equal(listeners);
        });
    });

    describe('superseded writes', () => {
        it('sends only the newest value of a fast slider movement', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            ctx.dssStruct.objectsReady = true;

            const onChange = ctx.dssStruct.dssObjects['devices.meter1.dev1.brightness'].onChange;
            expect(onChange, 'the brightness must be writable').to.be.a('function');
            onChange(10);
            onChange(50);
            onChange(80);

            await delay(400);
            const values = mock.writtenOutputValues.map(entry => entry.value);
            expect(values.length, 'only one write may reach the DSS').to.equal(1);
            expect(values[0], 'and it must carry the newest value').to.equal(Math.round((80 * 255) / 100));
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
            expect(levels, 'a coalesced write is not a failure').to.not.include('warn');
            expect(levels).to.not.include('error');

            // A real failure of the DSS must still be visible
            levels.length = 0;
            ctx.dssStruct.logQueueError('Error while set State for apartment-user', new Error('HTTP 500'));
            expect(levels).to.include('warn');
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
            expect(errors, 'one error, not one per check').to.have.lengthOf(1);
            expect(errors[0]).to.contain('ECONNREFUSED');

            // The dSS is back on the same address
            mock = createMockDss();
            await new Promise(resolve => mock.server.listen(Number(port), '127.0.0.1', () => resolve(undefined)));
            await waitFor(() => answers.length > 0);

            expect(answers[0].result.name).to.equal('Test Apartment');
            expect(ctx.restarts, 'the process was never restarted').to.deep.equal([]);
            expect(infos.filter(msg => msg.includes('answers again'))).to.have.lengthOf(1);
            expect(errors).to.have.lengthOf(1);
            expect(mock.pathsCalled('apartment/getName'), 'one check reached the dSS').to.have.lengthOf(1);
        });
    });

    describe('unload', () => {
        it('closes everything and starts nothing new afterwards', async () => {
            await nodeCallbackPromise(done => ctx.dssStruct.init(done));
            await callbackPromise(done => Digitalstrom.prototype.initializeSubscriptions.call(ctx, done));
            ctx.setConnected(true);
            expect(ctx.states['info.connection']).to.equal(true);

            await callbackPromise(done => Digitalstrom.prototype.stopAdapter.call(ctx, done));

            expect(ctx.stopped, 'the stop must be finished').to.equal(true);
            expect(ctx.dss.stopped, 'the DSS client must be closed').to.equal(true);
            expect(ctx.dssQueue.stopped, 'the queue must be closed').to.equal(true);
            expect(ctx.states['info.connection'], 'connected must be false').to.equal(false);
            expect(ctx.dss.activeRequests.size, 'no request may be left over').to.equal(0);

            const requestsAfterStop = mock.requests.length;
            // A late startup callback and a late control command
            ctx.setConnected(true);
            Digitalstrom.prototype.startDataPolling.call(ctx);
            Digitalstrom.prototype.restartAdapter.call(ctx, 10);
            await delay(400);

            expect(ctx.states['info.connection'], 'connected must not become true again').to.equal(false);
            expect(ctx.restartTimeout, 'no restart timer after the stop').to.equal(null);
            expect(ctx.dataPollTimeout, 'no polling timer after the stop').to.equal(null);
            expect(mock.requests.length, 'no request after the stop').to.equal(requestsAfterStop);
        });

        it('answers every unload caller exactly once', async () => {
            let first = 0;
            let second = 0;
            Digitalstrom.prototype.stopAdapter.call(ctx, () => first++);
            Digitalstrom.prototype.stopAdapter.call(ctx, () => second++);
            await delay(800);
            expect(first).to.equal(1);
            expect(second).to.equal(1);
        });
    });
});
