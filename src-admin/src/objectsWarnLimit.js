// The objects warn limit of the opened instance, the way js-controller understands it.
//
// Nothing here is assumed - it was read in the js-controller sources:
// - The state system.adapter.<name>.<instance>.objectsWarnLimit exists from js-controller 7.1.0
//   on (PR #3070). 6.x and 7.0.x have neither the state nor the check.
// - The instance checks the limit exactly once, while it starts (adapter.ts,
//   #checkObjectsWarnLimit): `typeof val === 'number' ? val : DEFAULT_OBJECTS_WARN_LIMIT`, so
//   anything that is not a number counts as 5000. An unacknowledged value is written back with
//   ack=true - the value that was USED, which is 5000 for a string or null. It warns when the
//   instance has MORE objects than the limit. Nothing reacts to a change of the state before the
//   next start.
// - Before that check every start creates the object and, only if there is no state yet, the state
//   from common.def. From 7.1.2 on common.def is the defaultObjectsWarnLimit of the instance's
//   common, copied from io-package.json (PR #3303), before it was 5000. An existing value is never
//   replaced, which is how an old instance keeps 5000 although this adapter asks for more.
//
// This file holds no React and no socket of its own, so the tests load it as it is.

/** First js-controller with the state and the check (7.1.0). */
export const CONTROLLER_MIN_VERSION = '7.1.0';

/** First js-controller that takes common.def from the defaultObjectsWarnLimit of io-package.json. */
export const CONTROLLER_ADAPTER_DEFAULT_VERSION = '7.1.2';

/**
 * DEFAULT_OBJECTS_WARN_LIMIT of js-controller (packages/common-db/src/lib/common/constants.ts),
 * unchanged from 7.1.0 up to 7.2.x. It is shown only as what it is - the replacement the controller
 * uses for a value that is not a number - and only for those versions.
 */
export const CONTROLLER_FALLBACK_LIMIT = 5000;

/** The first version whose replacement value has not been checked. */
const CONTROLLER_FALLBACK_CHECKED_BELOW = '7.3.0';

/**
 * Nightly builds of js-controller carry the version of the NEXT patch release. 7.0.8 was never
 * released, and its nightlies had the check from alpha.6 on but not before - such a host cannot be
 * told apart, so nothing is claimed about it.
 */
const AMBIGUOUS_CONTROLLER_VERSIONS = ['7.0.8'];

/**
 * The questions the card answers before the field, in this order. Their texts are
 * warnLimit_faq_<name>_q and warnLimit_faq_<name>_a.
 */
export const WARN_LIMIT_QUESTIONS = ['must', 'speed', 'many', 'value', 'when', 'scope'];

/**
 * How long a single request may take. socket-client has no timeout of its own, and a request that
 * is on its way when the connection drops never settles - the card would say "loading" forever.
 */
export const READ_TIMEOUT = 20000;

/**
 * @param {string} adapterName
 * @param {number|string} instance
 */
export function warnLimitStateId(adapterName, instance) {
    return `system.adapter.${adapterName}.${instance}.objectsWarnLimit`;
}

/**
 * Compares two versions like 7.1.2 - a prerelease suffix is ignored.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number|null} negative, 0 or positive; null when one of them is not a version
 */
export function compareVersions(a, b) {
    const parse = v => {
        const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
        return match ? match.slice(1).map(Number) : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) {
        return null;
    }
    for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) {
            return left[i] - right[i];
        }
    }
    return 0;
}

/**
 * What can be said about a js-controller version. `known: false` means nothing is claimed.
 *
 * @param {string|null} version installedVersion of the host
 */
export function controllerSupport(version) {
    const match = /^v?(\d+\.\d+\.\d+)/.exec(String(version || '').trim());
    if (!match || AMBIGUOUS_CONTROLLER_VERSIONS.includes(match[1])) {
        return { known: false, tooOld: false, fallbackKnown: false, ignoresDefault: false };
    }
    const tooOld = /** @type {number} */ (compareVersions(match[1], CONTROLLER_MIN_VERSION)) < 0;
    return {
        known: true,
        tooOld,
        fallbackKnown:
            !tooOld && /** @type {number} */ (compareVersions(match[1], CONTROLLER_FALLBACK_CHECKED_BELOW)) < 0,
        ignoresDefault:
            !tooOld && /** @type {number} */ (compareVersions(match[1], CONTROLLER_ADAPTER_DEFAULT_VERSION)) < 0,
    };
}

