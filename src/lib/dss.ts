import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import { normalizeBoolean, errorMessage, asError, markShutdown } from './configUtils';
import type { AdapterError, DssResponse } from './configUtils';

export type SubscribeCallback = (errs: Error[] | null) => void;

/**
 * One long-poll of the DSS. Every event name of a subscription id shares it, which is
 * why the error count and the retry timer live here and not per event name.
 */
export interface EventChannel {
    /** the id every event name of this channel shares */
    subscriptionId: number;
    /** long-poll timeout in ms */
    timeout: number;
    /** consecutive failures of event/get on this channel */
    errorCount: number;
    /** pending re-poll after a failure */
    retryTimer: NodeJS.Timeout | null;
    /** true while an event/get is in flight */
    polling: boolean;
    /** when the running long-poll was started */
    lastPollTime: number;
}

/**
 * An event as this adapter passes it on: name is a string, source and properties are
 * always objects, see normalizeEvent().
 */
export type DssEvent = { name: string; source: Record<string, any>; properties: Record<string, any> } & Record<
    string,
    any
>;

/** The logger the client writes to */
export interface DssLogger {
    silly?: (message: string) => void;
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}

export interface DSSOptions {
    host?: string;
    appToken?: string;
    subScriptionId?: number;
    subScriptionTimeout?: number;
    requestTimeout?: number;
    /** Optional activity hook, see DSS.onActivity */
    onActivity?: ((kind: string, detail: string) => void) | null;
    /** Raw configuration value, normalized with normalizeBoolean() */
    validateCertificate?: unknown;
    apiMaxSockets?: number;
    eventMaxSockets?: number;
    logger?: DssLogger;
}

export interface RequestOptions {
    /** timeout override in ms */
    timeout?: number;
    /** use the separate event agent for long-polls */
    eventPoll?: boolean;
    /** overrides the endpoint based default */
    retryOnConnectionError?: boolean;
}

/** The part of node:http and node:https this client uses */
interface Transport {
    Agent: new (options: https.AgentOptions) => http.Agent;
    get(url: string, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void): http.ClientRequest;
}

const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'];

const DEFAULT_REQUEST_TIMEOUT = 30 * 1000;
const SESSION_MAX_AGE = 45 * 1000; // DSS invalidates sessions after 60s idle, renew a bit earlier
const DEFAULT_API_MAX_SOCKETS = 8;
// The adapter runs ONE long-poll (all events share a subscription id). The reserve keeps
// room for a re-subscribe running next to the poll and for additional channels.
const DEFAULT_EVENT_MAX_SOCKETS = 16;
const MAX_EVENT_ERRORS = 5;
const EVENT_RETRY_BASE_DELAY = 2000;
const EVENT_RETRY_MAX_DELAY = 60000;

/**
 * Error of the DSS client.
 *
 * Besides the message it carries structured markers that the consumers evaluate instead
 * of parsing the message text - see the AdapterError typedef in configUtils.
 */
export class DSSError extends Error {
    /** HTTP status code of the answer */
    status: number | undefined;
    /** backward compatible field name for status */
    status_code: number | undefined;
    /** node style error code, e.g. ETIMEDOUT */
    code: string | undefined;
    /** true for a request timeout of this client */
    timeout: boolean | undefined;
    /** true when the request was cancelled by stop() */
    shutdown: boolean | undefined;

    /**
     * @param message error message
     * @param [status] HTTP status code, if the DSS answered at all
     * @param [options] standard error options, e.g. { cause }
     */
    constructor(message: string, status?: number, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DSSError';
        this.status = status;
        this.status_code = status;
        this.code = undefined;
        this.timeout = undefined;
        this.shutdown = undefined;
    }
}

