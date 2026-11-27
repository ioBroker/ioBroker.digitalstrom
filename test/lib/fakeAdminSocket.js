// A stand-in for the admin connection of the configuration dialog (@iobroker/socket-client 5.2
// as GenericApp creates it). It copies the behaviour the dialog depends on, as read in the
// socket-client sources, and records every call so a test can prove what was - and what was not -
// sent to ioBroker:
// - getState/getObject resolve null for something that does not exist, reject with the plain
//   string "permissionError" when the ACL refuses, and with Error("notConnectedError") when the
//   socket is down. A request that is on its way when the connection drops never settles.
// - subscribeState calls the callback with the current value before its promise resolves, but
//   only while connected. After a reconnect the subscriptions are renewed on the server without
//   calling any callback again.
// - Every write reaches all subscribers as a change event.

const READS = [
    'getState',
    'getObject',
    'subscribeState',
    'unsubscribeState',
    'registerConnectionHandler',
    'unregisterConnectionHandler',
];

class FakeAdminSocket {
    /**
     * @param {object} [options]
     * @param {Record<string, any>} [options.states] state values by id; a missing id does not exist
     * @param {Record<string, any>} [options.objects] objects by id
     * @param {string[]} [options.denied] ids the ACL refuses to read
     * @param {string[]} [options.deniedWrites] ids the ACL refuses to write
     */
    constructor({ states = {}, objects = {}, denied = [], deniedWrites = [] } = {}) {
        this.states = { ...states };
        this.objects = { ...objects };
        this.denied = new Set(denied);
        this.deniedWrites = new Set(deniedWrites);
        this.connected = true;
        /** @type {{ method: string, args: any[] }[]} */
        this.calls = [];
        /** @type {Map<string, ((id: string, state: any) => void)[]>} */
        this.subscriptions = new Map();
        /** @type {((connected: boolean) => void)[]} */
        this.connectionHandlers = [];
        /** @type {{ id: string, resolve: () => void, reject: (reason: any) => void }[]} */
        this.held = [];
        this.holdReads = false;
        this.writes = [];
        /** @type {string[]} calls a guarded() wrapper refused - recorded, because a caller may catch the throw */
        this.violations = [];
        this.systemLang = 'de';
    }

    record(method, args) {
        this.calls.push({ method, args });
    }

    /** The names of all methods that were called, in order. */
    methods() {
        return this.calls.map(call => call.method);
    }

    read(id, lookup) {
        if (!this.connected) {
            return Promise.reject(new Error('notConnectedError'));
        }
        if (this.denied.has(id)) {
            return Promise.reject('permissionError');
        }
        if (this.holdReads) {
            // The server answers with what it had when the request arrived, but the answer is late
            const value = lookup();
            return new Promise((resolve, reject) => this.held.push({ id, resolve: () => resolve(value), reject }));
        }
        return Promise.resolve(lookup());
    }

    /**
     * Lets the held reads answer - late, with the value they read back then.
     *
     * @param {(id: string) => boolean} [filter] which of them
     */
    releaseHeld(filter = () => true) {
        const release = this.held.filter(entry => filter(entry.id));
        this.held = this.held.filter(entry => !filter(entry.id));
        release.forEach(entry => entry.resolve());
    }

    getState(id) {
        this.record('getState', [id]);
        return this.read(id, () => (id in this.states ? clone(this.states[id]) : null));
    }

    getObject(id) {
        this.record('getObject', [id]);
        return this.read(id, () => (id in this.objects ? clone(this.objects[id]) : null));
    }

    async subscribeState(id, cb) {
        this.record('subscribeState', [id]);
        const list = this.subscriptions.get(id) || [];
        if (!list.includes(cb)) {
            list.push(cb);
        }
        this.subscriptions.set(id, list);
        if (!this.connected) {
            return;
        }
        if (this.denied.has(id)) {
            // socket-client only logs a failed initial read and resolves anyway
            return;
        }
        cb(id, id in this.states ? clone(this.states[id]) : null);
    }

    unsubscribeState(id, cb) {
        this.record('unsubscribeState', [id]);
        const list = (this.subscriptions.get(id) || []).filter(entry => entry !== cb);
        if (list.length) {
            this.subscriptions.set(id, list);
        } else {
            this.subscriptions.delete(id);
        }
    }

    setState(id, val, ack) {
        // socket-client wraps a plain value only when ack is a boolean
        const state = typeof ack === 'boolean' ? { val, ack } : val;
        this.record('setState', [id, state]);
        if (!this.connected) {
            return Promise.reject(new Error('notConnectedError'));
        }
        if (this.deniedWrites.has(id)) {
            return Promise.reject('permissionError');
        }
        const stored = { ts: Date.now(), lc: Date.now(), from: 'system.adapter.admin.0', q: 0, ...state };
        this.states[id] = stored;
        this.writes.push({ id, state: clone(state) });
        this.emit(id, stored);
        return Promise.resolve();
    }

    // What GenericApp itself uses around loading and saving the settings
    getSystemConfig() {
        this.record('getSystemConfig', []);
        return Promise.resolve(clone(this.objects['system.config'] || { common: {}, native: {} }));
    }

    async subscribeObject(id) {
        this.record('subscribeObject', [id]);
    }

    setObject(id, obj) {
        this.record('setObject', [id, clone(obj)]);
        this.objects[id] = clone(obj);
        return Promise.resolve();
    }

    // Writes nothing here may ever use - they only record, so a caught call still shows up
    sendTo(...args) {
        this.record('sendTo', args);
        return Promise.resolve();
    }

    extendObject(...args) {
        this.record('extendObject', args);
        return Promise.resolve();
    }

    delObject(...args) {
        this.record('delObject', args);
        return Promise.resolve();
    }

    delState(...args) {
        this.record('delState', args);
        return Promise.resolve();
    }

    registerConnectionHandler(handler) {
        this.record('registerConnectionHandler', []);
        this.connectionHandlers.push(handler);
    }

    unregisterConnectionHandler(handler) {
        this.record('unregisterConnectionHandler', []);
        this.connectionHandlers = this.connectionHandlers.filter(entry => entry !== handler);
    }

    isConnected() {
        return this.connected;
    }

    /**
     * A change made somewhere else in ioBroker, e.g. in the object browser.
     *
     * @param {string} id
     * @param {any} state null deletes the state
     */
    external(id, state) {
        if (state === null) {
            delete this.states[id];
        } else {
            this.states[id] = { ts: Date.now(), lc: Date.now(), q: 0, ...state };
        }
        if (this.connected) {
            this.emit(id, state === null ? null : this.states[id]);
        }
    }

    emit(id, state) {
        (this.subscriptions.get(id) || []).forEach(cb => cb(id, state === null ? null : clone(state)));
    }

    disconnect() {
        this.connected = false;
        this.connectionHandlers.forEach(handler => handler(false));
    }

    reconnect() {
        this.connected = true;
        this.connectionHandlers.forEach(handler => handler(true));
    }
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Wraps a socket so that any method outside the given list fails the test at once - a write that
 * is not supposed to happen cannot slip through as a quietly resolved promise.
 *
 * @param {FakeAdminSocket} socket
 * @param {string[]} allowed
 */
function guarded(socket, allowed = READS) {
    return new Proxy(socket, {
        get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver);
            if (typeof name === 'string' && typeof value === 'function' && !allowed.includes(name)) {
                return () => {
                    target.violations.push(name);
                    throw new Error(`socket.${name}() must not be called here`);
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

module.exports = { FakeAdminSocket, guarded, READS };
