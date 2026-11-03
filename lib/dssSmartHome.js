const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { normalizeBoolean, errorMessage } = require('./configUtils');
const DSS = require('./dss');
const MiniWebsocket = require('./websocket');

/**
 * Client for the digitalSTROM "Smart Home API" (/api/v1) plus its notification websocket.
 *
 * Verified against a dSS20 with firmware 1.19.13 on 2026-08-30, see docs/smarthome-api.md.
 * The official documentation (developer.digitalstrom.org/api) is offline, so everything in
 * here comes from what a real dSS answers - including the places where it deviates from
 * the published specification.
 *
 * Deliberately NOT covered by this API, it stays with the classic JSON API:
 * device sensor values, binary inputs, button presses and scene call details. The
 * notification websocket only knows apartmentStatusChanged and apartmentStructureChanged
 * and carries no payload at all.
 *
 * @typedef {import('./configUtils').AdapterError} AdapterError
 */

/**
 * Logger this client writes to; it hands over ready formatted messages. Which levels
 * exist is up to the owner - the ioBroker adapter logger brings all of them, a script
 * may pass nothing but `debug` - so this is a record by level name and not a fixed
 * shape. The client itself uses `debug` and `warn`.
 *
 * @typedef {Record<string, (message: string) => void>} SmartHomeLogger
 */

/**
 * Query parameters of a request, appended to the URL as they are. Every value goes
 * through String(), so anything that has a sensible text form is allowed.
 *
 * @typedef {Record<string, string|number|boolean>} QueryParams
 */

const DEFAULT_REQUEST_TIMEOUT = 30 * 1000;
const DEFAULT_NOTIFICATION_PORT = 8090;
/**
 * The dSS fires several notifications per second while something is moving, and every
 * flushed notification costs the consumer a ~59 KB status read. Measured against a real
 * installation: with a short debounce a moving blind produced 37 status reads (2.2 MB) in
 * three minutes, so the coalescing window is deliberately long - this channel is a safety
 * net behind the classic event long-poll, not a realtime feed.
 */
const DEFAULT_NOTIFICATION_DEBOUNCE = 5000;
/** Even a continuous stream of notifications has to reach the consumer at some point */
const DEFAULT_NOTIFICATION_MAX_DELAY = 15000;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 60000;
/** SignalR terminates every message with this character */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** Everything the apartment resource can deliver in one request */
const APARTMENT_INCLUDES = [
    'installation',
    'dsDevices',
    'submodules',
    'functionBlocks',
    'zones',
    'clusters',
    'applications',
    'dsServer',
    'controllers',
    'apiRevision',
    'meterings',
].join(',');

/** Everything the status resource can deliver in one request */
const STATUS_INCLUDES = ['dsDevices', 'zones', 'clusters', 'userDefinedStates'].join(',');

class SmartHomeError extends Error {
    /**
     * @param {string} message
     * @param {number} [status] HTTP status code, if the dSS answered at all
     * @param {ErrorOptions} [options]
     */
    constructor(message, status, options) {
        super(message, options);
        this.name = 'SmartHomeError';
        /** @type {number|undefined} */
        this.status = status;
        /** @type {string|undefined} node style error code, e.g. ETIMEDOUT */
        this.code = undefined;
        /** @type {boolean|undefined} true when the request was cancelled by stop() */
        this.shutdown = undefined;
    }
}

/**
 * @param {string} message
 * @returns {SmartHomeError}
 */
function stoppedError(message) {
    const err = new SmartHomeError(message);
    err.shutdown = true;
    return err;
}