/**
 * What the stored state means to js-controller.
 *
 * - `noState`: there is no state at all. The next start creates it from common.def.
 * - `empty`: the state exists but holds no value (null). The check then uses its replacement.
 * - `invalid`: not a number - a numeric string like "10000" included, typeof decides.
 * - `number`: used as it is; `unusual` marks values that are legal but hardly meant, because 0 and
 *   anything below warn on every start as soon as the instance has a single object.
 *
 * @param {any} state what getState answered, or the state of a subscription event
 */
export function classifyStoredValue(state) {
    if (!state) {
        return { kind: 'noState' };
    }
    const ack = typeof state.ack === 'boolean' ? state.ack : null;
    const val = state.val;
    if (val === null || val === undefined) {
        return { kind: 'empty', ack };
    }
    if (typeof val === 'number') {
        // A JSON transport turns NaN and Infinity into null already; this is the guard for
        // anything else that hands a number over.
        if (!Number.isFinite(val)) {
            return { kind: 'invalid', reason: 'nonFinite', raw: String(val), ack };
        }
        if (val <= 0) {
            return { kind: 'number', value: val, unusual: 'notPositive', ack };
        }
        if (!Number.isInteger(val)) {
            return { kind: 'number', value: val, unusual: 'fraction', ack };
        }
        return { kind: 'number', value: val, unusual: null, ack };
    }
    let raw;
    try {
        raw = JSON.stringify(val);
    } catch {
        raw = String(val);
    }
    return {
        kind: 'invalid',
        reason: typeof val === 'string' ? (val.trim() === '' ? 'emptyString' : 'string') : 'type',
        raw,
        ack,
    };
}

/**
 * Checks what was typed into the field. Only digits: "10.000" is ten thousand in German and ten
 * in English, so a separator is refused instead of guessed.
 *
 * @param {string} text
 * @returns {{ ok: true, value: number } | { ok: false, reason: 'empty'|'notWholeNumber'|'tooSmall'|'tooLarge' }}
 */
export function parseLimitInput(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') {
        return { ok: false, reason: 'empty' };
    }
    if (!/^\d+$/.test(trimmed)) {
        return { ok: false, reason: 'notWholeNumber' };
    }
    const value = Number(trimmed);
    if (value < 1) {
        return { ok: false, reason: 'tooSmall' };
    }
    if (!Number.isSafeInteger(value)) {
        return { ok: false, reason: 'tooLarge' };
    }
    return { ok: true, value };
}

/**
 * Formats a count for the language of the admin, "5.000" in German and "5,000" in English.
 *
 * @param {number} value
 * @param {string} [lang] ioBroker language code like de, en or zh-cn
 */
export function formatCount(value, lang) {
    try {
        return new Intl.NumberFormat(lang || 'en', { maximumFractionDigits: 3 }).format(value);
    } catch {
        return String(value);
    }
}

/**
 * Tells a missing permission from a lost connection. socket-client rejects with the plain string
 * "permissionError" when the ACL refuses a request, and with Error("notConnectedError") when the
 * socket is already down. A request without an answer ends as "timeout" - its outcome is unknown.
 *
 * @param {any} error
 * @param {boolean} connected
 * @returns {{ kind: 'permission'|'connection'|'other', message: string, timedOut: boolean }}
 */
export function classifyError(error, connected) {
    const message = error && error.message ? String(error.message) : String(error ?? '');
    const timedOut = /timeout/i.test(message);
    if (/permission/i.test(message)) {
        return { kind: 'permission', message, timedOut };
    }
    if (!connected || timedOut || /notConnected|not connected|disconnect/i.test(message)) {
        return { kind: 'connection', message, timedOut };
    }
    return { kind: 'other', message, timedOut };
}

