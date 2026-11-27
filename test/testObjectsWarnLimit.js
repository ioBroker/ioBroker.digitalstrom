const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const { FakeAdminSocket, guarded, READS } = require('./lib/fakeAdminSocket');
const { waitFor } = require('./lib/helpers');

/**
 * Asserts that an object carries the given properties with these values; further
 * properties of the object do not matter.
 *
 * @param {Record<string, any>} actual object under test
 * @param {Record<string, any>} expected properties it has to contain
 * @param {string} [message] message on failure
 */
function assertIncludes(actual, expected, message) {
    const picked = Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
    assert.deepStrictEqual(picked, expected, message);
}

// The warn limit logic lives in the sources of the admin dialog, which are ES modules
const modulePath = path.join(__dirname, '..', 'src-admin', 'src', 'objectsWarnLimit.js');

/** @type {any} */
let lib;

const ADAPTER = 'digitalstrom';
const stateIdOf = instance => `system.adapter.${ADAPTER}.${instance}.objectsWarnLimit`;

/**
 * Objects and states of an installation as js-controller 7.2 leaves them.
 *
 * @param {object} [options]
 * @param {number} [options.instance]
 * @param {any} [options.state] the objectsWarnLimit state, undefined for none
 * @param {boolean} [options.object] whether the objectsWarnLimit object exists
 * @param {any} [options.adapterDefault] common.defaultObjectsWarnLimit of the instance object, null for none
 * @param {string} [options.controller] installedVersion of the host
 */
function installation({ instance = 0, state, object = true, adapterDefault = 10000, controller = '7.2.2' } = {}) {
    const id = stateIdOf(instance);
    const states = {};
    // The default comes from the INSTANCE object: js-controller builds common.def from it, and the
    // adapter object is shared by all hosts
    /** @type {Record<string, any>} */
    const objects = {
        [`system.adapter.${ADAPTER}.${instance}`]: {
            _id: `system.adapter.${ADAPTER}.${instance}`,
            type: 'instance',
            common: { name: ADAPTER, host: 'iobroker', version: '2.4.23', defaultObjectsWarnLimit: adapterDefault },
        },
        'system.host.iobroker': { _id: 'system.host.iobroker', type: 'host', common: { installedVersion: controller } },
    };
    if (adapterDefault === null) {
        delete objects[`system.adapter.${ADAPTER}.${instance}`].common.defaultObjectsWarnLimit;
    }
    if (object) {
        objects[id] = { _id: id, type: 'state', common: { type: 'number', def: adapterDefault ?? 5000 } };
    }
    if (state !== undefined) {
        states[id] = { ts: 1, lc: 1, q: 0, from: 'system.adapter.digitalstrom.0', ...state };
    }
    return { id, states, objects };
}

/**
 * @param {FakeAdminSocket|any} socket
 * @param {number} [instance]
 */
function createMonitor(socket, instance = 0) {
    const snapshots = [];
    const monitor = new lib.WarnLimitMonitor({
        socket,
        adapterName: ADAPTER,
        instance,
        host: 'iobroker',
        onUpdate: snapshot => snapshots.push(snapshot),
    });
    return { monitor, snapshots, view: () => lib.describeWarnLimit(monitor.snapshot) };
}