export class DSS extends EventEmitter {
    /**
     * Allowlist of DSS endpoints that may be repeated once after a connection error.
     *
     * Deliberately a positive list: a newly used endpoint is not retried until its
     * semantics have been checked. Every entry is a pure read whose repetition cannot
     * change anything on the DSS or trigger an automation.
     */
    static RETRYABLE_REQUESTS: Set<string> = new Set([
        'apartment/getCircuits',
        'apartment/getName',
        // Pure read of the reachable groups of a zone, used once during startup.
        // Repeating it changes nothing on the DSS (same semantics as zone/getReachableScenes).
        'apartment/getReachableGroups',
        'apartment/getSensorValues',
        'apartment/getStructure',
        'apartment/getTemperatureControlStatus',
        // Pure read of the configured set points of one zone
        'zone/getTemperatureControlValues',
        'circuit/getConsumption',
        'circuit/getEnergyMeterValue',
        'device/getConfig',
        'device/getConfigWord',
        'device/getOutputChannelValue',
        // The named channel read of vDC devices. Same pure read as the line above,
        // and for a Sonos player it is the ONLY path to audioVolume and powerState.
        'device/getOutputChannelValue2',
        'device/getOutputValue',
        'device/getSwitchThreshold',
        // A subscription is a registration, not an action: subscribing the same id and name
        // twice has no effect, so a lost answer during startup may be retried.
        'event/subscribe',
        'property/query',
        // The same pure read as property/query, only with the answer keyed by node name.
        // Used once at startup for the sensor states under /usr/addon-states.
        'property/query2',
        'system/version',
        'zone/getLastCalledScene',
        'zone/getReachableScenes',
    ]);

    // DSSError hangs off the class so `DSS.DSSError` keeps working next to the named
    // export of this module.
    static DSSError = DSSError;

    options: DSSOptions;
    host: string | undefined;
    appToken: string | undefined;
    subScriptionId: number;
    subScriptionTimeout: number;
    requestTimeout: number;
    /**
     * Optionaler Zaehl-Haken fuer die Aktivitaetsanzeige:
     * ('request'|'eventPoll'|'event', pfadOderName). Darf nie werfen muessen -
     * wird deshalb nur aufgerufen, nie awaited.
     */
    onActivity: ((kind: string, detail: string) => void) | null;
    baseUrl: string;
    isSecure: boolean;
    transport: Transport;
    apiAgent: http.Agent;
    eventAgent: http.Agent;
    sessionToken: string | null;
    sessionLastUsed: number;
    sessionLoginPromise: Promise<string> | null;
    /** eventName -> { subscriptionId, timeout }: which names are registered */
    subscriptions: Record<string, { subscriptionId: number; timeout: number }>;
    /** subscriptionId -> channel: exactly one long-poll per subscription id */
    eventChannels: Record<string, EventChannel>;
    activeRequests: Set<http.ClientRequest>;
    stopped: boolean;

    constructor(options?: DSSOptions) {
        super();

        this.options = options || {
            logger: console,
        };
        this.host = this.options.host;
        this.appToken = this.options.appToken;
        this.subScriptionId = this.options.subScriptionId || 42;
        this.subScriptionTimeout = this.options.subScriptionTimeout || 40 * 1000;
        this.requestTimeout = this.options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
        this.onActivity = typeof this.options.onActivity === 'function' ? this.options.onActivity : null;

        this.baseUrl = DSS.buildBaseUrl(this.host);
        // The DSS uses https, but the configured scheme is respected (also keeps tests transport agnostic)
        this.isSecure = this.baseUrl.startsWith('https:');
        this.transport = this.isSecure ? https : http;

        const agentOptions: https.AgentOptions = {
            // No keep-alive on purpose: the DSS closes idle connections, and a pooled socket
            // that was closed in the meantime results in "socket hang up" on the next request.
            // The request rate is limited by the queue anyway, so pooling would gain very little.
            keepAlive: false,
            // The DSS uses a self-signed certificate, so validation must be opt-in.
            // Normalized here as well because the token dialog builds a client directly
            // from the raw configuration.
            rejectUnauthorized: normalizeBoolean(this.options.validateCertificate, false),
        };
        // Event long-polls occupy their socket for the whole polling timeout. They get their
        // own agent so that normal API calls (scene calls, login, ...) are never queued behind them.
        this.apiAgent = new this.transport.Agent({
            ...agentOptions,
            maxSockets: this.options.apiMaxSockets || DEFAULT_API_MAX_SOCKETS,
        });
        this.eventAgent = new this.transport.Agent({
            ...agentOptions,
            maxSockets: this.options.eventMaxSockets || DEFAULT_EVENT_MAX_SOCKETS,
        });

        this.sessionToken = null;
        this.sessionLastUsed = 0;
        this.sessionLoginPromise = null;

        // eventName -> { subscriptionId, timeout }: which names are registered
        this.subscriptions = {};
        // subscriptionId -> channel: exactly one long-poll per subscription id
        this.eventChannels = {};
        this.activeRequests = new Set();
        this.stopped = false;
    }