/**
 * Copies a text. navigator.clipboard only exists in a secure context, and ioBroker Admin is mostly
 * opened over plain http - there the selection of a hidden text area is copied instead, and the
 * focus goes back to where it was, so a keyboard user does not start over at the top.
 *
 * @param {string} text
 * @param {any} [env] the window, replaceable for tests
 * @returns {Promise<boolean>} whether the browser reported success
 */
export async function copyText(text, env = globalThis) {
    try {
        if (env.isSecureContext && env.navigator?.clipboard?.writeText) {
            await env.navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // denied, fall through to the selection
    }
    const doc = env.document;
    if (!doc?.body) {
        return false;
    }
    const previous = doc.activeElement;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    try {
        area.select();
        area.setSelectionRange?.(0, text.length);
        return !!doc.execCommand('copy');
    } catch {
        return false;
    } finally {
        doc.body.removeChild(area);
        previous?.focus?.();
    }
}

/**
 * A snapshot before anything was read.
 *
 * @param {string} stateId
 */
export function initialSnapshot(stateId) {
    return {
        stateId,
        connected: true,
        loading: true,
        loaded: false,
        state: { status: 'unknown', value: null, error: null },
        object: { status: 'unknown', exists: false, error: null },
        adapter: { status: 'unknown', defaultLimit: null, version: null, error: null },
        host: { status: 'unknown', controllerVersion: null, error: null },
    };
}

/**
 * Keeps the objects warn limit of one instance up to date: reads the state, its object, the
 * instance object with the default and the version installed for it, and the js-controller version
 * of its host, and follows the state through a subscription.
 *
 * The default is taken from the INSTANCE object on purpose: system.adapter.<name> is one object for
 * all hosts and the last upload anywhere overwrites it, while js-controller builds common.def from
 * the common of the instance.
 *
 * Reading never writes. The single write is save(), which the dialog calls from its own save
 * button - with ack=false, because that is a request js-controller confirms at the next start.
 * Nothing here needs the instance to run: all of it is served by admin itself.
 */
export class WarnLimitMonitor {
    /**
     * @param {object} options
     * @param {any} options.socket the admin connection of GenericApp
     * @param {string} options.adapterName
     * @param {number|string} options.instance
     * @param {string} [options.host] common.host of the instance, used when the object has none
     * @param {(snapshot: any) => void} options.onUpdate receives every new snapshot
     * @param {number} [options.timeout] milliseconds a single request may take
     */
    constructor({ socket, adapterName, instance, host, onUpdate, timeout = READ_TIMEOUT }) {
        this.socket = socket;
        this.host = host || '';
        this.onUpdate = onUpdate;
        this.timeout = timeout;
        this.instanceId = `system.adapter.${adapterName}.${instance}`;
        this.stateId = warnLimitStateId(adapterName, instance);
        this.snapshot = initialSnapshot(this.stateId);
        this.round = 0;
        this.stateEvents = 0;
        this.subscribed = false;
        this.listening = false;
        this.disposed = false;
        /** @type {Set<ReturnType<typeof setTimeout>>} */
        this.timers = new Set();
    }

    /** @param {object} patch */
    update(patch) {
        if (this.disposed) {
            return;
        }
        this.snapshot = { ...this.snapshot, ...patch };
        this.onUpdate(this.snapshot);
    }

    /**
     * Rejects with "timeout" when the promise takes too long. The timer is dropped on close.
     *
     * @param {() => any} request
     */
    withTimeout(request) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), this.timeout);
            this.timers.add(timer);
        });
        return Promise.race([Promise.resolve().then(request), timeout]).finally(() => {
            clearTimeout(timer);
            this.timers.delete(timer);
        });
    }

    /** Subscribes to the state, follows the connection and reads everything once. */
    async start() {
        if (this.disposed) {
            return;
        }
        if (!this.listening && typeof this.socket.registerConnectionHandler === 'function') {
            this.listening = true;
            this.socket.registerConnectionHandler(this.onConnectionChange);
        }
        await this.subscribe();
        await this.refresh();
    }

    async subscribe() {
        if (this.subscribed || this.disposed) {
            return;
        }
        this.subscribed = true;
        try {
            // Delivers the current value right away while connected. After a reconnect socket-client
            // renews the subscription on its own, so this runs once.
            await this.socket.subscribeState(this.stateId, this.onStateEvent);
        } catch {
            // Only a callback that is not a function makes it throw. The read in refresh() reports
            // what is wrong with the state, so there is nothing to add here.
            this.subscribed = false;
        }
    }

    /**
     * A change pushed by the subscription is newer than any read that was still on its way.
     *
     * @param {string} id
     * @param {any} state
     */
    onStateEvent = (id, state) => {
        if (id !== this.stateId || this.disposed) {
            return;
        }
        this.stateEvents++;
        this.update({ state: { status: 'ok', value: state || null, error: null } });
    };

    /** @param {boolean} connected */
    onConnectionChange = connected => this.setConnected(!!connected);

    /**
     * @param {() => Promise<any>} request
     * @returns {Promise<{ ok: true, value: any } | { ok: false, error: { kind: string, message: string } }>}
     */
    async request(request) {
        try {
            return { ok: true, value: await this.withTimeout(request) };
        } catch (e) {
            return { ok: false, error: classifyError(e, this.snapshot.connected) };
        }
    }

    /** Reads everything again. An answer of an older round never overwrites a newer one. */
    async refresh() {
        if (this.disposed) {
            return;
        }
        const round = ++this.round;
        const eventsAtStart = this.stateEvents;
        const current = () => round === this.round && !this.disposed;
        this.update({ loading: true });

        const [state, object, instance] = await Promise.all([
            this.request(() => this.socket.getState(this.stateId)),
            this.request(() => this.socket.getObject(this.stateId)),
            this.request(() => this.socket.getObject(this.instanceId)),
        ]);
        if (!current()) {
            return;
        }

        // The controller version tells "too old" from "not created yet", and which replacement and
        // which default the controller applies. It belongs to the host the instance runs on.
        const hostName = (instance.ok && instance.value?.common?.host) || this.host;
        let host = { status: 'skipped', controllerVersion: null, error: null };
        if (hostName) {
            const hostObject = await this.request(() => this.socket.getObject(`system.host.${hostName}`));
            if (!current()) {
                return;
            }
            host = hostObject.ok
                ? { status: 'ok', controllerVersion: hostObject.value?.common?.installedVersion ?? null, error: null }
                : { status: 'error', controllerVersion: null, error: hostObject.error };
        }

        const patch = {
            object: object.ok
                ? { status: 'ok', exists: !!object.value, error: null }
                : { status: 'error', exists: false, error: object.error },
            adapter: instance.ok
                ? {
                      status: 'ok',
                      defaultLimit: instance.value?.common?.defaultObjectsWarnLimit ?? null,
                      version: instance.value?.common?.version ?? null,
                      error: null,
                  }
                : { status: 'error', defaultLimit: null, version: null, error: instance.error },
            host,
            loading: false,
            loaded: true,
        };
        // Decided only now, after the last request: a subscription event that arrived at any point
        // since the reads began is at least as new as this answer
        if (this.stateEvents === eventsAtStart) {
            patch.state = state.ok
                ? { status: 'ok', value: state.value || null, error: null }
                : { status: 'error', value: null, error: state.error };
        }
        this.update(patch);
    }

    /**
     * The connection of the dialog went away or came back.
     *
     * @param {boolean} connected
     */
    setConnected(connected) {
        if (this.disposed || connected === this.snapshot.connected) {
            return;
        }
        if (!connected) {
            // A request on its way when the connection dropped never answers - leave it behind
            this.round++;
            this.update({ connected, loading: false });
            return;
        }
        this.update({ connected });
        // The subscription is renewed by socket-client, but a change made while the connection was
        // gone does not arrive as an event
        void this.refresh();
    }

    /**
     * Writes a new limit and reads the state back. Only the dialog's save button calls this.
     *
     * @param {number} value a whole number, already checked by parseLimitInput
     */
    async save(value) {
        if (this.disposed) {
            throw new Error('the dialog is closed');
        }
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
            // js-controller only takes a number - a string would silently count as its replacement
            throw new Error(`not a valid limit: ${value}`);
        }
        if (!this.snapshot.object.exists) {
            // Without its object the state would be an orphan js-controller does not know
            throw new Error(`${this.stateId} does not exist`);
        }
        // A boolean ack makes socket-client send { val, ack } - the value stays a JS number
        await this.withTimeout(() => this.socket.setState(this.stateId, value, false));
        await this.refresh();
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.round++;
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
        if (this.listening && typeof this.socket.unregisterConnectionHandler === 'function') {
            this.listening = false;
            this.socket.unregisterConnectionHandler(this.onConnectionChange);
        }
        if (this.subscribed) {
            this.subscribed = false;
            try {
                this.socket.unsubscribeState(this.stateId, this.onStateEvent);
            } catch {
                // the connection may already be gone, there is nothing left to release then
            }
        }
    }
}

