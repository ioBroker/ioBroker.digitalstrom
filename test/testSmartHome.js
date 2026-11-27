const { expect } = require('chai');

const DSSSmartHome = require('../lib/dssSmartHome');
const createMockSmartHome = require('./lib/mockSmartHome');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Smart Home API client', function () {
    this.timeout(15000);

    let mock;
    let client;

    beforeEach(async () => {
        mock = createMockSmartHome();
        await mock.listen();
    });

    afterEach(async () => {
        client && client.stop();
        client = null;
        await mock.close();
    });

    /**
     * @param {object} [overrides]
     * @returns {DSSSmartHome}
     */
    function createClient(overrides) {
        return new DSSSmartHome({
            host: mock.baseUrl(),
            apiKey: createMockSmartHome.API_KEY,
            logger: silentLogger,
            notificationPort: mock.port(),
            notificationDebounce: 60,
            notificationMaxDelay: 300,
            ...overrides,
        });
    }

    describe('reading', () => {
        it('unwraps the data envelope of the answer', async () => {
            client = createClient();
            const apartment = await client.getApartment();
            expect(apartment.type).to.equal('apartment');
            expect(apartment.included.dsDevices).to.have.lengthOf(1);
        });

        it('asks for every include in one request', async () => {
            client = createClient();
            await client.getApartment();
            const call = mock.pathsCalled('/api/v1/apartment')[0];
            expect(call.query.include).to.contain('dsDevices');
            expect(call.query.include).to.contain('functionBlocks');
            expect(call.query.include).to.contain('meterings');
            expect(mock.requests, 'exactly one request for the whole structure').to.have.lengthOf(1);
        });

        it('reads the status including the user defined states', async () => {
            client = createClient();
            await client.getApartmentStatus();
            const call = mock.pathsCalled('/api/v1/apartment/status')[0];
            expect(call.query.include).to.contain('userDefinedStates');
        });

        it('reads a single zone instead of the whole flat', async () => {
            client = createClient();
            const zone = await client.getZoneStatus(2);
            expect(zone.type).to.equal('zoneStatus');
            expect(mock.requests[0].path).to.equal('/api/v1/apartment/zones/2/status');
        });

        it('reads all meter values with one request', async () => {
            client = createClient();
            const values = await client.getMeteringValues();
            expect(values.values[0].attributes.value).to.equal(139);
            expect(mock.requests, 'one request for all meters').to.have.lengthOf(1);
        });

        it('reads the scenarios with their user given names', async () => {
            client = createClient();
            const answer = await client.getScenarios();
            expect(answer.scenarios[0].attributes.name).to.equal('Hell');
            expect(mock.requests[0].path).to.equal('/api/v1/apartment/scenarios');
        });
    });

    describe('errors', () => {
        it('reports the http status of a failed request', async () => {
            client = createClient({ apiKey: 'wrong' });
            /** @type {any} */
            let caught = null;
            try {
                await client.getApartment();
            } catch (err) {
                caught = err;
            }
            expect(caught, 'the request must fail').to.not.equal(null);
            expect(caught.status).to.equal(401);
            expect(caught.message).to.contain('HTTP 401');
        });

        it('reports a broken json answer instead of throwing somewhere else', async () => {
            client = createClient();
            /** @type {any} */
            let caught = null;
            try {
                await client.request('GET', '/api/v1/broken');
            } catch (err) {
                caught = err;
            }
            expect(caught).to.not.equal(null);
            expect(caught.message).to.contain('Invalid JSON');
        });

        // Ohne res.on('error') feuert bei einem FIN mitten im Body weder 'end' noch der
        // req-'error'-Handler - das Promise hinge fuer immer und der Request bliebe
        // in activeRequests stehen
        it('rejects instead of hanging when the connection dies in the middle of the body', async () => {
            const http = require('node:http');
            const broken = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
                res.write('{"data":');
                // end() the socket, not destroy(): a graceful FIN is the case that used
                // to hang, an RST was always caught by the request error handler
                setTimeout(() => res.socket && res.socket.end(), 20);
            });
            await new Promise(resolve => broken.listen(0, '127.0.0.1', () => resolve(undefined)));
            const address = /** @type {import('node:net').AddressInfo} */ (broken.address());
            const brokenClient = new DSSSmartHome({
                host: `http://127.0.0.1:${address.port}`,
                apiKey: 'irrelevant',
                logger: silentLogger,
            });
            /** @type {any} */
            let caught = null;
            try {
                await Promise.race([
                    brokenClient.request('GET', '/api/v1/apartment'),
                    delay(3000).then(() => {
                        throw new Error('the request hangs');
                    }),
                ]);
            } catch (err) {
                caught = err;
            }
            // Before stop(), which clears the set unconditionally and would hide a leak
            const openRequests = brokenClient.activeRequests.size;
            brokenClient.stop();
            await new Promise(resolve => broken.close(() => resolve(undefined)));
            expect(caught, 'the request must fail').to.not.equal(null);
            expect(caught.message).to.not.contain('the request hangs');
            expect(openRequests, 'the request is cleaned up').to.equal(0);
        });

        it('sends no request after stop()', async () => {
            client = createClient();
            client.stop();
            /** @type {any} */
            let caught = null;
            try {
                await client.getApartment();
            } catch (err) {
                caught = err;
            }
            expect(caught).to.not.equal(null);
            expect(caught.shutdown, 'marked as shutdown').to.equal(true);
            expect(mock.requests, 'nothing reached the server').to.have.lengthOf(0);
        });
    });

    describe('writing', () => {
        it('sets an output as a json patch', async () => {
            client = createClient();
            await client.setOutputValue('dev1', 'dev1', 'brightness', 42);
            const call = mock.pathsCalled('/api/v1/apartment/dsDevices/dev1/status')[0];
            expect(call.method).to.equal('PATCH');
            expect(call.body).to.deep.equal([
                { op: 'replace', path: '/functionBlocks/dev1/outputs/brightness/value', value: '42' },
            ]);
        });

        it('sets the set point of a zone', async () => {
            client = createClient();
            await client.setZoneSetpoint(2, 21.5);
            const call = mock.pathsCalled('/api/v1/apartment/zones/2/status')[0];
            expect(call.method).to.equal('PATCH');
            expect(call.body).to.deep.equal([
                { op: 'replace', path: '/applications/temperature/setpoint', value: 21.5 },
            ]);
        });

        it('invokes a scenario by its id', async () => {
            client = createClient();
            await client.invokeScenario('applicationZone-z2-g1-s18');
            expect(mock.requests[0].path).to.equal('/api/v1/apartment/scenarios/applicationZone-z2-g1-s18/invoke');
            expect(mock.requests[0].method).to.equal('POST');
        });

        it('accepts an empty answer of a write', async () => {
            client = createClient();
            const answer = await client.setOutputValue('dev1', 'dev1', 'brightness', 0);
            expect(answer).to.equal(null);
        });
    });

    describe('notifications', () => {
        // Regression: authHeaders() ran outside the try/catch, so a single failing session
        // login during a reconnect ended the reconnects for good.
        describe('reconnect with session login', () => {
            const sinon = require('sinon');
            const MiniWebsocket = require('../lib/websocket');
            let clock;
            let connect;
            beforeEach(() => {
                // Only setTimeout/clearTimeout are faked, and these two tests issue no
                // HTTP request - the real mock server of the outer describe keeps its
                // own socket timers. A request added here would hang at the time jump.
                clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                connect = sinon.stub(MiniWebsocket.prototype, 'connect').resolves();
                sinon.stub(MiniWebsocket.prototype, 'send');
                sinon.stub(MiniWebsocket.prototype, 'close');
            });
            afterEach(() => {
                client && client.stop();
                client = null;
                sinon.restore();
            });

            it('keeps reconnecting after a temporarily failing login', async () => {
                let logins = 0;
                client = createClient({
                    apiKey: undefined,
                    getSessionToken: async () => {
                        if (++logins === 1) {
                            throw new Error('login failed');
                        }
                        return 'token';
                    },
                });
                client.scheduleReconnect();
                await clock.tickAsync(2000);
                expect(logins).to.equal(1);
                expect(connect.called).to.equal(false);
                await clock.tickAsync(60000);
                expect(logins, 'login tried again').to.equal(2);
                expect(connect.callCount, 'one connection').to.equal(1);
            });

            it('opens no connection when stopped during the login', async () => {
                /** @type {(token: string) => void} */
                let release = () => {};
                client = createClient({
                    apiKey: undefined,
                    getSessionToken: () => new Promise(resolve => (release = resolve)),
                });
                const first = client.startNotifications();
                const second = client.startNotifications();
                client.stop();
                release('token');
                await Promise.allSettled([first, second]);
                await clock.tickAsync(60000);
                expect(connect.called).to.equal(false);
                expect(client.websocket).to.equal(null);
                expect(client.reconnectTimer).to.equal(null);
            });
        });

        it('connects and sends the signalr handshake with the record separator', async () => {
            client = createClient();
            await client.startNotifications();
            await delay(100);
            expect(mock.openSockets(), 'one open notification socket').to.equal(1);
        });

        // A moving blind fires several notifications per second, and every one of them
        // would cost a 59 KB status read on a real installation.
        it('collects a burst of notifications into a single event', async () => {
            client = createClient();
            const seen = [];
            client.on('statusChanged', types => seen.push(types));
            await client.startNotifications();
            await delay(80);

            for (let i = 0; i < 5; i++) {
                mock.notify('apartmentStatusChanged');
                await delay(10);
            }
            await delay(200);

            expect(seen, 'five notifications become one event').to.have.lengthOf(1);
            expect(seen[0]).to.deep.equal(['apartmentStatusChanged']);
        });

        it('reports at the latest after the maximum delay during a continuous stream', async () => {
            client = createClient({ notificationDebounce: 200, notificationMaxDelay: 300 });
            const seen = [];
            client.on('statusChanged', () => seen.push(Date.now()));
            await client.startNotifications();
            await delay(80);

            // Never a quiet moment longer than the debounce, so only the maximum delay helps
            const started = Date.now();
            while (Date.now() - started < 700) {
                mock.notify('apartmentStatusChanged');
                await delay(50);
            }
            await delay(100);

            expect(seen.length, 'the stream must not silence the client').to.be.at.least(2);
        });

        // Fuer die Diagnose: wie oft meldet der dSS wirklich, bevor entprellt wird
        it('reports every single notification before the debouncing', async () => {
            client = createClient();
            const raw = [];
            const debounced = [];
            client.on('notification', type => raw.push(type));
            client.on('statusChanged', () => debounced.push(Date.now()));
            await client.startNotifications();
            await delay(80);

            for (let i = 0; i < 4; i++) {
                mock.notify('apartmentStatusChanged');
                await delay(10);
            }
            await delay(200);

            expect(raw, 'every single message').to.have.lengthOf(4);
            expect(debounced, 'but only one summary').to.have.lengthOf(1);
        });

        it('separates a structure change from a status change', async () => {
            client = createClient();
            const events = [];
            client.on('statusChanged', () => events.push('status'));
            client.on('structureChanged', () => events.push('structure'));
            await client.startNotifications();
            await delay(80);

            mock.notify('apartmentStructureChanged');
            await delay(200);

            expect(events).to.deep.equal(['structure']);
        });

        it('reconnects after the dSS dropped the connection', async () => {
            client = createClient();
            let connects = 0;
            client.on('notificationConnected', () => connects++);
            await client.startNotifications();
            await delay(80);
            expect(connects).to.equal(1);

            mock.dropSockets();
            // The first backoff step is two seconds
            await delay(2600);

            expect(connects, 'the client comes back on its own').to.be.at.least(2);
            expect(mock.openSockets()).to.equal(1);
        });

        it('opens nothing more after stop()', async () => {
            client = createClient();
            await client.startNotifications();
            await delay(80);
            client.stop();
            mock.dropSockets();
            await delay(2600);
            expect(mock.openSockets(), 'no reconnect after stop').to.equal(0);
        });
    });

    // Live gemessen an einem dSS20 1.19.13: die neue API nimmt auch die Session der
    // klassischen Schnittstelle als Cookie an - fuer JEDEN Lese-Endpunkt und fuer den
    // Notification-Websocket. Der API-Key ist damit Komfort, keine Voraussetzung.
    describe('the session of the classic interface as credentials', () => {
        it('uses the key when there is one', async () => {
            client = createClient();
            await client.getApartment();
            const call = mock.pathsCalled('/api/v1/apartment')[0];
            expect(call.authorization).to.equal(`Bearer ${createMockSmartHome.API_KEY}`);
            expect(call.cookie).to.equal(undefined);
        });

        it('uses the session when there is no key', async () => {
            client = createClient({
                apiKey: undefined,
                getSessionToken: async () => createMockSmartHome.SESSION_TOKEN,
            });
            const apartment = await client.getApartment();
            expect(apartment.type, 'the answer arrives without a key').to.equal('apartment');
            const call = mock.pathsCalled('/api/v1/apartment')[0];
            expect(call.cookie).to.equal(`token=${createMockSmartHome.SESSION_TOKEN}`);
            expect(call.authorization).to.equal(undefined);
        });

        // Der Fall, der auf der echten Anlage zweimal zugeschlagen hat: der dSS
        // widerruft den Key, und bisher stand der Smart-Home-Pfad damit still
        it('switches to the session when the dSS rejects the key', async () => {
            const warnings = [];
            client = createClient({
                logger: Object.assign({}, silentLogger, { warn: msg => warnings.push(String(msg)) }),
                getSessionToken: async () => createMockSmartHome.SESSION_TOKEN,
            });
            mock.rejectKey();

            const apartment = await client.getApartment();
            expect(apartment.type, 'der Request kommt trotzdem durch').to.equal('apartment');
            expect(warnings.join(' '), 'einmal deutlich im Log').to.contain('rejected the Smart Home API key');

            // Der zweite Request versucht den toten Key gar nicht mehr
            const before = mock.pathsCalled('/api/v1/apartment/status').length;
            await client.getApartmentStatus();
            const calls = mock.pathsCalled('/api/v1/apartment/status');
            expect(calls).to.have.lengthOf(before + 1);
            expect(calls[calls.length - 1].cookie).to.equal(`token=${createMockSmartHome.SESSION_TOKEN}`);
            expect(warnings, 'die Warnung kommt nur einmal').to.have.lengthOf(1);
        });

        it('renews a stale session once and retries', async () => {
            let handedOut = 'stale-token';
            let renewals = 0;
            client = createClient({
                apiKey: undefined,
                getSessionToken: async forceRenew => {
                    if (forceRenew) {
                        renewals++;
                        handedOut = createMockSmartHome.SESSION_TOKEN;
                    }
                    return handedOut;
                },
            });

            const apartment = await client.getApartment();
            expect(renewals, 'genau eine Erneuerung').to.equal(1);
            expect(apartment.type).to.equal('apartment');
        });

        it('gives up when the renewed session is rejected as well', async () => {
            client = createClient({
                apiKey: undefined,
                getSessionToken: async () => 'always-wrong',
            });
            const failed = await client.getApartment().then(
                () => null,
                err => err,
            );
            expect(failed, 'der Fehler erreicht den Aufrufer').to.not.equal(null);
            expect(failed.status).to.equal(401);
        });
    });

    describe('api key', () => {
        it('creates the key from an existing app token, without a password', async () => {
            const key = await DSSSmartHome.createApiKey({
                host: mock.baseUrl(),
                appToken: 'existing-app-token',
                logger: silentLogger,
            });
            expect(key).to.equal('the-new-key');

            const login = mock.pathsCalled('/json/system/loginApplication');
            expect(login, 'the app token becomes a session').to.have.lengthOf(1);
            expect(login[0].query.loginToken).to.equal('existing-app-token');

            const created = mock.pathsCalled('/api/v1/apartment/applicationTokens');
            expect(created, 'exactly one token is created').to.have.lengthOf(1);
            expect(created[0].query.token, 'the session authorizes the creation').to.equal('session-token');
            expect(created[0].body.data.attributes.name).to.equal('ioBroker.digitalstrom');
        });

        // Ein falsches Passwort beantwortet der dSS mit HTTP 200 und ok:false - die
        // Meldung des dSS muss beim Benutzer ankommen, nicht ein generischer Satz
        it('surfaces the reason of the dSS when the password login fails', async () => {
            /** @type {any} */
            let caught = null;
            try {
                await DSSSmartHome.createApiKey({
                    host: mock.baseUrl(),
                    user: 'dssadmin',
                    password: 'wrong',
                    logger: silentLogger,
                });
            } catch (err) {
                caught = err;
            }
            expect(caught, 'the key creation must fail').to.not.equal(null);
            expect(caught.message).to.contain('Authentication failed');
        });
    });
});

