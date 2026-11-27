const http = require('node:http');
const crypto = require('node:crypto');

// websocket.js exports the client class itself and hangs the constants off it. That
// second export is invisible to the checker behind the export assignment, so it is named
// here explicitly.
const { WEBSOCKET_GUID } = require('../../lib/websocket');

/**
 * Local stand-in for the new digitalSTROM API. Answers the REST endpoints the adapter
 * uses and speaks the notification websocket, so the client can be tested without a dSS.
 *
 * The shapes of the answers are cut down copies of what a real dSS 1.19.13 returned.
 */
function createMockSmartHome() {
    /** every request that arrived, as { method, path, query, body } */
    const requests = [];
    /** open notification sockets */
    const sockets = new Set();

    const apartment = {
        id: 'apartment-1',
        type: 'apartment',
        attributes: { name: 'Testwohnung' },
        included: {
            dsDevices: [{ id: 'dev1', type: 'dsDevice', attributes: { name: 'Lampe', zone: '2' } }],
            functionBlocks: [
                {
                    id: 'dev1',
                    type: 'functionBlock',
                    attributes: {
                        name: 'Lampe',
                        outputs: [{ id: 'brightness', attributes: { type: 'lightBrightness', min: 0, max: 100 } }],
                    },
                },
            ],
            zones: [{ id: '2', type: 'zone', attributes: { name: 'Wohnen' } }],
        },
    };

    const status = {
        id: 'apartment-1',
        type: 'apartmentStatus',
        attributes: { measurements: { temperature: 21.5 } },
        included: {
            dsDevices: [
                {
                    id: 'dev1',
                    type: 'dsDeviceStatus',
                    attributes: {
                        functionBlocks: [{ id: 'dev1', outputs: [{ id: 'brightness', value: 0, targetValue: 0 }] }],
                    },
                },
            ],
            zones: [{ id: '2', type: 'zoneStatus', attributes: { measurements: { temperature: 21.5 } } }],
        },
    };

    /** @type {any} */
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            // Whatever the adapter sent: parsed json of an arbitrary shape, or the raw
            // text when it is not json at all
            /** @type {any} */
            let body = null;
            if (raw) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    body = raw;
                }
            }
            requests.push({
                method: req.method,
                path: url.pathname,
                query,
                body,
                authorization: req.headers.authorization,
                cookie: req.headers.cookie,
            });

            const send = (code, payload, headers) => {
                res.writeHead(code, { 'Content-Type': 'application/json', ...(headers || {}) });
                res.end(payload === undefined ? '' : JSON.stringify(payload));
            };

            // The dSS takes the key OR the session of the classic interface as a
            // cookie - measured against a dSS20 1.19.13 for every read endpoint
            const keyOk = server.acceptKey && req.headers.authorization === `Bearer ${createMockSmartHome.API_KEY}`;
            const sessionOk = req.headers.cookie === `token=${server.sessionToken}`;
            if (
                !keyOk &&
                !sessionOk &&
                url.pathname.startsWith('/api/v1/apartment') &&
                url.pathname !== '/api/v1/apartment/applicationTokens'
            ) {
                return send(401, { error: 'unauthorized' });
            }

            if (req.method === 'GET' && url.pathname === '/api/v1/apartment') {
                return send(200, { data: apartment });
            }
            if (req.method === 'GET' && url.pathname === '/api/v1/apartment/status') {
                return send(200, { data: status });
            }
            if (req.method === 'GET' && /^\/api\/v1\/apartment\/zones\/[^/]+\/status$/.test(url.pathname)) {
                return send(200, { data: status.included.zones[0] });
            }
            if (req.method === 'GET' && url.pathname === '/api/v1/apartment/scenarios') {
                return send(200, {
                    data: {
                        scenarios: [
                            {
                                id: 'applicationZone-z1-g1-s17',
                                type: 'applicationZoneScenario',
                                attributes: { name: 'Hell', actionId: 'preset2' },
                            },
                            {
                                id: 'applicationZone-z1-g1-s18',
                                type: 'applicationZoneScenario',
                                attributes: { name: 'Licht' },
                            },
                            { id: 'applicationZone-z2-g2-s5', type: 'applicationZoneScenario', attributes: {} },
                        ],
                    },
                });
            }
            if (req.method === 'GET' && url.pathname === '/api/v1/apartment/meterings/values') {
                return send(200, {
                    data: { values: [{ id: 'apartment-power', attributes: { value: 139 } }] },
                });
            }
            if (
                req.method === 'PATCH' &&
                /^\/api\/v1\/apartment\/(dsDevices|zones)\/[^/]+\/status$/.test(url.pathname)
            ) {
                return send(204);
            }
            if (req.method === 'POST' && /^\/api\/v1\/apartment\/scenarios\/[^/]+\/invoke$/.test(url.pathname)) {
                return send(204);
            }
            if (req.method === 'POST' && url.pathname === '/api/v1/apartment/applicationTokens') {
                return send(201, undefined, {
                    Location: '/api/v1/apartment/applicationTokens/the-new-key',
                });
            }
            if (url.pathname === '/api/v1/broken') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end('{not json');
            }
            if (url.pathname === '/json/system/loginApplication') {
                return send(200, { ok: true, result: { token: 'session-token' } });
            }
            if (url.pathname === '/json/system/login') {
                if (query.password === 'correct') {
                    return send(200, { ok: true, result: { token: 'session-token' } });
                }
                // A wrong password is answered with HTTP 200 and ok:false, like a real dSS
                return send(200, { ok: false, message: 'Authentication failed' });
            }
            send(404, { error: 'not found' });
        });
    });

    // Notification websocket. Only the handshake and text frames, that is all the client
    // needs to be tested against.
    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        const accept = crypto
            .createHash('sha1')
            .update(key + WEBSOCKET_GUID)
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
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => sockets.delete(socket));
    });

    /**
     * Server side frame, unmasked as the protocol demands it for this direction.
     *
     * @param {string} text
     * @returns {Buffer}
     */
    function frame(text) {
        const payload = Buffer.from(text, 'utf8');
        const header = [0x81];
        if (payload.length < 126) {
            header.push(payload.length);
        } else {
            header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
        }
        return Buffer.concat([Buffer.from(header), payload]);
    }

    // Defaults: the key works, and this is the session the classic interface holds
    server.acceptKey = true;
    server.sessionToken = createMockSmartHome.SESSION_TOKEN;

    return {
        /** Lets the dSS reject the API key, as it does after a revoke */
        rejectKey() {
            server.acceptKey = false;
        },

        /**
         * The session the mock accepts as a cookie
         *
         * @param token
         */
        setSessionToken(token) {
            server.sessionToken = token;
        },

        server,
        requests,

        listen() {
            return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(this.baseUrl())));
        },

        baseUrl() {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('The mock is not listening on a TCP port');
            }
            return `http://127.0.0.1:${address.port}`;
        },

        port() {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('The mock is not listening on a TCP port');
            }
            return address.port;
        },

        /**
         * Sends a notification like the dSS does, terminated by the record separator.
         *
         * @param {string} type e.g. apartmentStatusChanged
         */
        notify(type) {
            const message = `${JSON.stringify({ type: 1, target: 'event', arguments: [{ type }] })}`;
            for (const socket of sockets) {
                socket.write(frame(message));
            }
        },

        /** @returns {number} number of open notification sockets */
        openSockets() {
            return sockets.size;
        },

        /** Drops every notification socket, as a dSS restart would */
        dropSockets() {
            for (const socket of sockets) {
                socket.destroy();
            }
            sockets.clear();
        },

        pathsCalled(pathname) {
            return requests.filter(entry => entry.path === pathname);
        },

        /** @returns {Promise<void>} */
        close() {
            this.dropSockets();
            return new Promise(resolve => server.close(() => resolve()));
        },
    };
}

createMockSmartHome.API_KEY = 'test-api-key';
createMockSmartHome.SESSION_TOKEN = 'test-session-token';

module.exports = createMockSmartHome;