describe('Objects warn limit (admin dialog)', () => {
    before(async () => {
        lib = await import(pathToFileURL(modulePath).href);
    });

    describe('reading the stored value like js-controller does', () => {
        it('takes a number as it is', () => {
            assertIncludes(lib.classifyStoredValue({ val: 5000, ack: true }), {
                kind: 'number',
                value: 5000,
                unusual: null,
            });
        });

        it('does not accept a numeric string - typeof decides in js-controller', () => {
            assertIncludes(lib.classifyStoredValue({ val: '10000', ack: false }), {
                kind: 'invalid',
                reason: 'string',
                raw: '"10000"',
                ack: false,
            });
            assertIncludes(lib.classifyStoredValue({ val: '', ack: true }), {
                kind: 'invalid',
                reason: 'emptyString',
            });
            assertIncludes(lib.classifyStoredValue({ val: true, ack: true }), { kind: 'invalid', reason: 'type' });
        });

        it('tells a missing state from a state without value', () => {
            assert.deepStrictEqual(lib.classifyStoredValue(null), { kind: 'noState' });
            assertIncludes(lib.classifyStoredValue({ val: null, ack: true }), { kind: 'empty' });
        });

        it('keeps 0 and negative numbers but marks them - they do not switch the warning off', () => {
            assertIncludes(lib.classifyStoredValue({ val: 0, ack: true }), {
                kind: 'number',
                value: 0,
                unusual: 'notPositive',
            });
            assertIncludes(lib.classifyStoredValue({ val: -5, ack: true }), {
                kind: 'number',
                unusual: 'notPositive',
            });
            assertIncludes(lib.classifyStoredValue({ val: 1234.5, ack: true }), {
                kind: 'number',
                unusual: 'fraction',
            });
        });

        it('refuses numbers that are not finite', () => {
            assertIncludes(lib.classifyStoredValue({ val: Number.NaN }), { kind: 'invalid', reason: 'nonFinite' });
            assertIncludes(lib.classifyStoredValue({ val: Infinity }), { kind: 'invalid', reason: 'nonFinite' });
        });
    });

    describe('the input field', () => {
        it('accepts whole numbers of at least 1', () => {
            assert.deepStrictEqual(lib.parseLimitInput('10000'), { ok: true, value: 10000 });
            assert.deepStrictEqual(lib.parseLimitInput(' 15000 '), { ok: true, value: 15000 });
            assert.deepStrictEqual(lib.parseLimitInput('1'), { ok: true, value: 1 });
        });

        it('refuses separators instead of guessing what they mean', () => {
            assert.deepStrictEqual(lib.parseLimitInput('10.000'), { ok: false, reason: 'notWholeNumber' });
            assert.deepStrictEqual(lib.parseLimitInput('10,000'), { ok: false, reason: 'notWholeNumber' });
            assert.deepStrictEqual(lib.parseLimitInput('10 000'), { ok: false, reason: 'notWholeNumber' });
            assert.deepStrictEqual(lib.parseLimitInput('-1'), { ok: false, reason: 'notWholeNumber' });
            assert.deepStrictEqual(lib.parseLimitInput('1e4'), { ok: false, reason: 'notWholeNumber' });
        });

        it('refuses an empty field, 0 and numbers beyond what JavaScript counts exactly', () => {
            assert.deepStrictEqual(lib.parseLimitInput(''), { ok: false, reason: 'empty' });
            assert.deepStrictEqual(lib.parseLimitInput('0'), { ok: false, reason: 'tooSmall' });
            assert.deepStrictEqual(lib.parseLimitInput('99999999999999999999'), { ok: false, reason: 'tooLarge' });
        });
    });

    describe('formatting', () => {
        it('groups the digits for the language of the admin', () => {
            assert.strictEqual(lib.formatCount(5000, 'de'), '5.000');
            assert.strictEqual(lib.formatCount(10000, 'de'), '10.000');
            assert.strictEqual(lib.formatCount(15000, 'en'), '15,000');
        });

        it('falls back to the plain number for a language Intl does not know', () => {
            assert.strictEqual(lib.formatCount(5000, 'not a language tag!'), '5000');
        });
    });

    describe('reading an instance', () => {
        it('shows 5000 as set although this adapter version suggests 10000', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();

            const shown = view();
            assert.strictEqual(shown.status, 'ok');
            assert.strictEqual(shown.current, 5000, 'the value of the state, not the default');
            assert.strictEqual(shown.adapterDefault, 10000);
            assert.strictEqual(shown.adapterVersion, '2.4.23');
            assert.strictEqual(shown.differs, true);
            assert.strictEqual(shown.ack, true);
            assert.ok(shown.messages.map(m => m.key).includes('warnLimit_hint_differs'));
            assert.strictEqual(
                shown.messages.every(m => m.severity !== 'error'),
                true,
                'a difference is no error',
            );
        });

        it('shows 10000 and any other number just as they are stored', async () => {
            for (const val of [10000, 15000, 7321]) {
                const { states, objects } = installation({ state: { val, ack: true } });
                const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
                await monitor.start();
                assert.strictEqual(view().current, val);
                assert.strictEqual(view().differs, val !== 10000);
            }
        });

        it('builds the state id from the opened instance', async () => {
            const { id, states, objects } = installation({ instance: 1, state: { val: 12000, ack: true } });
            // A second instance with another value must not leak into the reading
            states[stateIdOf(0)] = { val: 5000, ack: true };
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket, 1);
            await monitor.start();

            assert.strictEqual(id, 'system.adapter.digitalstrom.1.objectsWarnLimit');
            assert.strictEqual(view().stateId, id);
            assert.strictEqual(view().current, 12000);
            const touched = socket.calls
                .filter(c => ['getState', 'subscribeState'].includes(c.method))
                .map(c => c.args[0]);
            assert.deepStrictEqual([...touched].sort(), [id, id]);
        });

        it('follows a change of the state without a draft - so the dialog does not count as changed', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, snapshots, view } = createMonitor(socket);
            await monitor.start();
            const before = snapshots.length;

            socket.external(id, { val: 20000, ack: false, from: 'system.adapter.admin.0' });

            assert.ok(snapshots.length > before);
            assert.strictEqual(view().current, 20000);
            assert.strictEqual(view().ack, false);
            assert.ok(
                view()
                    .messages.map(m => m.key)
                    .includes('warnLimit_hint_pending'),
            );
            assert.strictEqual(lib.evaluateDraft(null, monitor.snapshot).dirty, false, 'a reading is no change');
            assert.strictEqual(socket.writes.length, 0);
        });

        it('reads only - start, refresh, events, reconnect and closing never write', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(guarded(socket, READS));
            await monitor.start();
            await monitor.refresh();
            socket.external(id, { val: 6000, ack: true });
            socket.disconnect();
            socket.reconnect();
            await waitFor(() => !monitor.snapshot.loading);
            monitor.dispose();

            assert.strictEqual(socket.writes.length, 0);
            assert.strictEqual(
                socket.methods().every(m => READS.includes(m)),
                true,
            );
            assert.deepStrictEqual(socket.violations, [], 'refused calls, even if a caller caught them');
            assert.ok(!socket.methods().includes('setState'));
        });

        it('needs no running instance - it never asks the adapter', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            states['system.adapter.digitalstrom.0.alive'] = { val: false, ack: true };
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(guarded(socket, READS));
            await monitor.start();

            assert.strictEqual(view().current, 5000);
            assert.ok(!socket.methods().includes('sendTo'));
            assert.deepStrictEqual(socket.violations, []);
            assert.ok(!socket.calls.map(c => c.args[0]).includes('system.adapter.digitalstrom.0.alive'));
        });
    });

    describe('what cannot be read as a limit', () => {
        it('a missing state: the next start creates it from the default', async () => {
            const { states, objects } = installation({});
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assertIncludes(view(), { status: 'noValue', current: null, editable: true });
            assert.deepStrictEqual(
                view().messages.map(m => m.key),
                ['warnLimit_status_noState'],
            );
        });

        it('a state without value: the controller fallback is named as such, not as the instance value', async () => {
            const { states, objects } = installation({ state: { val: null, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const shown = view();
            assert.strictEqual(shown.current, null);
            assertIncludes(shown.messages[0], { key: 'warnLimit_status_empty', params: { fallback: 5000 } });
        });

        it('does not name a fallback number for a controller that was not checked', async () => {
            const { states, objects } = installation({ state: { val: null, ack: true }, controller: '8.0.0' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assert.strictEqual(view().messages[0].key, 'warnLimit_status_emptyUnknownFallback');
        });

        it('a numeric string is invalid, and unacknowledged it will be replaced by 5000', async () => {
            const { states, objects } = installation({ state: { val: '10000', ack: false } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const shown = view();
            assert.strictEqual(shown.status, 'invalid');
            assert.strictEqual(shown.current, null, 'never presented as a confirmed 10000');
            assert.strictEqual(shown.effective, 5000, 'what the controller applies, named as its replacement');
            assert.strictEqual(shown.ack, false, 'kept for the view model');
            // one message with cause, consequence and fix - not two that say almost the same
            assert.deepStrictEqual(
                shown.messages.map(m => m.key),
                ['warnLimit_status_invalidPending'],
            );
            assert.strictEqual(shown.messages[0].params.raw, '"10000"');

            const acknowledged = installation({ state: { val: '10000', ack: true } });
            const second = createMonitor(new FakeAdminSocket(acknowledged));
            await second.monitor.start();
            assert.deepStrictEqual(
                second.view().messages.map(m => m.key),
                ['warnLimit_status_invalid'],
            );
        });

        it('0 and negative numbers are shown but explained - they do not switch the warning off', async () => {
            for (const val of [0, -1]) {
                const { states, objects } = installation({ state: { val, ack: true } });
                const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
                await monitor.start();
                assertIncludes(view(), { status: 'unusual', current: val });
                assert.ok(
                    view()
                        .messages.map(m => m.key)
                        .includes('warnLimit_hint_notPositive'),
                );
            }
        });

        it('a refused read says so instead of showing a number', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects, denied: [id] }));
            await monitor.start();
            assertIncludes(view(), { status: 'noAccess', current: null, editable: false });
            assert.strictEqual(view().messages[0].key, 'warnLimit_error_permission');
        });

        it('a controller older than 7.1.0 has no limit per instance', async () => {
            const { states, objects } = installation({ object: false, controller: '7.0.7' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assertIncludes(view(), { status: 'unsupported', editable: false });
            assertIncludes(view().messages[0], {
                key: 'warnLimit_status_unsupported',
                params: { version: '7.0.7', min: '7.1.0' },
            });
        });

        it('a current controller without the state has just not started the instance since', async () => {
            const { states, objects } = installation({ object: false });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assertIncludes(view(), { status: 'noObject', editable: false });
            assert.strictEqual(view().messages[0].key, 'warnLimit_status_noObject');
        });

        it('an unreadable controller version is said, not guessed', async () => {
            const { states, objects } = installation({ object: false });
            const socket = new FakeAdminSocket({ states, objects, denied: ['system.host.iobroker'] });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            assert.strictEqual(view().messages[0].key, 'warnLimit_status_noObjectUnknownController');
        });

        it('an adapter object without a default leaves the default undetermined', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true }, adapterDefault: null });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assertIncludes(view(), { adapterDefault: null, adapterDefaultStatus: 'missing', differs: false });
        });

        it('points out that 7.1.0 and 7.1.1 ignore the default of io-package.json', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true }, controller: '7.1.1' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assert.ok(
                view()
                    .messages.map(m => m.key)
                    .includes('warnLimit_hint_defaultIgnored'),
            );
        });

        it('says "loading" before the first answer', () => {
            const { monitor, view } = createMonitor(new FakeAdminSocket());
            assertIncludes(view(), { status: 'loading', current: null });
            monitor.dispose();
        });
    });

    describe('findings of the review', () => {
        it('a state event during the host read is not overwritten by the older answer', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: false } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            let releaseHost = () => {};
            const getObject = socket.getObject.bind(socket);
            socket.getObject = oid =>
                oid.startsWith('system.host.')
                    ? new Promise(resolve => (releaseHost = () => resolve(getObject(oid))))
                    : getObject(oid);

            const refreshing = monitor.refresh();
            await waitFor(() => socket.methods().filter(m => m === 'getObject').length >= 1);
            await new Promise(resolve => setTimeout(resolve, 0));
            socket.external(id, { val: 5000, ack: true });
            releaseHost();
            await refreshing;
            assert.strictEqual(view().ack, true);
            monitor.dispose();
        });

        it('says "disconnected" when the connection goes before the first answer', () => {
            const { monitor, view } = createMonitor(new FakeAdminSocket());
            monitor.setConnected(false);
            assertIncludes(view(), { status: 'disconnected', editable: false });
            assert.strictEqual(view().messages[0].key, 'warnLimit_error_connection');
            monitor.dispose();
        });

        it('an unacknowledged empty state is filled with 5000 at the next start - the text says so', async () => {
            const { states, objects } = installation({ state: { val: null, ack: false } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            assert.strictEqual(view().messages[0].key, 'warnLimit_status_emptyPending');
            assert.strictEqual(view().effective, 5000);
        });

        it('a refused object read keeps a readable value visible but locks the field', async () => {
            const { id, states, objects } = installation({ state: { val: 10000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const getObject = socket.getObject.bind(socket);
            socket.getObject = oid => (oid === id ? Promise.reject('permissionError') : getObject(oid));
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            assertIncludes(view(), { current: 10000, editable: false });
            assert.ok(
                view()
                    .messages.map(m => m.key)
                    .includes('warnLimit_error_objectPermission'),
            );
        });

        it('a state that cannot be read cannot be overwritten from the card', async () => {
            const { states, objects } = installation({ state: { val: 10000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            socket.getState = () => Promise.reject('permissionError');
            socket.subscribeState = async () => {};
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            assertIncludes(view(), { status: 'noAccess', editable: false });
        });

        it('claims nothing for 7.0.8 nightlies, and names no replacement number from 7.3.0 on', async () => {
            const nightly = installation({ object: false, controller: '7.0.8' });
            const first = createMonitor(new FakeAdminSocket(nightly));
            await first.monitor.start();
            assert.strictEqual(first.view().status, 'noObject');
            assert.strictEqual(first.view().messages[0].key, 'warnLimit_status_noObjectUnknownController');

            const newer = installation({ state: { val: null, ack: true }, controller: '7.3.0' });
            const second = createMonitor(new FakeAdminSocket(newer));
            await second.monitor.start();
            assert.strictEqual(second.view().messages[0].key, 'warnLimit_status_emptyUnknownFallback');
            assert.strictEqual(second.view().effective, null);
        });

        it('an empty text is explained like an empty state, other types are named', async () => {
            const blank = installation({ state: { val: '', ack: false } });
            const first = createMonitor(new FakeAdminSocket(blank));
            await first.monitor.start();
            assert.strictEqual(first.view().messages[0].key, 'warnLimit_status_emptyPending');

            const flag = installation({ state: { val: true, ack: true } });
            const second = createMonitor(new FakeAdminSocket(flag));
            await second.monitor.start();
            assert.strictEqual(second.view().messages[0].params.type, 'warnLimit_type_other');
        });

        it('a timeout means "outcome unknown", not "not saved"', () => {
            assertIncludes(lib.classifyError(new Error('timeout'), true), { kind: 'connection', timedOut: true });
            assertIncludes(lib.classifyError('timeout', true), { timedOut: true });
            assertIncludes(lib.classifyError(new Error('notConnectedError'), false), { timedOut: false });
        });

        it('closing the dialog drops the timers of requests that never answer', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            socket.holdReads = true;
            const { monitor } = createMonitor(socket);
            void monitor.refresh();
            await waitFor(() => monitor.timers.size === 3);
            monitor.dispose();
            assert.strictEqual(monitor.timers.size, 0);
        });

        it('a save without any change writes nothing', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(guarded(socket, READS));
            await monitor.start();
            const calls = [];
            const result = await lib.saveDialog({
                draft: null,
                snapshot: monitor.snapshot,
                monitor,
                nativeChanged: () => false,
                saveSettings: () => calls.push('settings'),
                finish: () => calls.push('finish'),
            });
            assert.strictEqual(result.outcome, 'nothing');
            assert.deepStrictEqual(calls, ['finish']);
            assert.deepStrictEqual(socket.violations, []);
        });
    });

    describe('connection and timing', () => {
        it('marks the reading as possibly outdated while the connection is gone, and reads again after it', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();

            socket.disconnect();
            assert.strictEqual(view().stale, true);
            assert.strictEqual(view().editable, false);
            assert.strictEqual(view().messages[0].key, 'warnLimit_hint_stale');
            // changed meanwhile - no event reaches a closed connection
            socket.external(id, { val: 9000, ack: true });
            assert.strictEqual(view().current, 5000);

            socket.reconnect();
            await waitFor(() => monitor.snapshot.loaded && !monitor.snapshot.loading && view().current === 9000);
            assert.strictEqual(view().stale, false);
            assert.strictEqual(
                socket.methods().filter(m => m === 'subscribeState').length,
                1,
                'socket-client renews it itself',
            );
        });

        it('an older read answer does not overwrite a newer change', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();

            socket.holdReads = true;
            const refreshing = monitor.refresh();
            await waitFor(() => socket.held.length === 3);
            socket.external(id, { val: 8000, ack: false });
            socket.holdReads = false;
            socket.releaseHeld();
            await refreshing;

            assert.strictEqual(view().current, 8000);
        });

        it('an older refresh does not overwrite a newer one', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            monitor.dispose();

            // a fresh monitor without subscription events in between
            const second = createMonitor(socket);
            socket.holdReads = true;
            const older = second.monitor.refresh();
            await waitFor(() => socket.held.length === 3);
            socket.states[id] = { val: 11000, ack: true };
            const newer = second.monitor.refresh();
            await waitFor(() => socket.held.length === 6);
            socket.holdReads = false;
            // the newer answers arrive first, the older ones last
            const held = socket.held.splice(0);
            held.slice(3).forEach(entry => entry.resolve());
            await newer;
            held.slice(0, 3).forEach(entry => entry.resolve());
            await older;
            assert.strictEqual(second.view().current, 11000);
            assert.strictEqual(view().current, 5000);
            second.monitor.dispose();
        });

        it('does not stay "loading" when the connection drops during a read', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(socket);
            socket.holdReads = true;
            void monitor.start();
            await waitFor(() => socket.held.length > 0);

            socket.disconnect();
            assert.strictEqual(monitor.snapshot.loading, false);

            socket.holdReads = false;
            socket.reconnect();
            await waitFor(() => monitor.snapshot.loaded && !monitor.snapshot.loading);
            assert.strictEqual(lib.describeWarnLimit(monitor.snapshot).current, 5000);
            monitor.dispose();
        });

        it('gives up on a read that never answers', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            socket.holdReads = true;
            const monitor = new lib.WarnLimitMonitor({
                socket,
                adapterName: ADAPTER,
                instance: 0,
                host: 'iobroker',
                onUpdate: () => {},
                timeout: 30,
            });
            await monitor.refresh();
            assertIncludes(lib.describeWarnLimit(monitor.snapshot), { status: 'disconnected' });
            monitor.dispose();
        });

        it('lets go of everything when the dialog closes, and ignores late answers', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, snapshots } = createMonitor(socket);
            await monitor.start();
            socket.holdReads = true;
            const late = monitor.refresh();
            await waitFor(() => socket.held.length === 3);
            const count = snapshots.length;

            monitor.dispose();
            socket.holdReads = false;
            socket.releaseHeld();
            await late;
            socket.external(id, { val: 1, ack: true });

            assert.strictEqual(snapshots.length, count);
            assert.strictEqual(socket.subscriptions.has(id), false);
            assert.strictEqual(socket.connectionHandlers.length, 0);
        });
    });

    describe('changing the limit', () => {
        it('a typed value is a change only when it differs from what is stored', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const snap = monitor.snapshot;

            assertIncludes(lib.evaluateDraft(null, snap), { dirty: false });
            assertIncludes(lib.evaluateDraft('5000', snap), { dirty: false });
            assert.deepStrictEqual(lib.evaluateDraft('10000', snap), { dirty: true, valid: true, value: 10000 });
            assert.deepStrictEqual(lib.evaluateDraft('10.000', snap), { dirty: true, valid: false, value: null });
            assertIncludes(lib.evaluateDraft('', snap), { dirty: true, valid: false });
        });

        it('an emptied field is no change when nothing usable was stored', () => {
            const { id } = installation({});
            const snapshot = {
                ...lib.initialSnapshot(id),
                loaded: true,
                state: { status: 'ok', value: { val: '10000' } },
            };
            assertIncludes(lib.evaluateDraft('', snapshot), { dirty: false });
        });

        it('saving only the limit writes the number with ack=false and leaves the instance object alone', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(guarded(socket, [...READS, 'setState']));
            await monitor.start();
            const calls = [];

            const result = await lib.saveDialog({
                draft: '10000',
                snapshot: monitor.snapshot,
                monitor,
                nativeChanged: () => false,
                saveSettings: () => calls.push('settings'),
                finish: () => calls.push('finish'),
            });

            assert.strictEqual(result.outcome, 'limit');
            assert.deepStrictEqual(calls, ['finish'], 'writing the instance object would restart the instance');
            assert.deepStrictEqual(socket.writes, [{ id, state: { val: 10000, ack: false } }]);
            assert.strictEqual(typeof socket.states[id].val, 'number', 'js-controller only takes a number');
            assert.strictEqual(view().current, 10000);
            assert.strictEqual(view().ack, false);
            assert.ok(
                view()
                    .messages.map(m => m.key)
                    .includes('warnLimit_hint_pending'),
            );
            assert.strictEqual(lib.evaluateDraft('10000', monitor.snapshot).dirty, false, 'the draft is saved now');
        });

        it('saving the limit together with settings writes the state first', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(socket);
            await monitor.start();
            const order = [];
            const originalSetState = socket.setState.bind(socket);
            socket.setState = (...args) => {
                order.push('state');
                return originalSetState(...args);
            };

            const result = await lib.saveDialog({
                draft: '15000',
                snapshot: monitor.snapshot,
                monitor,
                nativeChanged: () => true,
                saveSettings: () => order.push('settings'),
                finish: () => order.push('finish'),
            });

            assert.strictEqual(result.outcome, 'both');
            assert.deepStrictEqual(order, ['state', 'settings']);
        });

        it('without a pending limit the settings are saved exactly as before and nothing else is written', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(guarded(socket, READS));
            await monitor.start();
            const calls = [];

            for (const draft of [null, '5000']) {
                const result = await lib.saveDialog({
                    draft,
                    snapshot: monitor.snapshot,
                    monitor,
                    nativeChanged: () => true,
                    saveSettings: () => calls.push('settings'),
                    finish: () => calls.push('finish'),
                });
                assert.strictEqual(result.outcome, 'settings');
            }
            assert.deepStrictEqual(calls, ['settings', 'settings']);
            assert.strictEqual(socket.writes.length, 0);
        });

        it('a refused write saves nothing else, so the dialog stays unsaved', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects, deniedWrites: [id] });
            const { monitor } = createMonitor(socket);
            await monitor.start();
            const calls = [];

            const result = await lib.saveDialog({
                draft: '10000',
                snapshot: monitor.snapshot,
                monitor,
                nativeChanged: () => true,
                saveSettings: () => calls.push('settings'),
                finish: () => calls.push('finish'),
            });

            assert.strictEqual(result.outcome, 'failed');
            assert.strictEqual(lib.classifyError(result.error, true).kind, 'permission');
            assert.strictEqual(calls.length, 0);
            assert.strictEqual(socket.states[id].val, 5000);
        });

        it('an invalid draft is not written', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(guarded(socket, READS));
            await monitor.start();
            const result = await lib.saveDialog({
                draft: '10.000',
                snapshot: monitor.snapshot,
                monitor,
                nativeChanged: () => false,
                saveSettings: () => {
                    throw new Error('must not save');
                },
                finish: () => {
                    throw new Error('must not finish');
                },
            });
            assert.strictEqual(result.outcome, 'invalid');
            assert.strictEqual(socket.writes.length, 0);
        });

        it('never creates the state without its object, and never writes anything but a whole number', async () => {
            const { id, states, objects } = installation({ object: false });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(socket);
            await monitor.start();
            await assert.rejects(monitor.save(10000), { message: /does not exist/ });

            objects[id] = { type: 'state', common: { type: 'number' } };
            socket.objects[id] = objects[id];
            await monitor.refresh();
            await assert.rejects(monitor.save(/** @type {any} */ ('10000')), { message: /not a valid limit/ });
            await assert.rejects(monitor.save(0), { message: /not a valid limit/ });
            assert.strictEqual(socket.writes.length, 0);
        });

        it('does not take the encrypted token GenericApp remembers after a save for a changed setting', () => {
            const secret = 'Zgfr56gFe87jJOM';
            const xor = value =>
                [...value]
                    .map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0)))
                    .join('');
            const native = { host: '10.0.0.2', appToken: 'abcdef', smartHomeApiKey: '' };
            const savedNative = { host: '10.0.0.2', appToken: xor('abcdef'), smartHomeApiKey: '' };

            assert.strictEqual(
                JSON.stringify(native) !== JSON.stringify(savedNative),
                true,
                'what GenericApp compares',
            );
            assert.strictEqual(lib.isNativeChanged(native, savedNative, ['appToken', 'smartHomeApiKey'], xor), false);
            assert.strictEqual(
                lib.isNativeChanged({ ...native, host: '10.0.0.3' }, savedNative, ['appToken'], xor),
                true,
            );
            assert.strictEqual(
                lib.isNativeChanged({ ...native, appToken: 'other' }, savedNative, ['appToken'], xor),
                true,
            );
        });
    });

    describe('the card in the settings tab', function () {
        // The real Settings.jsx with MUI, rendered to HTML through the vite of this repository - no
        // browser, no extra dependency. Starting vite takes a moment on a slow runner.
        this.timeout(120000);

        /** @type {any} */
        let server;
        /** @type {any} */
        let Settings;
        const React = require('react');
        const { renderToStaticMarkup } = require('react-dom/server');
        const readJson = lang => require(path.join(__dirname, '..', 'src-admin', 'src', 'i18n', `${lang}.json`));

        before(async () => {
            const os = require('os');
            const { createServer } = await import('vite');
            server = await createServer({
                configFile: false,
                root: path.join(__dirname, '..', 'src-admin'),
                cacheDir: path.join(os.tmpdir(), 'iobroker-digitalstrom-vite-test'),
                logLevel: 'error',
                appType: 'custom',
                server: { middlewareMode: true, hmr: false, watch: null },
                // The icons ship as directory imports Node cannot resolve on its own
                ssr: { noExternal: [/^@mui\//] },
                optimizeDeps: { noDiscovery: true, include: [] },
            });
            Settings = (await server.ssrLoadModule('/src/Settings.jsx')).default;
        });

        after(async () => {
            if (server) {
                await server.close();
            }
        });

        /**
         * @param {object} options
         * @param {any} [options.install] arguments for installation()
         * @param {string} [options.lang]
         * @param {number} [options.tab]
         * @param {string|null} [options.draft]
         * @param {number} [options.instance]
         */
        async function render({ install = {}, lang = 'de', tab = 2, draft = null, instance = 0 } = {}) {
            const { states, objects } = installation({ instance, ...install });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(guarded(socket, READS), instance);
            await monitor.start();
            const words = readJson(lang);
            const changes = [];
            // @types/react 19 (pulled in by MUI) types createElement() of a class component as a
            // CElement that it no longer accepts as ReactNode, although react 18 renders it fine
            const element = /** @type {any} */ (
                React.createElement(Settings, {
                    native: { dataPollInterval: 100 },
                    onChange: (...args) => changes.push(args),
                    onSendTo: async () => ({}),
                    alive: false,
                    t: key => words[key] || key,
                    initialTab: tab,
                    lang,
                    warnLimit: { snapshot: monitor.snapshot, draft, draftBase: 5000, saveError: '' },
                })
            );
            const html = renderToStaticMarkup(element);
            monitor.dispose();
            // MUI renders its styles inline into the markup - they are not text
            const text = html
                .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&quot;/g, '"')
                .replace(/&#x27;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ');
            return { html, text, changes, socket };
        }

        it('shows the set value, the default and the state id of the instance', async () => {
            const { text, html, changes, socket } = await render({ install: { state: { val: 5000, ack: true } } });

            assert.ok(text.includes('Objekt-Warngrenze'));
            assert.ok(text.includes('Aktuell eingestellte Warngrenze 5.000 Objekte'));
            assert.ok(text.includes('Adapter-Standard 10.000 Objekte'));
            assert.ok(text.includes('Quelle Instanz-Datenpunkt'));
            assert.ok(text.includes('system.adapter.digitalstrom.0.objectsWarnLimit'));
            assert.ok(text.includes('Die eingestellte Warngrenze weicht vom Adapter-Standard ab.'));
            assert.ok(text.includes('Neu einlesen'));
            assert.ok(text.includes('Datenpunkt kopieren'));
            assert.ok(!html.includes('MuiAlert-standardError'), 'a difference is no error');
            assert.strictEqual(changes.length, 0, 'showing the card changes no setting');
            assert.strictEqual(socket.writes.length, 0);
        });

        it('formats the numbers for the language', async () => {
            const { text } = await render({ install: { state: { val: 15000, ack: true } }, lang: 'en' });
            assert.ok(text.includes('Currently configured warning limit 15,000 objects'));
            assert.ok(text.includes('Adapter default 10,000 objects'));
        });

        it('shows 10000 without a difference hint', async () => {
            const { text } = await render({ install: { state: { val: 10000, ack: true } } });
            assert.ok(text.includes('Aktuell eingestellte Warngrenze 10.000 Objekte'));
            assert.ok(!text.includes('weicht vom Adapter-Standard ab'));
        });

        it('names the state of instance 1 for instance 1', async () => {
            const { text } = await render({ instance: 1, install: { state: { val: 8000, ack: true } } });
            assert.ok(text.includes('system.adapter.digitalstrom.1.objectsWarnLimit'));
            assert.ok(!text.includes('system.adapter.digitalstrom.0.objectsWarnLimit'));
        });

        it('says in plain words what an invalid entry means and how to fix it', async () => {
            const { text, html } = await render({ install: { state: { val: '10000', ack: false } } });
            assert.ok(text.includes('Aktuell eingestellte Warngrenze Kein gültiger Wert'));
            assert.ok(text.includes('Beim Start gilt: 5.000 Objekte – Ersatzwert des js-controllers'));
            assert.ok(text.includes('Quelle Ersatzwert des js-controllers – im Datenpunkt steht keine gültige Zahl'));
            // "10000" looks like a number - the text has to say that it is stored as text
            assert.ok(text.includes('Im Datenpunkt steht "10000" – aber als Text, nicht als Zahl.'));
            assert.ok(text.includes('seinen Ersatzwert von 5.000 Objekten'));
            assert.ok(text.includes('So behebst du es:'));
            assert.ok(html.includes('<strong>So behebst du es:</strong>'), 'the fix is set in bold');
            assert.ok(!text.includes('gilt ab dem nächsten Start'), 'a status chip would repeat the message');
            assert.strictEqual((html.match(/MuiAlert-standardWarning/g) || []).length, 1, 'one warning, not two');
        });

        it('marks a saved but not yet applied value as such', async () => {
            const { text } = await render({ install: { state: { val: 12000, ack: false } } });
            assert.ok(text.includes('Aktuell eingestellte Warngrenze 12.000 Objekte gilt ab dem nächsten Start'));
            assert.ok(text.includes('bis dahin ändert sich nichts'));
        });

        it('explains a controller without the feature and locks the field', async () => {
            const { text, html } = await render({ install: { object: false, controller: '7.0.7' } });
            assert.ok(text.includes('Aktuell eingestellte Warngrenze Nicht unterstützt'));
            assert.ok(text.includes('js-controller 7.0.7'));
            assert.ok(text.includes('Nicht änderbar'));
            assert.match(html, /<input[^>]*disabled/);
        });

        it('answers what one wants to know before changing it', async () => {
            const { text } = await render({ install: { state: { val: 5000, ack: true } } });
            assert.ok(text.includes('Vor dem Ändern'));
            assert.ok(text.includes('Muss ich die Grenze ändern?'));
            assert.ok(text.includes('6.000 Objekte bei einer Grenze von 5.000'));
            assert.ok(text.includes('Alle Objekte werden trotzdem angelegt und arbeiten normal'));
            assert.ok(text.includes('Wird digitalSTROM oder ioBroker dadurch langsamer oder schneller?'));
            assert.ok(text.includes('Der Adapter selbst liest die Grenze nicht'));
            assert.ok(text.includes('Eine andere Grenze legt kein Objekt an und entfernt keines.'));
            assert.ok(text.includes('Welcher Wert ist sinnvoll?'));
            assert.ok(text.includes('Betrifft das andere Instanzen oder Adapter?'));
        });

        it('explains the limit, the start-only check and where else it can be changed', async () => {
            const { text } = await render({ install: { state: { val: 5000, ack: true } } });
            assert.ok(text.includes('Sie begrenzt weder die Anzahl der angelegten Objekte noch deren Anzeige'));
            assert.ok(text.includes('Eine höhere Grenze reduziert nicht den Speicherverbrauch'));
            assert.ok(text.includes('nur beim Start der Instanz'));
            assert.ok(text.includes('Expertenmodus'));
            assert.ok(text.includes('nicht common.def'));
            assert.ok(text.includes('z. B. 10000'));
        });

        it('tells a typed value from a saved one and refuses separators', async () => {
            const pending = await render({ install: { state: { val: 5000, ack: true } }, draft: '12000' });
            assert.ok(pending.text.includes('Noch nicht gespeichert – klicke unten auf „Speichern“.'));
            const invalid = await render({ install: { state: { val: 5000, ack: true } }, draft: '12.000' });
            assert.ok(invalid.text.includes('Nur Ziffern'));
        });

        it('stays out of the other tabs', async () => {
            for (const tab of [0, 1, 3]) {
                const { text } = await render({ install: { state: { val: 5000, ack: true } }, tab });
                assert.ok(!text.includes('Objekt-Warngrenze'), `tab ${tab}`);
            }
        });
    });

    describe('saving through the real dialog (GenericApp of adapter-react-v5)', function () {
        // App.jsx with the unmodified GenericApp, loaded through vite in Node. The browser around it
        // is reduced to what GenericApp touches, and setState applies at once instead of rendering.
        this.timeout(120000);

        const SECRET = 'Zgfr56gFe87jJOM';
        const xor = value =>
            [...value]
                .map((c, i) => String.fromCharCode(SECRET.charCodeAt(i % SECRET.length) ^ c.charCodeAt(0)))
                .join('');
        const posted = [];
        const replaced = {};
        /** @type {any} */
        let server;
        /** @type {any} */
        let App;

        before(async () => {
            const store = {};
            const storage = {
                getItem: key => store[key] ?? null,
                setItem: (key, value) => (store[key] = String(value)),
                removeItem: key => delete store[key],
            };
            const browser = {
                window: globalThis,
                localStorage: storage,
                sessionStorage: storage,
                location: {
                    search: '?0',
                    pathname: '/adapter/digitalstrom/index.html',
                    hash: '',
                    host: 'x',
                    hostname: 'x',
                    port: '',
                    protocol: 'http:',
                    href: 'http://x/adapter/digitalstrom/index.html?0',
                },
                parent: { postMessage: message => posted.push(message) },
                addEventListener: () => {},
                removeEventListener: () => {},
                matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
                document: {
                    title: '',
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    getElementById: () => null,
                    getElementsByTagName: () => [],
                    addEventListener() {},
                    removeEventListener() {},
                    createElement: () => ({ style: {}, setAttribute() {} }),
                    head: { appendChild() {} },
                    body: { appendChild() {}, removeChild() {} },
                    documentElement: { style: {} },
                },
            };
            for (const [name, value] of Object.entries(browser)) {
                replaced[name] = Object.getOwnPropertyDescriptor(globalThis, name);
                Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
            }
            const os = require('os');
            const { createServer } = await import('vite');
            server = await createServer({
                configFile: false,
                root: path.join(__dirname, '..', 'src-admin'),
                cacheDir: path.join(os.tmpdir(), 'iobroker-digitalstrom-vite-test'),
                logLevel: 'error',
                appType: 'custom',
                server: { middlewareMode: true, hmr: false, watch: null },
                ssr: { noExternal: [/^@mui\//, '@iobroker/adapter-react-v5'] },
                // Node 22 cannot import the named export of the CommonJS react-color, see the stub
                resolve: { alias: { 'react-color': path.join(__dirname, 'lib', 'reactColorStub.mjs') } },
                optimizeDeps: { noDiscovery: true, include: [] },
            });
            // adapter-react-v5 greets the console with a banner when it loads
            const log = console.log;
            console.log = () => {};
            try {
                App = (await server.ssrLoadModule('/src/App.jsx')).default;
            } finally {
                console.log = log;
            }
        });

        after(async () => {
            if (server) {
                await server.close();
            }
            for (const [name, descriptor] of Object.entries(replaced)) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globalThis[name];
                }
            }
        });

        async function openDialog(stateValue = { val: 5000, ack: true }) {
            const { id, states, objects } = installation({ state: stateValue });
            const instanceId = `system.adapter.${ADAPTER}.0`;
            objects['system.config'] = { common: { language: 'de', diag: 'none' }, native: { secret: SECRET } };
            objects[instanceId].native = { host: '10.0.0.2', appToken: xor('token') };
            objects[instanceId].encryptedNative = ['appToken'];
            /** @type {any} */
            let socket;
            class Connection extends FakeAdminSocket {
                constructor(props) {
                    super({ states, objects });
                    this.props = props;
                    socket = this;
                }
            }
            const log = console.log;
            console.log = () => {};
            const app = new App({ Connection });
            console.log = log;
            app.setState = (update, callback) => {
                const patch = typeof update === 'function' ? update(app.state) : update;
                if (patch) {
                    app.state = { ...app.state, ...patch };
                }
                callback?.();
            };
            posted.length = 0;
            socket.props.onReady();
            await waitFor(() => app.state.loaded && app.state.warnLimit.snapshot?.loaded);
            return { app, socket, id, instanceId };
        }

        it('a limit-only save writes the state and never the instance object', async () => {
            const { app, socket, id } = await openDialog();
            app.onWarnLimitDraft('10000');
            assert.strictEqual(app.state.changed, true);
            assert.ok(posted.includes('change'));

            await app.onSave(false);
            assert.deepStrictEqual(socket.writes, [{ id, state: { val: 10000, ack: false } }]);
            assert.ok(!socket.methods().includes('setObject'), 'an object write restarts the instance');
            assert.strictEqual(app.state.changed, false);
            assert.strictEqual(app.state.warnLimit.draft, null);
            app.componentWillUnmount();
        });

        it('after a save that kept the dialog open, a reverted draft leaves nothing to save', async () => {
            const { app, socket } = await openDialog();
            app.updateNativeValue('host', '10.0.0.3');
            app.onSave(false);
            await waitFor(() => socket.methods().includes('setObject') && !app.state.changed);
            assert.notStrictEqual(
                JSON.stringify(app.state.native),
                JSON.stringify(app.savedNative),
                'GenericApp keeps the token encrypted now',
            );

            app.onWarnLimitDraft('12000');
            assert.strictEqual(app.state.changed, true);
            app.onWarnLimitDraft(null);
            assert.strictEqual(app.state.changed, false, 'the review found this stuck on true');

            await app.onSave(false);
            assert.strictEqual(socket.methods().filter(m => m === 'setObject').length, 1);
            app.componentWillUnmount();
        });

        it('"save and close" during a running limit save closes once it is done', async () => {
            const { app, socket } = await openDialog();
            let release = () => {};
            const setState = socket.setState.bind(socket);
            socket.setState = (...args) => new Promise(resolve => (release = () => resolve(setState(...args))));
            app.onWarnLimitDraft('10000');

            const first = app.onSave(false);
            await waitFor(() => app.state.warnLimit.saving);
            void app.onSave(true);
            release();
            await first;
            assert.ok(posted.includes('close'));
            assert.ok(!socket.methods().includes('setObject'));
            app.componentWillUnmount();
        });

        it('clears its own configuration error whatever language it was raised in', async () => {
            const { app } = await openDialog();
            app.onWarnLimitDraft('10.000');
            assert.notStrictEqual(app.state.isConfigurationError, '');
            app.setState({ isConfigurationError: 'Object warning limit: please enter a whole number of at least 1.' });
            app.onWarnLimitDraft('12000');
            assert.strictEqual(app.state.isConfigurationError, '');
            app.componentWillUnmount();
        });

        it('closing after "discard" inside the page does not make admin ask a second time', async () => {
            const { app } = await openDialog();
            app.onWarnLimitDraft('12000');
            posted.length = 0;
            // what GenericApp's own confirmation calls after "discard"
            Object.getPrototypeOf(App).onClose();
            assert.deepStrictEqual(posted, ['nochange', 'close']);
            app.componentWillUnmount();
        });

        it('readings never mark the dialog as changed', async () => {
            const { app, socket, id } = await openDialog();
            socket.external(id, { val: 7000, ack: false });
            await app.warnLimitMonitor.refresh();
            assert.strictEqual(app.state.changed, false);
            assert.ok(!posted.includes('change'));
            assert.strictEqual(socket.writes.length, 0);
            app.componentWillUnmount();
        });
    });

    describe('texts', () => {
        const i18nDir = path.join(__dirname, '..', 'src-admin', 'src', 'i18n');
        const languages = require('fs')
            .readdirSync(i18nDir)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace('.json', ''));

        it('every key the card builds at runtime exists in every language', async () => {
            const keys = new Set([
                'warnLimit_input_empty',
                'warnLimit_input_notWholeNumber',
                'warnLimit_input_tooSmall',
                'warnLimit_input_tooLarge',
            ]);
            const cases = [
                { state: { val: 5000, ack: false }, controller: '7.1.1' },
                { state: { val: 0, ack: true } },
                { state: { val: 1.5, ack: true } },
                { state: { val: null, ack: true } },
                { state: { val: null, ack: true }, controller: '9.0.0' },
                { state: { val: 'x', ack: false } },
                { state: { val: 'x', ack: true }, controller: '9.0.0' },
                { state: { val: true, ack: true } },
                {},
                { object: false },
                { object: false, controller: '7.0.7' },
                { object: false, controller: 'unknown' },
                { state: { val: 5000, ack: true }, object: true, controller: '7.0.7' },
            ];
            for (const install of cases) {
                const { states, objects } = installation(install);
                const socket = new FakeAdminSocket({ states, objects });
                const { monitor, view } = createMonitor(socket);
                await monitor.start();
                view().messages.forEach(m => keys.add(m.key));
                view().messages.forEach(m => m.params?.type && keys.add(m.params.type));
                socket.disconnect();
                view().messages.forEach(m => keys.add(m.key));
                monitor.dispose();
            }
            for (const denied of ['state', 'other']) {
                const { id, states, objects } = installation({ state: { val: 1, ack: true } });
                const socket = new FakeAdminSocket({ states, objects, denied: denied === 'state' ? [id] : [] });
                if (denied === 'other') {
                    socket.getState = () => Promise.reject(new Error('boom'));
                }
                const { monitor, view } = createMonitor(socket);
                await monitor.start();
                view().messages.forEach(m => keys.add(m.key));
                monitor.dispose();
            }
            const connectionError = lib.describeWarnLimit({
                ...lib.initialSnapshot('x'),
                loaded: true,
                state: { status: 'error', value: null, error: { kind: 'connection', message: 'timeout' } },
            });
            connectionError.messages.forEach(m => keys.add(m.key));

            lib.WARN_LIMIT_QUESTIONS.forEach(question => {
                keys.add(`warnLimit_faq_${question}_q`);
                keys.add(`warnLimit_faq_${question}_a`);
            });
            assert.ok(keys.size >= 30);
            for (const lang of languages) {
                const words = JSON.parse(require('fs').readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
                for (const key of keys) {
                    assert.ok(key in words, `${lang}.json lacks ${key}`);
                }
            }
        });

        it('the save path asks only for texts that exist', () => {
            const app = require('fs').readFileSync(path.join(__dirname, '..', 'src-admin', 'src', 'App.jsx'), 'utf8');
            const used = [...app.matchAll(/I18n\.t\('([a-zA-Z0-9_]+)'\)/g)].map(match => match[1]);
            assert.deepStrictEqual(
                [
                    'warnLimit_configError',
                    'warnLimit_save_permission',
                    'warnLimit_save_connection',
                    'warnLimit_save_failed',
                ].filter(member => !used.includes(member)),
                [],
            );
            for (const lang of languages) {
                const words = JSON.parse(require('fs').readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
                used.forEach(key => assert.ok(key in words, `${lang}.json lacks ${key}`));
            }
        });
    });

    describe('versions', () => {
        it('compares like semver and ignores a prerelease', () => {
            assert.strictEqual(lib.compareVersions('7.1.0', '7.1.0'), 0);
            assert.ok(lib.compareVersions('7.0.7', '7.1.0') < 0);
            assert.ok(lib.compareVersions('7.2.3-alpha.18', '7.1.2') > 0);
            assert.strictEqual(lib.compareVersions('garbage', '7.1.0'), null);
        });
    });
});