describe('Websocket watchdog', function () {
    this.timeout(15000);

    const net = require('node:net');
    const crypto = require('node:crypto');
    // websocket.js exports the client class itself and hangs the handshake constants off
    // it. Behind that export assignment they are invisible to the checker, so the shape
    // of the module is named here.
    const MiniWebsocket = require('../lib/websocket');

    /**
     * A hand-rolled server that completes the handshake and then behaves as told.
     *
     * @param {(socket: import('node:net').Socket, data: Buffer) => void} onFrame what to do with client frames
     * @returns {Promise<{port: number, close: () => Promise<void>, frames: Buffer[]}>}
     */
    async function createSilentServer(onFrame) {
        const frames = [];
        /** @type {Set<import('node:net').Socket>} */
        const sockets = new Set();
        const server = net.createServer(socket => {
            // Every test closes its client at the end. On Windows that reaches this side as a
            // reset, and an 'error' without a listener is an uncaught exception that fails
            // whichever test is running at that moment ("read ECONNRESET").
            socket.on('error', () => {});
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.once('data', chunk => {
                const head = chunk.toString('utf8');
                const match = /Sec-WebSocket-Key: (\S+)/i.exec(head);
                const accept = crypto
                    .createHash('sha1')
                    .update((match ? match[1] : '') + MiniWebsocket.WEBSOCKET_GUID)
                    .digest('base64');
                socket.write(
                    [
                        'HTTP/1.1 101 Switching Protocols',
                        'Upgrade: websocket',
                        'Connection: Upgrade',
                        `Sec-WebSocket-Accept: ${accept}`,
                        '',
                        '',
                    ].join('\r\n'),
                );
                socket.on('data', data => {
                    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
                    frames.push(frame);
                    onFrame(socket, frame);
                });
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
        const address = /** @type {import('node:net').AddressInfo} */ (server.address());
        return {
            port: address.port,
            frames,
            close: () =>
                new Promise(resolve => {
                    // server.close() only waits for the open connections - end them instead
                    sockets.forEach(socket => socket.destroy());
                    server.close(() => resolve(undefined));
                }),
        };
    }

    // Eine halboffene Verbindung (dSS-Stromausfall, Routerwechsel) sendet kein FIN und
    // kein RST - ohne Watchdog bliebe der Notification-Kanal bis zum Neustart stumm
    it('pings a silent connection and declares it dead when nothing answers', async () => {
        const server = await createSilentServer(() => {
            // never answers - not even the pings
        });
        const socket = new MiniWebsocket({
            host: '127.0.0.1',
            port: server.port,
            path: '/api/v1/apartment/notifications',
            pingInterval: 80,
            idleTimeout: 200,
        });
        const errors = [];
        socket.on('error', err => errors.push(err.message));
        const closed = new Promise(resolve => socket.on('close', () => resolve(undefined)));
        await socket.connect();

        await Promise.race([
            closed,
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('the watchdog never fired')), 3000)),
        ]);
        expect(server.frames.length, 'the client pinged before giving up').to.be.at.least(1);
        expect(errors.join(' ')).to.contain('dead');
        socket.close();
        await server.close();
    });

    it('keeps the connection open as long as the pings are answered', async () => {
        const server = await createSilentServer(socket => {
            // An unmasked pong with an empty payload, the minimal sign of life
            socket.write(Buffer.from([0x8a, 0x00]));
        });
        const socket = new MiniWebsocket({
            host: '127.0.0.1',
            port: server.port,
            path: '/api/v1/apartment/notifications',
            pingInterval: 50,
            // Generous against event loop stalls on a crowded CI runner - the point is
            // "answered pings keep it alive", not the exact timing
            idleTimeout: 400,
        });
        let closedEarly = false;
        socket.on('close', () => (closedEarly = true));
        socket.on('error', () => {});
        await socket.connect();

        await new Promise(resolve => setTimeout(resolve, 500));
        expect(closedEarly, 'an answered ping keeps the connection alive').to.equal(false);
        socket.close();
        await server.close();
    });
});

describe('Meter values through the Smart Home API', () => {
    const DSSStructure = require('../lib/dssStructure');

    const CIRCUITS = [
        { dSUID: 'dsm-a', name: 'Küche', hasMetering: true },
        { dSUID: 'dsm-b', name: 'Bad', hasMetering: true },
        { dSUID: 'dsm-c', name: 'Virtuell', hasMetering: false },
    ];

    /**
     * @param {object} overrides
     * @returns {any} structure with just enough context for updateMeterData
     */
    function createStructure(overrides) {
        const written = [];
        const warnings = [];
        const errors = [];
        const restarts = [];
        const infoStates = [];
        const struct = /** @type {any} */ (
            new DSSStructure({
                dss: {},
                dssQueue: {},
                adapter: {
                    isStopping: () => false,
                    setState: (id, value, ack) => infoStates.push({ id, value, ack }),
                    restartAdapter: delay => restarts.push(delay),
                    log: {
                        silly: () => {},
                        debug: () => {},
                        info: () => {},
                        warn: message => warnings.push(message),
                        error: message => errors.push(message),
                    },
                },
                ...overrides,
            })
        );
        struct.apartmentCircuits = CIRCUITS;
        struct.setStateSafe = (id, value) => written.push({ id, value });
        struct.written = written;
        struct.warnings = warnings;
        struct.errors = errors;
        struct.restarts = restarts;
        struct.infoStates = infoStates;
        return struct;
    }

    it('reads every circuit with a single request and converts to kWh', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [
                        { id: 'dsm-dsm-a-power', attributes: { value: 30 } },
                        { id: 'dsm-dsm-a-energy', attributes: { value: 3600000 } },
                        { id: 'dsm-dsm-b-power', attributes: { value: 21 } },
                        { id: 'dsm-dsm-b-energy', attributes: { value: 7200000 } },
                    ],
                }),
            },
        });

        struct.updateMeterData((failed, total) => {
            expect(failed, 'no circuit is missing').to.equal(0);
            // Der Callback speist info.connection. Ein Zyklus, der nur die neue API benutzt
            // hat, darf ueber die klassische nichts behaupten - deshalb (0, 0).
            expect(total, 'a Smart Home only cycle judges nothing about the classic API').to.equal(0);
            expect(struct.written).to.deep.equal([
                { id: 'devices.dsm-a.PowerConsumption', value: 30 },
                // 3600000 Ws = 1 kWh, exactly the conversion of the classic path
                { id: 'devices.dsm-a.EnergyMeterValue', value: 1 },
                { id: 'devices.dsm-b.PowerConsumption', value: 21 },
                { id: 'devices.dsm-b.EnergyMeterValue', value: 2 },
            ]);
            done();
        });
    });

    it('rounds to whole watt hours and skips unchanged readings, like the classic path', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [
                        { id: 'dsm-dsm-a-power', attributes: { value: 0 } },
                        { id: 'dsm-dsm-a-energy', attributes: { value: 14435039223 } },
                        { id: 'dsm-dsm-b-power', attributes: { value: 21 } },
                        { id: 'dsm-dsm-b-energy', attributes: { value: 7200000 } },
                    ],
                }),
            },
        });
        const options = [];
        struct.setStateSafe = (id, value, opts) => {
            struct.written.push({ id, value });
            options.push(opts);
        };
        struct.updateMeterData(() => {
            expect(struct.written[1]).to.deep.equal({ id: 'devices.dsm-a.EnergyMeterValue', value: 4009.733 });
            expect(options, 'every meter write is a poll').to.have.lengthOf(4);
            options.forEach(opts => expect(opts).to.deep.equal({ skipUnchanged: true }));
            done();
        });
    });

    it('falls back to the classic API when the request fails', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => {
                    throw new Error('connection refused');
                },
            },
        });
        let classicCalls = 0;
        struct.updateMeterDataViaClassicApi = callback => {
            classicCalls++;
            callback(0, 2);
        };

        struct.updateMeterData(() => {
            expect(classicCalls, 'the classic path has to take over').to.equal(1);
            expect(struct.written, 'nothing may be written from a failed read').to.have.lengthOf(0);
            expect(struct.warnings.join(' ')).to.contain('classic API');
            done();
        });
    });

    it('warns about a failure only once', async () => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => {
                    throw new Error('still broken');
                },
            },
        });
        struct.updateMeterDataViaClassicApi = callback => callback(0, 0);

        await struct.updateMeterDataViaSmartHome();
        await struct.updateMeterDataViaSmartHome();
        await struct.updateMeterDataViaSmartHome();

        expect(struct.warnings, 'a permanent outage must not flood the log').to.have.lengthOf(1);
    });

    it('falls back when the answer knows none of the circuits', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [{ id: 'dsm-somewhere-else-power', attributes: { value: 5 } }],
                }),
            },
        });
        let classicCalls = 0;
        struct.updateMeterDataViaClassicApi = callback => {
            classicCalls++;
            callback(0, 2);
        };

        struct.updateMeterData(() => {
            expect(classicCalls, 'an unusable answer must not silently write nothing').to.equal(1);
            expect(struct.warnings.join(' ')).to.contain('no value for any known circuit');
            done();
        });
    });

    it('reports which API delivered the values', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [
                        { id: 'dsm-dsm-a-power', attributes: { value: 30 } },
                        { id: 'dsm-dsm-a-energy', attributes: { value: 3600000 } },
                        { id: 'dsm-dsm-b-power', attributes: { value: 21 } },
                        { id: 'dsm-dsm-b-energy', attributes: { value: 7200000 } },
                    ],
                }),
            },
        });
        struct.updateMeterData(() => {
            expect(struct.infoStates).to.deep.equal([{ id: 'info.meteringApi', value: 'smarthome', ack: true }]);
            done();
        });
    });

    // Der Rueckfall darf nicht still passieren - sonst sieht es aus, als liefe der Adapter
    // weiter auf der neuen API, waehrend in Wahrheit der alte Weg arbeitet
    it('reports the fallback to the classic API', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => {
                    throw new Error('gone');
                },
            },
            // Asynchron wie die echte Queue
            dssQueue: {
                pushQueryQueue: (dsuid, name, request, prio, cb) =>
                    setImmediate(() => cb(null, { ok: true, result: { consumption: 5, meterValue: 3600000 } })),
            },
        });
        struct.updateMeterData((failed, total) => {
            expect(struct.infoStates).to.deep.equal([{ id: 'info.meteringApi', value: 'classic', ack: true }]);
            expect(struct.written, 'the classic path writes two values per circuit').to.have.lengthOf(4);
            // Ein gescheiterter Smart-Home-Versuch plus vier klassische Requests
            expect(total, 'the failed attempt counts as a request').to.equal(5);
            expect(failed, 'only the Smart Home attempt failed').to.equal(1);
            done();
        });
    });

    it('reports a change of path only once', () => {
        const struct = createStructure({ smartHome: null });
        struct.reportMeteringApi('classic');
        struct.reportMeteringApi('classic');
        struct.reportMeteringApi('smarthome');
        struct.reportMeteringApi('smarthome');
        expect(struct.infoStates.map(entry => entry.value)).to.deep.equal(['classic', 'smarthome']);
    });

    // Bei einem teilweisen Erfolg arbeitet der klassische Weg mit - dann ist "classic" die
    // ehrlichere Auskunft als "smarthome"
    it('reports classic when only some circuits came from the new API', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [
                        { id: 'dsm-dsm-a-power', attributes: { value: 30 } },
                        { id: 'dsm-dsm-a-energy', attributes: { value: 3600000 } },
                    ],
                }),
            },
            dssQueue: {
                pushQueryQueue: (dsuid, name, request, prio, cb) =>
                    setImmediate(() => cb(null, { ok: true, result: { consumption: 7, meterValue: 7200000 } })),
            },
        });
        struct.updateMeterData(() => {
            expect(struct.infoStates.map(entry => entry.value)).to.deep.equal(['classic']);
            done();
        });
    });

    // Eine Firmware ohne /api/v1 antwortet mit 404 - dann ist jeder Versuch vor dem
    // maximalen Backoff verschwendet, genau wie bei einem abgelehnten Key
    it('backs off to the maximum when the API does not exist (HTTP 404)', async () => {
        const notFound = new Error('HTTP 404 for GET /api/v1/apartment/meterings/values');
        /** @type {any} */ (notFound).status = 404;
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => {
                    throw notFound;
                },
            },
        });
        await struct.updateMeterDataViaSmartHome();
        expect(struct.smartHomeMeterRetryAfter - struct.now()).to.be.closeTo(struct.smartHomeMeterRetryMax, 1000);
        expect(struct.warnings.join(' ')).to.contain('does not offer the Smart Home API');
    });

    // main.js plant den naechsten Poll-Zyklus ausschliesslich in diesem Callback - wirft
    // der Callback selbst, darf der Zyklus weder doppelt laufen noch lautlos enden.
    // Frueher endete so ein Fehler als unhandled rejection und js-controller startete den
    // Adapter neu; dieses Sicherheitsnetz stellt der Neustart wieder her.
    it('restarts the adapter instead of silencing a throwing poll callback', done => {
        const struct = createStructure({
            smartHome: {
                getMeteringValues: async () => ({
                    values: [
                        { id: 'dsm-dsm-a-power', attributes: { value: 30 } },
                        { id: 'dsm-dsm-a-energy', attributes: { value: 3600000 } },
                        { id: 'dsm-dsm-b-power', attributes: { value: 21 } },
                        { id: 'dsm-dsm-b-energy', attributes: { value: 7200000 } },
                    ],
                }),
            },
        });
        let calls = 0;
        struct.updateMeterData(() => {
            calls++;
            if (calls === 1) {
                setTimeout(() => {
                    expect(calls, 'the callback must not run twice').to.equal(1);
                    expect(struct.errors.join(' ')).to.contain('poll callback threw');
                    expect(struct.restarts, 'the safety net of the old behaviour').to.deep.equal([30000]);
                    done();
                }, 50);
                throw new Error('a broken consumer');
            }
        });
    });

    it('uses the classic path when the option is off', done => {
        const struct = createStructure({ smartHome: null });
        let classicCalls = 0;
        struct.updateMeterDataViaClassicApi = callback => {
            classicCalls++;
            callback(0, 2);
        };
        struct.updateMeterData(() => {
            expect(classicCalls).to.equal(1);
            done();
        });
    });
});