class DSSSmartHome extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host dSS host, with or without scheme and port
     * @param {string} options.apiKey the bearer key from System > Access Authorization
     * @param {(forceRenew?: boolean) => Promise<string>} [options.getSessionToken] session of the
     *   classic interface, used as a cookie when there is no key or the key is rejected
     * @param {SmartHomeLogger} [options.logger]
     * @param {boolean} [options.validateCertificate]
     * @param {number} [options.requestTimeout]
     * @param {number} [options.notificationPort] default 8090
     * @param {number} [options.notificationDebounce] ms, default 5000, 0 disables
     * @param {number} [options.notificationMaxDelay] ms, default 15000, 0 disables the cap
     * @param {(kind: string, detail: string) => void} [options.onActivity] Zaehl-Haken je Request
     */
    constructor(options) {
        super();
        this.options = options || {};
        this.logger = this.options.logger || null;
        this.apiKey = this.options.apiKey;
        /**
         * The new API also accepts the session of the classic interface as a cookie -
         * measured against a dSS20 1.19.13 for every endpoint this client reads and
         * for the notification websocket. That makes the API key optional: without one
         * the adapter uses the login it has anyway, and a key the dSS rejects no longer
         * takes the Smart Home path down with it.
         */
        this.getSessionToken = this.options.getSessionToken || null;
        /** Set once the dSS rejected the key - from then on the session serves */
        this.apiKeyRejected = false;
        this.baseUrl = DSS.buildBaseUrl(this.options.host);
        this.isSecure = this.baseUrl.startsWith('https:');
        this.transport = this.isSecure ? https : http;
        this.requestTimeout = this.options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
        this.notificationPort = this.options.notificationPort || DEFAULT_NOTIFICATION_PORT;
        this.notificationDebounce =
            this.options.notificationDebounce === undefined
                ? DEFAULT_NOTIFICATION_DEBOUNCE
                : this.options.notificationDebounce;
        this.notificationMaxDelay =
            this.options.notificationMaxDelay === undefined
                ? DEFAULT_NOTIFICATION_MAX_DELAY
                : this.options.notificationMaxDelay;
        this.rejectUnauthorized = normalizeBoolean(this.options.validateCertificate, false);
        /**
         * Optionaler Zaehl-Haken fuer die Aktivitaetsanzeige: ('request', apiPath).
         *
         * @type {((kind: string, detail: string) => void)|null}
         */
        this.onActivity = typeof this.options.onActivity === 'function' ? this.options.onActivity : null;

        this.agent = new this.transport.Agent({
            // Same reasoning as in dss.js: the dSS closes idle connections, a pooled socket
            // that was closed in the meantime ends in "socket hang up" on the next request.
            keepAlive: false,
            rejectUnauthorized: this.rejectUnauthorized,
        });

        this.activeRequests = new Set();
        this.stopped = false;

        /** @type {MiniWebsocket|null} */
        this.websocket = null;
        this.reconnectTimer = null;
        this.notificationsStarting = false;
        this.reconnectAttempts = 0;
        /** Notification types that arrived since the last flush */
        this.pendingNotifications = new Set();
        this.debounceTimer = null;
        this.maxDelayTimer = null;
    }

    /**
     * @returns {string} host and port of the notification websocket
     */
    get notificationHost() {
        const url = new URL(this.baseUrl);
        return url.hostname;
    }

    /* ------------------------------------------------------------------ http */

    /**
     * The credentials for one request. The key is the primary path - it is permanent
     * and needs no renewal. Without a key (or after the dSS rejected it) the session
     * of the classic interface serves as a cookie; DSS.getSessionToken() renews it.
     *
     * @param {boolean} [forceRenew] fetch a fresh session instead of the cached one
     * @returns {Promise<Record<string, string>>}
     */
    async authHeaders(forceRenew) {
        if (this.apiKey && !this.apiKeyRejected) {
            return { Authorization: `Bearer ${this.apiKey}` };
        }
        if (!this.getSessionToken) {
            // No key left and no session available - the caller sees the dSS answer
            return { Authorization: `Bearer ${this.apiKey || ''}` };
        }
        return { Cookie: `token=${await this.getSessionToken(forceRenew)}` };
    }

    /**
     * One request against the new API. An answer that rejects the credentials is
     * retried once: a rejected key switches to the session, a stale session is
     * renewed. Only then does the error reach the caller.
     *
     * @param {string} method
     * @param {string} apiPath e.g. /api/v1/apartment
     * @param {QueryParams} [params] query parameters
     * @param {any} [body] json body
     * @returns {Promise<any>} the `data` field of the answer, or null for an empty body
     */
    async request(method, apiPath, params, body) {
        const usedKey = !!(this.apiKey && !this.apiKeyRejected);
        try {
            return await this.send(method, apiPath, params, body, await this.authHeaders());
        } catch (err) {
            const status = err instanceof SmartHomeError ? err.status : undefined;
            if (this.stopped || !this.getSessionToken || (status !== 401 && status !== 403)) {
                throw err;
            }
            if (usedKey) {
                // The key is gone - revoked in the dSS, or replaced by a newer one of
                // the same name. The login of the classic interface still works.
                this.apiKeyRejected = true;
                this.logger &&
                    this.logger.warn(
                        `The dSS rejected the Smart Home API key (HTTP ${status}) - using the login of the ` +
                            'classic interface instead. Create a new key in the adapter configuration when you ' +
                            'want one back.',
                    );
            } else {
                this.logger && this.logger.debug(`Renewing the session for ${apiPath} after HTTP ${status}`);
            }
            return await this.send(method, apiPath, params, body, await this.authHeaders(true));
        }
    }

    /**
     * @param {string} method
     * @param {string} apiPath
     * @param {QueryParams|undefined} params
     * @param {any} body
     * @param {Record<string, string>} authHeaders
     * @returns {Promise<any>}
     */
    send(method, apiPath, params, body, authHeaders) {
        return new Promise((resolve, reject) => {
            if (this.stopped) {
                const err = new SmartHomeError(`Client is stopped, not requesting ${apiPath}`);
                err.shutdown = true;
                return void reject(err);
            }
            const url = new URL(this.baseUrl + apiPath);
            for (const [key, value] of Object.entries(params || {})) {
                url.searchParams.set(key, String(value));
            }
            const payload = body === undefined ? null : JSON.stringify(body);
            /** @type {Record<string, string|number>} */
            const headers = { ...authHeaders };
            if (payload !== null) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(payload);
            }

            let req;
            const done = (err, value) => {
                if (req) {
                    this.activeRequests.delete(req);
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(value);
                }
            };

            this.onActivity && this.onActivity('request', apiPath);
            req = this.transport.request(
                {
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: `${url.pathname}${url.search}`,
                    method,
                    headers,
                    agent: this.agent,
                    timeout: this.requestTimeout,
                },
                res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        const status = res.statusCode || 0;
                        if (status >= 300) {
                            return done(
                                new SmartHomeError(
                                    `HTTP ${status} for ${method} ${apiPath}${data ? `: ${data.slice(0, 200)}` : ''}`,
                                    status,
                                ),
                            );
                        }
                        if (!data) {
                            // PATCH and POST answer without a body
                            return done(null, null);
                        }
                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch (err) {
                            return done(
                                new SmartHomeError(`Invalid JSON answer for ${apiPath}: ${errorMessage(err)}`, status, {
                                    cause: /** @type {Error} */ (err),
                                }),
                            );
                        }
                        // Every answer of this API is wrapped in a data envelope
                        done(null, parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed);
                    });
                    // Without this handler a connection that dies in the middle of the
                    // response body would neither reject nor resolve - the promise
                    // would hang forever, because req 'error' does not fire either.
                    res.on('error', err => {
                        if (this.stopped) {
                            return done(stoppedError(`Request for ${apiPath} was cancelled by stop()`));
                        }
                        done(
                            new SmartHomeError(
                                `Response error for ${method} ${apiPath}: ${errorMessage(err)}`,
                                undefined,
                                {
                                    cause: /** @type {Error} */ (err),
                                },
                            ),
                        );
                    });
                },
            );
            this.activeRequests.add(req);
            req.on('timeout', () => {
                const err = new SmartHomeError(`Timeout after ${this.requestTimeout} ms for ${apiPath}`);
                err.code = 'ETIMEDOUT';
                req.destroy(err);
            });
            req.on('error', err => {
                if (this.stopped) {
                    const stoppedErr = new SmartHomeError(`Request for ${apiPath} was cancelled by stop()`);
                    stoppedErr.shutdown = true;
                    return done(stoppedErr);
                }
                done(err);
            });
            req.end(payload === null ? undefined : payload);
        });
    }

    /* -------------------------------------------------------------- reading */

    /**
     * The complete structure in one request. About 260 KB for a flat with 96 devices.
     *
     * @returns {Promise<any>}
     */
    getApartment() {
        return this.request('GET', '/api/v1/apartment', { include: APARTMENT_INCLUDES });
    }

    /**
     * All current values in one request: apartment level, device outputs, zone
     * measurements, cluster locks and the user defined states.
     *
     * @returns {Promise<any>}
     */
    getApartmentStatus() {
        return this.request('GET', '/api/v1/apartment/status', { include: STATUS_INCLUDES });
    }

    /**
     * Status of a single zone, about 1 KB. Cheaper than the full status when only one
     * zone is of interest.
     *
     * @param {string|number} zoneId
     * @returns {Promise<any>}
     */
    getZoneStatus(zoneId) {
        return this.request('GET', `/api/v1/apartment/zones/${encodeURIComponent(String(zoneId))}/status`);
    }

    /**
     * All scenarios with the names the user gave them in digitalSTROM. The id encodes
     * zone, group and scene: applicationZone-z1-g1-s17.
     *
     * @returns {Promise<any>}
     */
    getScenarios() {
        return this.request('GET', '/api/v1/apartment/scenarios');
    }

    /**
     * @returns {Promise<any>} the metering points, including their unit and origin
     */
    getMeterings() {
        return this.request('GET', '/api/v1/apartment/meterings');
    }

    /**
     * All meter values in ONE request - the classic API needs two per circuit.
     *
     * @returns {Promise<any>}
     */
    getMeteringValues() {
        return this.request('GET', '/api/v1/apartment/meterings/values');
    }

    /* -------------------------------------------------------------- writing */

    /**
     * Sets one output of a device.
     *
     * @param {string} deviceId dSUID of the device
     * @param {string} functionBlockId usually identical to the device id
     * @param {string} outputId e.g. brightness, shadePositionOutside
     * @param {number} value in the range the function block declares, usually 0..100
     * @returns {Promise<any>}
     */
    setOutputValue(deviceId, functionBlockId, outputId, value) {
        return this.request('PATCH', `/api/v1/apartment/dsDevices/${encodeURIComponent(deviceId)}/status`, undefined, [
            {
                op: 'replace',
                path: `/functionBlocks/${functionBlockId}/outputs/${outputId}/value`,
                value: String(value),
            },
        ]);
    }

    /**
     * Sets the set point of the room temperature control of a zone.
     *
     * @param {string|number} zoneId
     * @param {number} value in degrees celsius
     * @returns {Promise<any>}
     */
    setZoneSetpoint(zoneId, value) {
        return this.request(
            'PATCH',
            `/api/v1/apartment/zones/${encodeURIComponent(String(zoneId))}/status`,
            undefined,
            [{ op: 'replace', path: '/applications/temperature/setpoint', value }],
        );
    }

    /**
     * Calls a scenario. Its id encodes zone, group and scene, for example
     * applicationZone-z2274-g1-s18.
     *
     * @param {string} scenarioId
     * @returns {Promise<any>}
     */
    invokeScenario(scenarioId) {
        return this.request(
            'POST',
            `/api/v1/apartment/scenarios/${encodeURIComponent(scenarioId)}/invoke`,
            undefined,
            {},
        );
    }

    /* -------------------------------------------------------- notifications */

    /**
     * Opens the notification websocket and keeps it open.
     *
     * The connection carries exactly two message types and no payload, so every
     * notification only says THAT something changed. The consumer has to read the status
     * again - which is why the events are debounced here: a moving blind produces several
     * notifications per second, and every one of them would cost a 59 KB status read.
     *
     * Resolves WITHOUT a connection when there is nothing to do: after stop(), when a
     * socket already exists and when another start is still waiting for the login. The
     * caller therefore has to look at the socket before reporting an open channel.
     *
     * @returns {Promise<void>} resolves once the socket is connected, or immediately in
     *   the cases above
     */
    async startNotifications() {
        if (this.stopped || this.websocket || this.notificationsStarting) {
            return;
        }
        // Same credentials as the REST calls, so the channel keeps working when the key
        // is missing or rejected. A failing session login must plan the next attempt
        // just like a failing connect, otherwise the reconnects end here for good.
        let headers;
        this.notificationsStarting = true;
        try {
            headers = await this.authHeaders();
        } catch (err) {
            if (!this.stopped) {
                this.scheduleReconnect();
            }
            throw err;
        } finally {
            this.notificationsStarting = false;
        }
        // stop() may have run while waiting for the login
        if (this.stopped) {
            return;
        }
        const socket = new MiniWebsocket({
            host: this.notificationHost,
            port: this.notificationPort,
            path: '/api/v1/apartment/notifications',
            headers,
            // The notification port speaks plain ws, unlike the REST API on 8080
            secure: false,
            rejectUnauthorized: this.rejectUnauthorized,
        });
        this.websocket = socket;

        socket.on('message', text => this.handleNotification(text));
        socket.on('error', err => {
            this.logger && this.logger.debug(`Notification websocket error: ${errorMessage(err)}`);
        });
        socket.on('close', () => {
            if (this.websocket === socket) {
                this.websocket = null;
            }
            if (!this.stopped) {
                this.emit('notificationClosed');
                this.scheduleReconnect();
            }
        });

        try {
            await socket.connect();
        } catch (err) {
            this.websocket = null;
            if (!this.stopped) {
                this.scheduleReconnect();
            }
            throw err;
        }

        // SignalR handshake. The dSS answers with an empty object and then sends its
        // notifications, every message terminated by the record separator.
        socket.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${RECORD_SEPARATOR}`);
        this.reconnectAttempts = 0;
        this.emit('notificationConnected');
    }

    /**
     * @param {string} text one or more SignalR messages
     */
    handleNotification(text) {
        for (const part of text.split(RECORD_SEPARATOR)) {
            if (!part.trim()) {
                continue;
            }
            let message;
            try {
                message = JSON.parse(part);
            } catch (err) {
                this.logger && this.logger.debug(`Unreadable notification: ${errorMessage(err)}`);
                continue;
            }
            const args = Array.isArray(message && message.arguments) ? message.arguments : [];
            for (const argument of args) {
                if (argument && argument.type) {
                    this.pendingNotifications.add(argument.type);
                    // Vor der Entprellung: wer zaehlen will, wie oft der dSS wirklich
                    // meldet, braucht die einzelne Meldung und nicht die Zusammenfassung
                    this.emit('notification', argument.type);
                }
            }
            if (args.length) {
                this.scheduleFlush();
            }
        }
    }

    /**
     * Collects notifications and reports them at most every notificationDebounce ms,
     * and at the latest after notificationMaxDelay.
     */
    scheduleFlush() {
        if (!this.notificationDebounce) {
            return void this.flushNotifications();
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.flushNotifications(), this.notificationDebounce);
        if (this.notificationMaxDelay && !this.maxDelayTimer) {
            this.maxDelayTimer = setTimeout(() => this.flushNotifications(), this.notificationMaxDelay);
        }
    }

    flushNotifications() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxDelayTimer) {
            clearTimeout(this.maxDelayTimer);
            this.maxDelayTimer = null;
        }
        if (!this.pendingNotifications.size || this.stopped) {
            this.pendingNotifications.clear();
            return;
        }
        const types = [...this.pendingNotifications];
        this.pendingNotifications.clear();
        if (types.includes('apartmentStructureChanged')) {
            this.emit('structureChanged', types);
        }
        if (types.includes('apartmentStatusChanged')) {
            this.emit('statusChanged', types);
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.stopped) {
            return;
        }
        const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped) {
                return;
            }
            this.startNotifications().catch(err => {
                this.logger && this.logger.debug(`Notification reconnect failed: ${errorMessage(err)}`);
            });
        }, delay);
    }

    stopNotifications() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxDelayTimer) {
            clearTimeout(this.maxDelayTimer);
            this.maxDelayTimer = null;
        }
        this.pendingNotifications.clear();
        if (this.websocket) {
            const socket = this.websocket;
            this.websocket = null;
            socket.removeAllListeners();
            // A socket error arriving between here and the close would hit an emitter
            // without any 'error' listener, which throws as an uncaught exception
            socket.on('error', () => {});
            socket.close();
        }
    }

    stop() {
        this.stopped = true;
        this.stopNotifications();
        this.activeRequests.forEach(req => req.destroy());
        this.activeRequests.clear();
        this.agent.destroy();
    }

    /* ---------------------------------------------------------- api key */

    /**
     * Creates the bearer key for this API, once.
     *
     * The key is created through the CLASSIC api: an existing app token becomes a session
     * token, and that session creates the application token of the new API. The user
     * therefore does not have to enter the password again if the adapter is already
     * configured.
     *
     * @param {object} options
     * @param {string} options.host
     * @param {string} [options.appToken] existing app token of the classic API
     * @param {string} [options.user] alternatively user and password
     * @param {string} [options.password]
     * @param {string} [options.name] name shown in the dSS, default "ioBroker.digitalstrom"
     * @param {boolean} [options.validateCertificate]
     * @param {SmartHomeLogger} [options.logger]
     * @param {AbortSignal} [options.signal] aborts both temporary clients
     * @returns {Promise<string>} the bearer key
     */
    static async createApiKey(options) {
        const dss = new DSS({
            host: options.host,
            appToken: options.appToken,
            validateCertificate: options.validateCertificate,
            logger: options.logger,
        });
        /** @type {DSSSmartHome|null} */
        let client = null;
        const signal = options.signal;
        const abort = () => {
            dss.stop();
            client && client.stop();
        };
        signal && signal.addEventListener('abort', abort, { once: true });
        try {
            if (signal && signal.aborted) {
                throw stoppedError('Smart Home API key creation was cancelled');
            }
            let sessionToken;
            if (options.appToken) {
                // The DSS client already keeps a session, asking it avoids a second login
                sessionToken = await dss.getSessionToken();
            } else {
                const answer = await dss.httpRequest('/json/system/login', {
                    user: options.user,
                    password: options.password,
                });
                // A wrong password is answered with HTTP 200 and ok:false - without this
                // check the actual reason from the dSS would be thrown away
                if (!answer || answer.ok !== true) {
                    throw new SmartHomeError(`Login failed: ${(answer && answer.message) || 'unknown error'}`);
                }
                sessionToken = answer.result && answer.result.token;
            }
            if (!sessionToken) {
                throw new SmartHomeError('The dSS did not return a session token');
            }
            if (signal && signal.aborted) {
                throw stoppedError('Smart Home API key creation was cancelled');
            }

            client = new DSSSmartHome({
                host: options.host,
                apiKey: '',
                validateCertificate: options.validateCertificate,
                logger: options.logger,
            });
            // The answer carries the key in the Location header, not in the body, so
            // the raw request is done here instead of through request().
            const key = await client.requestApplicationToken(sessionToken, options.name || 'ioBroker.digitalstrom');
            if (signal && signal.aborted) {
                throw stoppedError('Smart Home API key creation was cancelled');
            }
            return key;
        } finally {
            signal && signal.removeEventListener('abort', abort);
            client && client.stop();
            dss.stop();
        }
    }

    /**
     * POST /api/v1/apartment/applicationTokens. Answers with 201 and the key in the
     * Location header.
     *
     * @param {string} sessionToken session token of the classic API
     * @param {string} name name of the application, visible in the dSS
     * @returns {Promise<string>} the bearer key
     */
    requestApplicationToken(sessionToken, name) {
        return new Promise((resolve, reject) => {
            if (this.stopped) {
                return void reject(stoppedError('Smart Home API client is stopped'));
            }
            const url = new URL(`${this.baseUrl}/api/v1/apartment/applicationTokens`);
            url.searchParams.set('token', sessionToken);
            const payload = JSON.stringify({
                data: { type: 'applicationToken', attributes: { name } },
            });
            let settled = false;
            let req;
            /**
             * @param {unknown} err
             * @param {string} [value]
             */
            const done = (err, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (req) {
                    this.activeRequests.delete(req);
                }
                if (err) {
                    reject(err);
                } else if (typeof value === 'string') {
                    resolve(value);
                } else {
                    reject(new SmartHomeError('The dSS did not return an application token'));
                }
            };
            req = this.transport.request(
                {
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: `${url.pathname}${url.search}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                    agent: this.agent,
                    timeout: this.requestTimeout,
                },
                res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode !== 201) {
                            return done(
                                new SmartHomeError(
                                    `Could not create the application token (HTTP ${res.statusCode})${
                                        data ? `: ${data.slice(0, 200)}` : ''
                                    }`,
                                    res.statusCode,
                                ),
                            );
                        }
                        const location = String(res.headers.location || '');
                        const key = location.split('/').filter(Boolean).pop();
                        if (!key) {
                            return done(
                                new SmartHomeError(
                                    'The dSS answered without a usable Location header, no key received',
                                ),
                            );
                        }
                        done(null, key);
                    });
                    res.on('error', err => {
                        if (this.stopped) {
                            return done(stoppedError('Smart Home API key creation was cancelled'));
                        }
                        done(
                            new SmartHomeError(
                                `Response error while creating the application token: ${errorMessage(err)}`,
                                undefined,
                                {
                                    cause: /** @type {Error} */ (err),
                                },
                            ),
                        );
                    });
                },
            );
            this.activeRequests.add(req);
            req.on('timeout', () => {
                const err = new SmartHomeError('Timeout while creating the application token');
                err.code = 'ETIMEDOUT';
                req.destroy(err);
            });
            req.on('error', err =>
                done(this.stopped ? stoppedError('Smart Home API key creation was cancelled') : err),
            );
            req.end(payload);
        });
    }
}

// The extras hang off the class so `require('./dssSmartHome').SmartHomeError` keeps
// working next to `require('./dssSmartHome')` itself. Written as statics instead of
// further export assignments: the multi-assignment form is what an export-assignment
// module may not do.
DSSSmartHome.SmartHomeError = SmartHomeError;
DSSSmartHome.APARTMENT_INCLUDES = APARTMENT_INCLUDES;
DSSSmartHome.STATUS_INCLUDES = STATUS_INCLUDES;
DSSSmartHome.RECORD_SEPARATOR = RECORD_SEPARATOR;

module.exports = DSSSmartHome;