    /**
     * Normalizes a configured host into a base url.
     * Accepts "1.2.3.4", "1.2.3.4:8080", "https://host:8080", "[::1]:8080" and DNS names.
     *
     * @param host configured host value
     * @returns normalized base url without trailing slash
     */
    static buildBaseUrl(host: string | undefined): string {
        if (typeof host !== 'string' || !host.trim()) {
            throw new DSSError('No DSS host configured');
        }
        let raw = host.trim();
        const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            if (scheme !== 'https' && scheme !== 'http') {
                throw new DSSError(`Invalid DSS host "${host}": only https and http are supported`);
            }
        } else {
            raw = `https://${raw}`;
        }
        // Split into scheme, authority and everything behind it. Only the authority decides
        // about brackets and the port - a trailing slash must not influence that.
        const schemeEnd = raw.indexOf('://') + 3;
        const scheme = raw.slice(0, schemeEnd);
        const rest = raw.slice(schemeEnd);
        const authorityEnd = rest.search(/[/?#]/);
        let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
        const trailer = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
        // Bare IPv6 addresses need brackets to be parseable ("::1" -> "[::1]")
        if (!authority.startsWith('[') && (authority.match(/:/g) || []).length > 1) {
            authority = `[${authority}]`;
        }
        raw = scheme + authority + trailer;

        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            throw new DSSError(`Invalid DSS host "${host}"`);
        }
        if (url.username || url.password) {
            throw new DSSError('The DSS host must not contain credentials');
        }
        if (url.search || url.hash || (url.pathname && url.pathname !== '/')) {
            throw new DSSError(`Invalid DSS host "${host}": only host and port are allowed`);
        }
        if (!url.hostname) {
            throw new DSSError(`Invalid DSS host "${host}"`);
        }
        // The URL API drops a port that is the default of the scheme (443/80), so the
        // raw authority decides whether the DSS default port 8080 has to be added.
        const hasExplicitPort = authority.includes(']') ? /]:\d+$/.test(authority) : /:\d+$/.test(authority);
        let port = url.port;
        if (!port) {
            port = hasExplicitPort ? (url.protocol === 'https:' ? '443' : '80') : '8080';
        }
        return `${url.protocol}//${url.hostname}:${port}`;
    }

    stop(): void {
        this.stopped = true;
        Object.keys(this.eventChannels).forEach(key => this.clearEventRetry(this.eventChannels[key].subscriptionId));
        // Abort in-flight requests (especially the long running event polls)
        this.activeRequests.forEach(req => req.destroy());
        this.activeRequests.clear();
        this.apiAgent.destroy();
        this.eventAgent.destroy();
    }

    /**
     * Low level HTTPS GET against the DSS JSON API
     *
     * @param path e.g. /json/system/login
     * @param [query] query parameters
     * @param [timeout] timeout in ms for this request
     * @param [isEventPoll] use the separate event agent for long-polls
     * @returns parsed JSON body
     */
    httpRequest(
        path: string,
        query?: Record<string, any>,
        timeout?: number,
        isEventPoll?: boolean,
    ): Promise<DssResponse> {
        return new Promise((resolve, reject) => {
            if (this.stopped) {
                // Hard barrier: after stop() the agents are destroyed and no new socket
                // may be opened, no matter which late callback ends up here.
                const stoppedErr = new DSSError(`Client is stopped, not requesting ${path}`);
                stoppedErr.shutdown = true;
                return void reject(stoppedErr);
            }
            const search = query ? `?${new URLSearchParams(query).toString()}` : '';
            const url = this.baseUrl + path + search;
            const effectiveTimeout = timeout || this.requestTimeout;
            let req: http.ClientRequest | undefined = undefined;
            const done = (err: Error | null, body?: DssResponse): void => {
                if (req) {
                    this.activeRequests.delete(req);
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(body as DssResponse);
                }
            };
            // Fuer die Aktivitaetsanzeige des Status-Tabs: was geht ueber diesen Weg
            this.onActivity && this.onActivity(isEventPoll ? 'eventPoll' : 'request', path);
            req = this.transport.get(
                url,
                {
                    agent: isEventPoll ? this.eventAgent : this.apiAgent,
                    timeout: effectiveTimeout,
                },
                res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            return done(new DSSError(`HTTP ${res.statusCode} for ${path}`, res.statusCode));
                        }
                        try {
                            done(null, JSON.parse(data));
                        } catch (err) {
                            done(
                                new DSSError(`Invalid JSON response for ${path}: ${errorMessage(err)}`, undefined, {
                                    cause: err,
                                }),
                            );
                        }
                    });
                    res.on('error', err =>
                        done(new DSSError(`Response error for ${path}: ${err.message}`, undefined, { cause: err })),
                    );
                },
            );
            const request = req;
            this.activeRequests.add(request);
            request.on('timeout', () => {
                // destroy() triggers the 'error' handler with our timeout error.
                // The error carries the structured markers of a real socket timeout so that
                // isRetryableConnectionError() does not have to parse the message text.
                const timeoutError = new DSSError(`Timeout after ${effectiveTimeout}ms for ${path}`);
                timeoutError.code = 'ETIMEDOUT';
                timeoutError.timeout = true;
                request.destroy(timeoutError);
            });
            request.on('error', err =>
                done(
                    err instanceof DSSError
                        ? err
                        : new DSSError(`Request error for ${path}: ${err.message}`, undefined, { cause: err }),
                ),
            );
        });
    }

    /**
     * Returns a valid session token, renews it via loginApplication when needed.
     * Parallel callers share one login request.
     */
    async getSessionToken(): Promise<string> {
        if (this.sessionToken && Date.now() - this.sessionLastUsed < SESSION_MAX_AGE) {
            return this.sessionToken;
        }
        if (!this.sessionLoginPromise) {
            this.sessionLoginPromise = this.httpRequest('/json/system/loginApplication', {
                loginToken: this.appToken,
            }).then(
                body => {
                    this.sessionLoginPromise = null;
                    if (!body || body.ok !== true || !body.result || !body.result.token) {
                        throw new DSSError(`Login failed: ${(body && body.message) || 'unknown error'}`);
                    }
                    this.sessionToken = body.result.token;
                    this.sessionLastUsed = Date.now();
                    return this.sessionToken as string;
                },
                err => {
                    this.sessionLoginPromise = null;
                    throw err;
                },
            );
        }
        return this.sessionLoginPromise;
    }

    invalidateSession(): void {
        this.sessionToken = null;
        this.sessionLastUsed = 0;
    }

    /**
     * True for connection level errors where the request was never answered.
     * Typical case: the DSS closed a pooled keep-alive socket while it was idle
     * and Node picked exactly that socket for the next request ("socket hang up").
     *
     * @param err thrown value
     */
    static isRetryableConnectionError(err: unknown): boolean {
        const error = asError(err);
        if (!error) {
            return false;
        }
        const cause = asError(error.cause);
        // Structured marker of our own request timeout, see httpRequest()
        if (error.timeout === true || (cause && cause.timeout === true)) {
            return true;
        }
        const code = error.code || (cause && cause.code);
        if (code && RETRYABLE_ERROR_CODES.includes(code)) {
            return true;
        }
        return /socket hang up|ECONNRESET|EPIPE/i.test(error.message || '');
    }

    /**
     * Decides whether a request may be sent a second time after a connection error.
     *
     * A connection error does not tell whether the DSS already processed the request -
     * only the answer is known to be missing. Repeating is therefore only allowed for
     * pure reads, where a second execution has no effect at all.
     *
     * Explicitly NOT retryable:
     * - callScene / undoScene: would run the scene twice and can trigger dS automations
     * - event/raise: would raise the event twice
     * - state/set, pushSensorValue, setValue, setConfig: change data other systems react on
     * - event/get: a read, but it consumes the pending events - a repeat would lose them
     *
     * @returns true if a single automatic retry is safe
     */
    static isRetryableRequest(dssClass: string, dssFunction: string): boolean {
        return DSS.RETRYABLE_REQUESTS.has(`${dssClass}/${dssFunction}`);
    }

    /**
     * Do Request to DSS. Resolves only with an "ok" response, rejects otherwise.
     *
     * @param dssClass class of the DSS JSON API, e.g. apartment
     * @param dssFunction function of that class, e.g. getStructure
     * @param [params] parameters of the request
     * @param [options] options object, or a timeout in ms for the legacy signature
     * @param [legacyIsEventPoll] only used together with the legacy signature
     * @returns Promise resolving with the JSON body (body.ok === true)
     */
    async requestAsync(
        dssClass: string,
        dssFunction: string,
        params?: Record<string, any>,
        options?: RequestOptions | number,
        legacyIsEventPoll?: boolean,
    ): Promise<DssResponse> {
        if (this.stopped) {
            // A callback that was already running when stop() was called must not be able to
            // open a new connection afterwards. Rejecting with the shutdown marker keeps the
            // consumers on their expected-error path instead of producing warnings.
            const err = new DSSError(`Client is stopped, not sending ${dssClass}/${dssFunction}`);
            err.shutdown = true;
            throw err;
        }
        if (!this.appToken) {
            throw new DSSError('You need to provide an appToken or do a login');
        }
        if (typeof options !== 'object' || options === null) {
            // Legacy signature (dssClass, dssFunction, params, timeout, isEventPoll)
            options = { timeout: options, eventPoll: legacyIsEventPoll };
        }
        const timeout = options.timeout;
        const isEventPoll = !!options.eventPoll;
        const mayRetry =
            options.retryOnConnectionError === undefined
                ? DSS.isRetryableRequest(dssClass, dssFunction)
                : !!options.retryOnConnectionError;

        const path = `/json/${dssClass}/${dssFunction}`;
        let retriedAuth = false;
        let retriedConnection = false;
        for (;;) {
            const token = await this.getSessionToken();
            let body: DssResponse;
            try {
                body = await this.httpRequest(path, { ...params, token }, timeout, isEventPoll);
            } catch (err) {
                // Only repeated when a second execution is known to be without effect
                if (mayRetry && !retriedConnection && !this.stopped && DSS.isRetryableConnectionError(err)) {
                    retriedConnection = true;
                    this.options.logger &&
                        this.options.logger.debug(`Connection lost for ${path}, retrying once: ${errorMessage(err)}`);
                    continue;
                }
                if (this.stopped) {
                    // stop() aborts the running requests on purpose - consumers use this flag
                    // to not report the expected shutdown errors as warnings.
                    markShutdown(err);
                }
                throw err;
            }
            this.sessionLastUsed = Date.now();
            if (body && body.ok === true) {
                return body;
            }
            const message = (body && body.message) || 'unknown error';
            // Session might have been invalidated server side (e.g. DSS restart) - retry once with a fresh login
            if (!retriedAuth && /not logged in|authentication|login/i.test(message)) {
                retriedAuth = true;
                this.invalidateSession();
                continue;
            }
            throw new DSSError(`Error response for ${path}: ${message}`);
        }
    }

    async createAppTokenAsync(username: string, password: string, readableName?: string): Promise<string> {
        readableName = readableName || 'ioBroker';
        if (typeof username !== 'string' || !username) {
            throw new DSSError('No username provided');
        }
        if (typeof password !== 'string' || !password) {
            throw new DSSError('No password provided');
        }
        const tokenRes = await this.httpRequest('/json/system/requestApplicationToken', {
            applicationName: readableName,
        });
        if (!tokenRes || tokenRes.ok !== true || !tokenRes.result || !tokenRes.result.applicationToken) {
            throw new DSSError(
                `Could not request application token: ${(tokenRes && tokenRes.message) || 'unknown error'}`,
            );
        }
        const appToken: string = tokenRes.result.applicationToken;

        const loginRes = await this.httpRequest('/json/system/login', { user: username, password });
        if (!loginRes || loginRes.ok !== true || !loginRes.result || !loginRes.result.token) {
            throw new DSSError(
                `Login failed - please check username and password: ${
                    (loginRes && loginRes.message) || 'unknown error'
                }`,
            );
        }

        const enableRes = await this.httpRequest('/json/system/enableToken', {
            applicationToken: appToken,
            token: loginRes.result.token,
        });
        if (!enableRes || enableRes.ok !== true) {
            throw new DSSError(
                `Could not enable application token: ${(enableRes && enableRes.message) || 'unknown error'}`,
            );
        }

        this.appToken = appToken;
        return appToken;
    }

    /**
     * Normalizes a single event from the DSS so that consumers can rely on
     * source/properties being objects. Returns null for unusable entries.
     *
     * @param event raw event as delivered by the DSS - deliberately any, this is
     *   unvalidated input and validating it is exactly what this function is for
     * @returns normalized event
     */
    static normalizeEvent(event: any): DssEvent | null {
        if (!event || typeof event !== 'object' || typeof event.name !== 'string' || !event.name) {
            return null;
        }
        const source: Record<string, any> = event.source && typeof event.source === 'object' ? event.source : {};
        const properties: Record<string, any> =
            event.properties && typeof event.properties === 'object' ? event.properties : {};
        // TempFix: dSID ist eigentlich eine dSUID
        if (source.dsid !== undefined && source.dSUID === undefined) {
            source.dSUID = source.dsid;
        }
        // TempFix: Schreibfehler
        if (properties.sceneId !== undefined && properties.sceneID === undefined) {
            properties.sceneID = properties.sceneId;
        }
        // The guard above proved event.name is a non-empty string, but the spread widens
        // it back to any - name it explicitly so the returned shape really is a DssEvent
        return { ...event, name: event.name, source, properties };
    }

    /**
     * Returns the channel of a subscription id, creating it on demand.
     *
     * All event names of a channel share ONE subscription id and therefore ONE long-poll:
     * the DSS delivers every event of a subscription id through the same event/get.
     * That keeps exactly one open connection to the DSS instead of one per event name.
     *
     * @param subscriptionId subscription id of the channel
     * @param [timeout] long-poll timeout in ms
     * @returns the channel record
     */
    ensureChannel(subscriptionId: number, timeout?: number): EventChannel {
        const key = String(subscriptionId);
        if (!this.eventChannels[key]) {
            this.eventChannels[key] = {
                subscriptionId,
                timeout: timeout || this.subScriptionTimeout,
                // errorCount belongs to the channel: a failing event/get concerns every
                // event name on it, so counting it once is what the limit is about.
                errorCount: 0,
                retryTimer: null,
                polling: false,
                lastPollTime: 0,
            };
        } else if (timeout) {
            this.eventChannels[key].timeout = timeout;
        }
        return this.eventChannels[key];
    }

    /**
     * @returns the channel or null if it does not exist
     */
    getChannel(subscriptionId: number): EventChannel | null {
        return this.eventChannels[String(subscriptionId)] || null;
    }

    /**
     * All event names that are currently registered on one subscription id.
     *
     * @returns event names
     */
    channelEventNames(subscriptionId: number): string[] {
        return Object.keys(this.subscriptions).filter(
            eventName => this.subscriptions[eventName].subscriptionId === subscriptionId,
        );
    }

    /**
     * Readable name of a channel for log messages and the eventError event.
     */
    channelLabel(subscriptionId: number): string {
        const eventNames = this.channelEventNames(subscriptionId);
        return eventNames.length ? eventNames.join(', ') : `subscription ${subscriptionId}`;
    }

    clearEventRetry(subscriptionId: number): void {
        const channel = this.getChannel(subscriptionId);
        if (channel && channel.retryTimer) {
            clearTimeout(channel.retryTimer);
            channel.retryTimer = null;
        }
    }

    /**
     * Schedules exactly one retry timer per channel using a bounded exponential backoff.
     */
    scheduleEventRetry(subscriptionId: number, action: () => void): void {
        const channel = this.getChannel(subscriptionId);
        if (!channel || this.stopped) {
            return;
        }
        this.clearEventRetry(subscriptionId);
        const delay = Math.min(
            EVENT_RETRY_BASE_DELAY * 2 ** Math.max(0, channel.errorCount - 1),
            EVENT_RETRY_MAX_DELAY,
        );
        channel.retryTimer = setTimeout(() => {
            const current = this.getChannel(subscriptionId);
            if (current) {
                current.retryTimer = null;
            }
            if (!current || this.stopped) {
                return;
            }
            action();
        }, delay);
    }

    /**
     * Handles a polling or re-subscribe failure of one channel: counts the error,
     * emits eventError once the limit is reached, otherwise schedules a retry.
     *
     * @param subscriptionId subscription id of the channel
     * @param err error of the failed request
     * @param context short description used for logging
     */
    handleEventFailure(subscriptionId: number, err: AdapterError, context: string): void {
        const channel = this.getChannel(subscriptionId);
        if (!channel || this.stopped) {
            return;
        }
        channel.errorCount = (channel.errorCount || 0) + 1;
        const message = errorMessage(err);
        const label = this.channelLabel(subscriptionId);
        this.options.logger &&
            this.options.logger.warn(`Error on ${context} for events ${label} (${channel.errorCount}): ${message}`);

        if (channel.errorCount > MAX_EVENT_ERRORS) {
            this.clearEventRetry(subscriptionId);
            return void this.emit(
                'eventError',
                label,
                channel.errorCount,
                `Too many errors on ${context} for ${label}: ${message}`,
            );
        }
        // A lost subscription (e.g. after a DSS restart) needs a re-subscribe before polling makes sense again
        const needsResubscribe = channel.errorCount >= 2 || err.status === 500;
        this.scheduleEventRetry(subscriptionId, () => {
            if (needsResubscribe) {
                // Every name of the channel has to be registered again: the DSS loses the
                // whole subscription id, not just the name whose poll happened to fail.
                this.resubscribeChannel(subscriptionId, subErr => {
                    if (subErr) {
                        this.handleEventFailure(subscriptionId, subErr, 're-subscribing');
                    } else {
                        this.options.logger && this.options.logger.info(`Successfully resubscribed to ${label}`);
                        this.pollChannel(subscriptionId);
                    }
                });
            } else {
                this.pollChannel(subscriptionId);
            }
        });
    }

    /**
     * Subscribes every event name of a channel again, e.g. after the DSS dropped the
     * subscription. Does not start the poll - the caller decides.
     *
     * @param subscriptionId subscription id of the channel
     * @param [callback] called with the first error, if any
     */
    resubscribeChannel(subscriptionId: number, callback?: (err: Error | null) => void): void {
        const eventNames = this.channelEventNames(subscriptionId);
        if (!eventNames.length) {
            return void (callback && setImmediate(() => callback(null)));
        }
        let open = eventNames.length;
        const errs: Error[] = [];
        const finish = (err: Error | null): void => {
            if (err) {
                errs.push(err);
            }
            if (!--open) {
                callback && callback(errs.length ? errs[0] : null);
            }
        };
        eventNames.forEach(eventName =>
            this.requestAsync('event', 'subscribe', { subscriptionID: subscriptionId, name: eventName }).then(
                () => finish(null),
                err => finish(err),
            ),
        );
    }

    /**
     * The long-poll of one channel. Delivers the events of every subscribed name.
     */
    pollChannel(subscriptionId: number): void {
        const channel = this.getChannel(subscriptionId);
        if (!channel || this.stopped || channel.polling) {
            return;
        }
        channel.polling = true;
        channel.lastPollTime = Date.now();
        // HTTP timeout needs to be longer than the long-polling timeout of the DSS
        this.requestAsync(
            'event',
            'get',
            { subscriptionID: channel.subscriptionId, timeout: channel.timeout },
            // No retry: event/get consumes the pending events on the DSS, repeating it
            // after a lost answer would drop them. Failures go through the backoff below.
            { timeout: channel.timeout + 15000, eventPoll: true, retryOnConnectionError: false },
        ).then(
            events => {
                const current = this.getChannel(subscriptionId);
                if (current) {
                    current.polling = false;
                }
                if (!current || this.stopped) {
                    return;
                }
                current.errorCount = 0;
                const rawEvents = (events && events.result && events.result.events) || [];
                if (Array.isArray(rawEvents)) {
                    rawEvents.forEach((rawEvent: unknown) => {
                        // One broken event must not prevent the remaining events of this response
                        try {
                            const event = DSS.normalizeEvent(rawEvent);
                            if (!event) {
                                this.options.logger &&
                                    this.options.logger.debug(
                                        `Ignoring unusable event on subscription ${subscriptionId}: ${JSON.stringify(rawEvent)}`,
                                    );
                                return;
                            }
                            if (this.getChannel(subscriptionId)) {
                                this.onActivity && this.onActivity('event', event.name);
                                this.emit(event.name, event);
                            }
                        } catch (err) {
                            this.options.logger &&
                                this.options.logger.warn(
                                    `Error while handling event on subscription ${subscriptionId}: ${errorMessage(err)}`,
                                );
                        }
                    });
                }
                setImmediate(() => this.pollChannel(subscriptionId));
            },
            err => {
                const current = this.getChannel(subscriptionId);
                if (current) {
                    current.polling = false;
                }
                this.handleEventFailure(subscriptionId, err, 'polling');
            },
        );
    }

    /**
     * Registers one event name on the DSS without starting the poll.
     */
    registerEventSubscription(eventName: string, subscriptionId: number, timeout: number): Promise<void> {
        return this.requestAsync('event', 'subscribe', { subscriptionID: subscriptionId, name: eventName }).then(() => {
            if (this.stopped) {
                return;
            }
            this.subscriptions[eventName] = { subscriptionId, timeout };
            // The channel keeps its errorCount on purpose. A successful event/subscribe
            // says nothing about event/get: if subscribing works but polling keeps
            // failing (e.g. HTTP 500 on every event/get), resetting here would keep the
            // counter below the limit forever - the adapter would stay green while
            // re-subscribing every few seconds and never processing an event again.
            // Only a successful event/get clears the counter, see pollChannel().
            this.ensureChannel(subscriptionId, timeout);
        });
    }

    subscribeEvent(
        eventName: string,
        subscriptionId: number,
        timeout: number,
        callback?: (err: Error | null) => void,
    ): void {
        this.registerEventSubscription(eventName, subscriptionId, timeout).then(
            () => {
                if (!this.stopped) {
                    this.pollChannel(subscriptionId);
                }
                callback && callback(null);
            },
            err => {
                callback && callback(err);
            },
        );
    }

    /**
     * Subscribes all given event names on ONE subscription id and then starts the single
     * long-poll of that channel.
     *
     * Polling deliberately starts only after the last subscription: a poll that is already
     * running when a name is added would not have to deliver its events.
     *
     * @param eventNames one or more names of DSS events
     * @param [subscriptionId] subscription id for all names, default subScriptionId
     * @param [timeout] long-poll timeout in ms
     * @param [callback] called when done
     */
    subscribeEvents(
        eventNames: string[] | string,
        subscriptionId?: number | SubscribeCallback,
        timeout?: number | SubscribeCallback,
        callback?: SubscribeCallback,
    ): void {
        // Legacy signatures: the callback may take the place of the id or of the timeout
        let done = callback;
        if (typeof subscriptionId === 'function') {
            done = subscriptionId;
            subscriptionId = undefined;
            timeout = undefined;
        }
        if (typeof timeout === 'function') {
            done = timeout;
            timeout = undefined;
        }
        const finalCallback = done;
        const pollTimeout = typeof timeout === 'number' ? timeout : this.subScriptionTimeout;
        const channelId = typeof subscriptionId === 'number' ? subscriptionId : this.subScriptionId;
        const names = Array.isArray(eventNames) ? eventNames : [eventNames];
        if (!names.length) {
            return void (finalCallback && setImmediate(() => finalCallback(null)));
        }
        let toSubscribe = names.length;
        const errs: Error[] = [];
        const finish = (err: Error | null): void => {
            if (err) {
                errs.push(err);
            }
            if (!--toSubscribe) {
                // Not a single name got through: without a channel there is nothing to poll
                if (!this.stopped && this.getChannel(channelId)) {
                    this.pollChannel(channelId);
                }
                finalCallback && finalCallback(errs.length ? errs : null);
            }
        };
        names.forEach(eventName =>
            this.registerEventSubscription(eventName, channelId, pollTimeout).then(
                () => finish(null),
                err => finish(err),
            ),
        );
    }

    /**
     * Unsubscribes the channel an event name belongs to.
     *
     * The DSS does not remove a single name: event/unsubscribe drops the whole
     * subscription id. The local registration therefore follows the DSS and removes every
     * name of that channel instead of pretending the remaining ones were still delivered.
     *
     * Measured against a dSS20 1.19.13 instead of assumed, because everything the unload
     * does rests on it: two names were subscribed to one id, one of them unsubscribed, and
     * the id was gone. The dSS says so itself - the next event/get answered "Event
     * subscription token not found ... token:4711 m_subscriptions.size():0". So the single
     * request unsubscribeAllEvents() sends really does release all nine event names.
     */
    unsubscribeEvent(eventName: string, callback?: (err: Error | null) => void): void {
        const sub = this.subscriptions[eventName];
        if (!sub) {
            return void (callback && callback(null));
        }
        const subscriptionId = sub.subscriptionId;
        this.clearEventRetry(subscriptionId);
        this.channelEventNames(subscriptionId).forEach(name => delete this.subscriptions[name]);
        delete this.eventChannels[String(subscriptionId)];
        this.requestAsync('event', 'unsubscribe', { subscriptionID: subscriptionId, name: eventName }).then(
            () => {
                callback && callback(null);
            },
            err => {
                callback && callback(err);
            },
        );
    }

    /**
     * Unsubscribes every channel - one request per subscription id, not per event name.
     *
     * @param [callback] gets the time the last long-poll runs until
     */
    unsubscribeAllEvents(callback?: (lastPollEnd: number) => void): void {
        let lastPollEnd = 0;
        const channels = Object.keys(this.eventChannels).map(key => this.eventChannels[key]);
        let openChannels = channels.length;
        if (!openChannels) {
            this.subscriptions = {};
            this.eventChannels = {};
            return void (callback && callback(0));
        }

        const finish = (): void => {
            if (!--openChannels) {
                this.subscriptions = {};
                this.eventChannels = {};
                callback && callback(lastPollEnd);
            }
        };

        channels.forEach(channel => {
            const pollEnd = (channel.lastPollTime || 0) + channel.timeout;
            if (pollEnd > lastPollEnd) {
                lastPollEnd = pollEnd;
            }
            this.clearEventRetry(channel.subscriptionId);
            const [eventName] = this.channelEventNames(channel.subscriptionId);
            if (!eventName) {
                return void setImmediate(finish);
            }
            this.requestAsync('event', 'unsubscribe', {
                subscriptionID: channel.subscriptionId,
                name: eventName,
            }).then(finish, finish);
        });
    }
}