/**
 * Turns a snapshot into what the card shows. Pure, so every case can be tested without a browser.
 *
 * @param {any} snapshot
 * @returns {any} view model with message keys for the translations
 */
export function describeWarnLimit(snapshot) {
    const support = controllerSupport(snapshot.host.controllerVersion);
    const stateError = snapshot.state.status === 'error' ? snapshot.state.error : null;
    const objectError = snapshot.object.status === 'error' ? snapshot.object.error : null;
    const stored = snapshot.state.status === 'ok' ? classifyStoredValue(snapshot.state.value) : null;
    const adapterDefault =
        typeof snapshot.adapter.defaultLimit === 'number' &&
        Number.isFinite(snapshot.adapter.defaultLimit) &&
        snapshot.adapter.defaultLimit > 0
            ? snapshot.adapter.defaultLimit
            : null;
    const errorStatus = kind => (kind === 'permission' ? 'noAccess' : kind === 'connection' ? 'disconnected' : 'error');

    /** @type {{ key: string, severity: 'info'|'warning', params?: Record<string, any> }[]} */
    const messages = [];
    let status;
    let current = null;
    // What js-controller will use at the start when the state holds no usable number - its own
    // replacement value, never presented as the value of the instance
    let effective = null;
    let ack = null;

    if (!snapshot.connected && !snapshot.loaded && !stored) {
        // The connection went away before anything could be read
        status = 'disconnected';
        messages.push({ key: 'warnLimit_error_connection', severity: 'warning' });
    } else if (stateError) {
        status = errorStatus(stateError.kind);
        messages.push({
            key: `warnLimit_error_${stateError.kind}`,
            severity: 'warning',
            params: { error: stateError.message },
        });
    } else if (!stored || (stored.kind !== 'number' && snapshot.object.status === 'unknown')) {
        // The subscription may deliver "no state" before it is known whether the object exists
        status = 'loading';
    } else if (stored.kind === 'number') {
        current = stored.value;
        ack = stored.ack;
        status = stored.unusual ? 'unusual' : 'ok';
        if (stored.unusual === 'notPositive') {
            messages.push({ key: 'warnLimit_hint_notPositive', severity: 'warning' });
        } else if (stored.unusual === 'fraction') {
            messages.push({ key: 'warnLimit_hint_fraction', severity: 'info' });
        }
        if (ack === false) {
            messages.push({ key: 'warnLimit_hint_pending', severity: 'info' });
        }
        if (support.tooOld) {
            messages.push({
                key: 'warnLimit_hint_controllerTooOld',
                severity: 'warning',
                params: { version: snapshot.host.controllerVersion, min: CONTROLLER_MIN_VERSION },
            });
        }
        if (objectError) {
            messages.push({ key: objectErrorKey(objectError), severity: 'warning' });
        }
    } else if (objectError) {
        status = errorStatus(objectError.kind);
        messages.push({ key: objectErrorKey(objectError), severity: 'warning' });
    } else if (support.tooOld) {
        // A controller before 7.1.0 neither creates nor checks the state, whatever it holds
        status = 'unsupported';
        messages.push({
            key: 'warnLimit_status_unsupported',
            severity: 'info',
            params: { version: snapshot.host.controllerVersion, min: CONTROLLER_MIN_VERSION },
        });
    } else if (!snapshot.object.exists) {
        status = 'noObject';
        messages.push({
            key: support.known ? 'warnLimit_status_noObject' : 'warnLimit_status_noObjectUnknownController',
            severity: 'info',
            params: { min: CONTROLLER_MIN_VERSION },
        });
    } else if (stored.kind === 'noState') {
        status = 'noValue';
        messages.push({ key: 'warnLimit_status_noState', severity: 'info' });
    } else if (stored.kind === 'empty' || stored.reason === 'emptyString') {
        // An empty text is explained like an empty state - for js-controller both are no number
        status = 'noValue';
        ack = stored.ack;
        effective = support.fallbackKnown ? CONTROLLER_FALLBACK_LIMIT : null;
        messages.push({
            // An unacknowledged null is replaced by the number at the next start
            key: !support.fallbackKnown
                ? 'warnLimit_status_emptyUnknownFallback'
                : stored.ack === false
                  ? 'warnLimit_status_emptyPending'
                  : 'warnLimit_status_empty',
            severity: 'warning',
            params: { fallback: CONTROLLER_FALLBACK_LIMIT },
        });
    } else {
        status = 'invalid';
        ack = stored.ack;
        effective = support.fallbackKnown ? CONTROLLER_FALLBACK_LIMIT : null;
        // One message: what is stored, what the controller makes of it and how to fix it. An
        // unacknowledged entry is additionally overwritten at the next start.
        messages.push({
            key: !support.fallbackKnown
                ? 'warnLimit_status_invalidUnknownFallback'
                : stored.ack === false
                  ? 'warnLimit_status_invalidPending'
                  : 'warnLimit_status_invalid',
            severity: 'warning',
            // "10000" reads like a number to anyone - the text says HOW it is stored
            params: {
                raw: stored.raw,
                type: stored.reason === 'string' ? 'warnLimit_type_text' : 'warnLimit_type_other',
                fallback: CONTROLLER_FALLBACK_LIMIT,
            },
        });
    }

    // The loss of the connection does not make an earlier reading wrong, only possibly old
    const stale = !snapshot.connected && status !== 'disconnected' && status !== 'loading';
    if (stale) {
        messages.unshift({ key: 'warnLimit_hint_stale', severity: 'warning' });
    }

    const differs = current !== null && adapterDefault !== null && current !== adapterDefault;
    if (differs) {
        messages.push({ key: 'warnLimit_hint_differs', severity: 'info' });
    }
    if (adapterDefault !== null && support.ignoresDefault) {
        messages.push({
            key: 'warnLimit_hint_defaultIgnored',
            severity: 'info',
            params: { version: snapshot.host.controllerVersion, min: CONTROLLER_ADAPTER_DEFAULT_VERSION },
        });
    }

    let adapterDefaultStatus;
    if (snapshot.adapter.status === 'unknown') {
        adapterDefaultStatus = 'loading';
    } else if (snapshot.adapter.status === 'error') {
        adapterDefaultStatus = 'error';
    } else {
        adapterDefaultStatus = adapterDefault === null ? 'missing' : 'ok';
    }

    return {
        status,
        stateId: snapshot.stateId,
        current,
        effective,
        ack,
        adapterDefault,
        adapterDefaultStatus,
        adapterVersion: snapshot.adapter.version,
        controllerVersion: support.known ? snapshot.host.controllerVersion : null,
        differs,
        stale,
        loading: !!snapshot.loading,
        // Writing needs a readable state, its object - a state without one would be an orphan -
        // and a connection
        editable:
            snapshot.connected &&
            snapshot.state.status === 'ok' &&
            snapshot.object.status === 'ok' &&
            snapshot.object.exists &&
            !support.tooOld,
        messages,
    };
}

/**
 * @param {{ kind: string }} error
 */
function objectErrorKey(error) {
    return error.kind === 'permission' ? 'warnLimit_error_objectPermission' : 'warnLimit_error_objectOther';
}

/**
 * The number that is stored right now, or null when the state holds no usable number.
 *
 * @param {any} snapshot
 */
export function storedLimit(snapshot) {
    if (!snapshot || snapshot.state.status !== 'ok') {
        return null;
    }
    const stored = classifyStoredValue(snapshot.state.value);
    return stored.kind === 'number' ? stored.value : null;
}

/**
 * Whether what was typed into the field is a change that still has to be saved.
 *
 * @param {string|null} draft null while the field only shows the stored value
 * @param {any} snapshot
 * @returns {{ dirty: boolean, valid: boolean, value: number|null }}
 */
export function evaluateDraft(draft, snapshot) {
    if (draft === null || draft === undefined) {
        return { dirty: false, valid: true, value: null };
    }
    const current = storedLimit(snapshot);
    const parsed = parseLimitInput(draft);
    if (parsed.ok) {
        return { dirty: parsed.value !== current, valid: true, value: parsed.value };
    }
    // Emptying a field that showed nothing is no change either
    if (parsed.reason === 'empty' && current === null) {
        return { dirty: false, valid: true, value: null };
    }
    return { dirty: true, valid: false, value: null };
}

/**
 * Whether the native settings differ from what was loaded or saved last.
 *
 * GenericApp compares state.native with savedNative. After a save that keeps the dialog open it
 * remembers the encrypted fields (app token, API key) ENCRYPTED, while the form keeps them in plain
 * text - so an untouched form counts as changed. Deciding on that would keep the save buttons on
 * and write the instance object for nothing, and every write of that object restarts the instance.
 *
 * @param {Record<string, any>} native what the form holds
 * @param {Record<string, any>} savedNative what GenericApp remembers
 * @param {string[]} encryptedFields
 * @param {(value: string) => string} decrypt
 */
export function isNativeChanged(native, savedNative, encryptedFields, decrypt) {
    const saved = { ...savedNative };
    for (const attr of encryptedFields || []) {
        if (
            typeof saved[attr] === 'string' &&
            saved[attr] !== native[attr] &&
            saved[attr] !== '' &&
            decrypt(saved[attr]) === native[attr]
        ) {
            saved[attr] = native[attr];
        }
    }
    return JSON.stringify(native) !== JSON.stringify(saved);
}

/**
 * The save button of the dialog, with the warn limit in it.
 *
 * - No pending limit: the settings are saved exactly as before - unless nothing changed at all,
 *   then nothing is written.
 * - A pending limit: the state is written FIRST. If that fails nothing else is saved, so the dialog
 *   stays unsaved and says why. A restart caused by changed settings then already reads the new
 *   limit.
 * - Only the limit changed: the instance object is not written at all, because js-controller
 *   restarts a running instance on every write of that object.
 *
 * @param {object} options
 * @param {string|null} options.draft
 * @param {any} options.snapshot
 * @param {{ save: (value: number) => Promise<void> }} options.monitor
 * @param {() => boolean} options.nativeChanged
 * @param {() => void} options.saveSettings GenericApp's own save
 * @param {() => void} options.finish ends a save that wrote no settings
 * @returns {Promise<{ outcome: 'settings'|'limit'|'both'|'nothing'|'failed'|'invalid', value?: number, error?: any }>}
 */
export async function saveDialog({ draft, snapshot, monitor, nativeChanged, saveSettings, finish }) {
    const check = evaluateDraft(draft, snapshot);
    if (!check.dirty) {
        if (!nativeChanged()) {
            finish();
            return { outcome: 'nothing' };
        }
        saveSettings();
        return { outcome: 'settings' };
    }
    if (!check.valid || check.value === null) {
        return { outcome: 'invalid' };
    }
    try {
        await monitor.save(check.value);
    } catch (error) {
        return { outcome: 'failed', value: check.value, error };
    }
    if (nativeChanged()) {
        saveSettings();
        return { outcome: 'both', value: check.value };
    }
    finish();
    return { outcome: 'limit', value: check.value };
}
