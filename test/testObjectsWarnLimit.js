const { expect } = require('chai');
const path = require('path');
const { pathToFileURL } = require('url');

const { FakeAdminSocket, guarded, READS } = require('./lib/fakeAdminSocket');
const { waitFor } = require('./lib/helpers');

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
            expect(lib.classifyStoredValue({ val: 5000, ack: true })).to.include({
                kind: 'number',
                value: 5000,
                unusual: null,
            });
        });

        it('does not accept a numeric string - typeof decides in js-controller', () => {
            expect(lib.classifyStoredValue({ val: '10000', ack: false })).to.include({
                kind: 'invalid',
                reason: 'string',
                raw: '"10000"',
                ack: false,
            });
            expect(lib.classifyStoredValue({ val: '', ack: true })).to.include({
                kind: 'invalid',
                reason: 'emptyString',
            });
            expect(lib.classifyStoredValue({ val: true, ack: true })).to.include({ kind: 'invalid', reason: 'type' });
        });

        it('tells a missing state from a state without value', () => {
            expect(lib.classifyStoredValue(null)).to.deep.equal({ kind: 'noState' });
            expect(lib.classifyStoredValue({ val: null, ack: true })).to.include({ kind: 'empty' });
        });

        it('keeps 0 and negative numbers but marks them - they do not switch the warning off', () => {
            expect(lib.classifyStoredValue({ val: 0, ack: true })).to.include({
                kind: 'number',
                value: 0,
                unusual: 'notPositive',
            });
            expect(lib.classifyStoredValue({ val: -5, ack: true })).to.include({
                kind: 'number',
                unusual: 'notPositive',
            });
            expect(lib.classifyStoredValue({ val: 1234.5, ack: true })).to.include({
                kind: 'number',
                unusual: 'fraction',
            });
        });

        it('refuses numbers that are not finite', () => {
            expect(lib.classifyStoredValue({ val: Number.NaN })).to.include({ kind: 'invalid', reason: 'nonFinite' });
            expect(lib.classifyStoredValue({ val: Infinity })).to.include({ kind: 'invalid', reason: 'nonFinite' });
        });
    });

    describe('the input field', () => {
        it('accepts whole numbers of at least 1', () => {
            expect(lib.parseLimitInput('10000')).to.deep.equal({ ok: true, value: 10000 });
            expect(lib.parseLimitInput(' 15000 ')).to.deep.equal({ ok: true, value: 15000 });
            expect(lib.parseLimitInput('1')).to.deep.equal({ ok: true, value: 1 });
        });

        it('refuses separators instead of guessing what they mean', () => {
            expect(lib.parseLimitInput('10.000')).to.deep.equal({ ok: false, reason: 'notWholeNumber' });
            expect(lib.parseLimitInput('10,000')).to.deep.equal({ ok: false, reason: 'notWholeNumber' });
            expect(lib.parseLimitInput('10 000')).to.deep.equal({ ok: false, reason: 'notWholeNumber' });
            expect(lib.parseLimitInput('-1')).to.deep.equal({ ok: false, reason: 'notWholeNumber' });
            expect(lib.parseLimitInput('1e4')).to.deep.equal({ ok: false, reason: 'notWholeNumber' });
        });

        it('refuses an empty field, 0 and numbers beyond what JavaScript counts exactly', () => {
            expect(lib.parseLimitInput('')).to.deep.equal({ ok: false, reason: 'empty' });
            expect(lib.parseLimitInput('0')).to.deep.equal({ ok: false, reason: 'tooSmall' });
            expect(lib.parseLimitInput('99999999999999999999')).to.deep.equal({ ok: false, reason: 'tooLarge' });
        });
    });

    describe('formatting', () => {
        it('groups the digits for the language of the admin', () => {
            expect(lib.formatCount(5000, 'de')).to.equal('5.000');
            expect(lib.formatCount(10000, 'de')).to.equal('10.000');
            expect(lib.formatCount(15000, 'en')).to.equal('15,000');
        });

        it('falls back to the plain number for a language Intl does not know', () => {
            expect(lib.formatCount(5000, 'not a language tag!')).to.equal('5000');
        });
    });

    describe('reading an instance', () => {
        it('shows 5000 as set although this adapter version suggests 10000', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();

            const shown = view();
            expect(shown.status).to.equal('ok');
            expect(shown.current, 'the value of the state, not the default').to.equal(5000);
            expect(shown.adapterDefault).to.equal(10000);
            expect(shown.adapterVersion).to.equal('2.4.23');
            expect(shown.differs).to.equal(true);
            expect(shown.ack).to.equal(true);
            expect(shown.messages.map(m => m.key)).to.include('warnLimit_hint_differs');
            expect(
                shown.messages.every(m => m.severity !== 'error'),
                'a difference is no error',
            ).to.equal(true);
        });

        it('shows 10000 and any other number just as they are stored', async () => {
            for (const val of [10000, 15000, 7321]) {
                const { states, objects } = installation({ state: { val, ack: true } });
                const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
                await monitor.start();
                expect(view().current).to.equal(val);
                expect(view().differs).to.equal(val !== 10000);
            }
        });

        it('builds the state id from the opened instance', async () => {
            const { id, states, objects } = installation({ instance: 1, state: { val: 12000, ack: true } });
            // A second instance with another value must not leak into the reading
            states[stateIdOf(0)] = { val: 5000, ack: true };
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket, 1);
            await monitor.start();

            expect(id).to.equal('system.adapter.digitalstrom.1.objectsWarnLimit');
            expect(view().stateId).to.equal(id);
            expect(view().current).to.equal(12000);
            const touched = socket.calls
                .filter(c => ['getState', 'subscribeState'].includes(c.method))
                .map(c => c.args[0]);
            expect(touched).to.have.members([id, id]);
        });

        it('follows a change of the state without a draft - so the dialog does not count as changed', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, snapshots, view } = createMonitor(socket);
            await monitor.start();
            const before = snapshots.length;

            socket.external(id, { val: 20000, ack: false, from: 'system.adapter.admin.0' });

            expect(snapshots.length).to.be.above(before);
            expect(view().current).to.equal(20000);
            expect(view().ack).to.equal(false);
            expect(view().messages.map(m => m.key)).to.include('warnLimit_hint_pending');
            expect(lib.evaluateDraft(null, monitor.snapshot).dirty, 'a reading is no change').to.equal(false);
            expect(socket.writes).to.have.length(0);
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

            expect(socket.writes).to.have.length(0);
            expect(socket.methods().every(m => READS.includes(m))).to.equal(true);
            expect(socket.violations, 'refused calls, even if a caller caught them').to.deep.equal([]);
            expect(socket.methods()).to.not.include('setState');
        });

        it('needs no running instance - it never asks the adapter', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            states['system.adapter.digitalstrom.0.alive'] = { val: false, ack: true };
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(guarded(socket, READS));
            await monitor.start();

            expect(view().current).to.equal(5000);
            expect(socket.methods()).to.not.include('sendTo');
            expect(socket.violations).to.deep.equal([]);
            expect(socket.calls.map(c => c.args[0])).to.not.include('system.adapter.digitalstrom.0.alive');
        });
    });

    describe('what cannot be read as a limit', () => {
        it('a missing state: the next start creates it from the default', async () => {
            const { states, objects } = installation({});
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view()).to.include({ status: 'noValue', current: null, editable: true });
            expect(view().messages.map(m => m.key)).to.deep.equal(['warnLimit_status_noState']);
        });

        it('a state without value: the controller fallback is named as such, not as the instance value', async () => {
            const { states, objects } = installation({ state: { val: null, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const shown = view();
            expect(shown.current).to.equal(null);
            expect(shown.messages[0]).to.deep.include({ key: 'warnLimit_status_empty', params: { fallback: 5000 } });
        });

        it('does not name a fallback number for a controller that was not checked', async () => {
            const { states, objects } = installation({ state: { val: null, ack: true }, controller: '8.0.0' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view().messages[0].key).to.equal('warnLimit_status_emptyUnknownFallback');
        });

        it('a numeric string is invalid, and unacknowledged it will be replaced by 5000', async () => {
            const { states, objects } = installation({ state: { val: '10000', ack: false } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const shown = view();
            expect(shown.status).to.equal('invalid');
            expect(shown.current, 'never presented as a confirmed 10000').to.equal(null);
            expect(shown.effective, 'what the controller applies, named as its replacement').to.equal(5000);
            expect(shown.ack, 'kept for the view model').to.equal(false);
            // one message with cause, consequence and fix - not two that say almost the same
            expect(shown.messages.map(m => m.key)).to.deep.equal(['warnLimit_status_invalidPending']);
            expect(shown.messages[0].params.raw).to.equal('"10000"');

            const acknowledged = installation({ state: { val: '10000', ack: true } });
            const second = createMonitor(new FakeAdminSocket(acknowledged));
            await second.monitor.start();
            expect(second.view().messages.map(m => m.key)).to.deep.equal(['warnLimit_status_invalid']);
        });

        it('0 and negative numbers are shown but explained - they do not switch the warning off', async () => {
            for (const val of [0, -1]) {
                const { states, objects } = installation({ state: { val, ack: true } });
                const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
                await monitor.start();
                expect(view()).to.include({ status: 'unusual', current: val });
                expect(view().messages.map(m => m.key)).to.include('warnLimit_hint_notPositive');
            }
        });

        it('a refused read says so instead of showing a number', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects, denied: [id] }));
            await monitor.start();
            expect(view()).to.include({ status: 'noAccess', current: null, editable: false });
            expect(view().messages[0].key).to.equal('warnLimit_error_permission');
        });

        it('a controller older than 7.1.0 has no limit per instance', async () => {
            const { states, objects } = installation({ object: false, controller: '7.0.7' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view()).to.include({ status: 'unsupported', editable: false });
            expect(view().messages[0]).to.deep.include({
                key: 'warnLimit_status_unsupported',
                params: { version: '7.0.7', min: '7.1.0' },
            });
        });

        it('a current controller without the state has just not started the instance since', async () => {
            const { states, objects } = installation({ object: false });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view()).to.include({ status: 'noObject', editable: false });
            expect(view().messages[0].key).to.equal('warnLimit_status_noObject');
        });

        it('an unreadable controller version is said, not guessed', async () => {
            const { states, objects } = installation({ object: false });
            const socket = new FakeAdminSocket({ states, objects, denied: ['system.host.iobroker'] });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            expect(view().messages[0].key).to.equal('warnLimit_status_noObjectUnknownController');
        });

        it('an adapter object without a default leaves the default undetermined', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true }, adapterDefault: null });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view()).to.include({ adapterDefault: null, adapterDefaultStatus: 'missing', differs: false });
        });

        it('points out that 7.1.0 and 7.1.1 ignore the default of io-package.json', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true }, controller: '7.1.1' });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view().messages.map(m => m.key)).to.include('warnLimit_hint_defaultIgnored');
        });

        it('says "loading" before the first answer', () => {
            const { monitor, view } = createMonitor(new FakeAdminSocket());
            expect(view()).to.include({ status: 'loading', current: null });
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
            expect(view().ack).to.equal(true);
            monitor.dispose();
        });

        it('says "disconnected" when the connection goes before the first answer', () => {
            const { monitor, view } = createMonitor(new FakeAdminSocket());
            monitor.setConnected(false);
            expect(view()).to.include({ status: 'disconnected', editable: false });
            expect(view().messages[0].key).to.equal('warnLimit_error_connection');
            monitor.dispose();
        });

        it('an unacknowledged empty state is filled with 5000 at the next start - the text says so', async () => {
            const { states, objects } = installation({ state: { val: null, ack: false } });
            const { monitor, view } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            expect(view().messages[0].key).to.equal('warnLimit_status_emptyPending');
            expect(view().effective).to.equal(5000);
        });

        it('a refused object read keeps a readable value visible but locks the field', async () => {
            const { id, states, objects } = installation({ state: { val: 10000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const getObject = socket.getObject.bind(socket);
            socket.getObject = oid => (oid === id ? Promise.reject('permissionError') : getObject(oid));
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            expect(view()).to.include({ current: 10000, editable: false });
            expect(view().messages.map(m => m.key)).to.include('warnLimit_error_objectPermission');
        });

        it('a state that cannot be read cannot be overwritten from the card', async () => {
            const { states, objects } = installation({ state: { val: 10000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            socket.getState = () => Promise.reject('permissionError');
            socket.subscribeState = async () => {};
            const { monitor, view } = createMonitor(socket);
            await monitor.start();
            expect(view()).to.include({ status: 'noAccess', editable: false });
        });

        it('claims nothing for 7.0.8 nightlies, and names no replacement number from 7.3.0 on', async () => {
            const nightly = installation({ object: false, controller: '7.0.8' });
            const first = createMonitor(new FakeAdminSocket(nightly));
            await first.monitor.start();
            expect(first.view().status).to.equal('noObject');
            expect(first.view().messages[0].key).to.equal('warnLimit_status_noObjectUnknownController');

            const newer = installation({ state: { val: null, ack: true }, controller: '7.3.0' });
            const second = createMonitor(new FakeAdminSocket(newer));
            await second.monitor.start();
            expect(second.view().messages[0].key).to.equal('warnLimit_status_emptyUnknownFallback');
            expect(second.view().effective).to.equal(null);
        });

        it('an empty text is explained like an empty state, other types are named', async () => {
            const blank = installation({ state: { val: '', ack: false } });
            const first = createMonitor(new FakeAdminSocket(blank));
            await first.monitor.start();
            expect(first.view().messages[0].key).to.equal('warnLimit_status_emptyPending');

            const flag = installation({ state: { val: true, ack: true } });
            const second = createMonitor(new FakeAdminSocket(flag));
            await second.monitor.start();
            expect(second.view().messages[0].params.type).to.equal('warnLimit_type_other');
        });

        it('a timeout means "outcome unknown", not "not saved"', () => {
            expect(lib.classifyError(new Error('timeout'), true)).to.include({ kind: 'connection', timedOut: true });
            expect(lib.classifyError('timeout', true)).to.include({ timedOut: true });
            expect(lib.classifyError(new Error('notConnectedError'), false)).to.include({ timedOut: false });
        });

        it('closing the dialog drops the timers of requests that never answer', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            socket.holdReads = true;
            const { monitor } = createMonitor(socket);
            void monitor.refresh();
            await waitFor(() => monitor.timers.size === 3);
            monitor.dispose();
            expect(monitor.timers.size).to.equal(0);
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
            expect(result.outcome).to.equal('nothing');
            expect(calls).to.deep.equal(['finish']);
            expect(socket.violations).to.deep.equal([]);
        });
    });

    describe('connection and timing', () => {
        it('marks the reading as possibly outdated while the connection is gone, and reads again after it', async () => {
            const { id, states, objects } = installation({ state: { val: 5000, ack: true } });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor, view } = createMonitor(socket);
            await monitor.start();

            socket.disconnect();
            expect(view().stale).to.equal(true);
            expect(view().editable).to.equal(false);
            expect(view().messages[0].key).to.equal('warnLimit_hint_stale');
            // changed meanwhile - no event reaches a closed connection
            socket.external(id, { val: 9000, ack: true });
            expect(view().current).to.equal(5000);

            socket.reconnect();
            await waitFor(() => monitor.snapshot.loaded && !monitor.snapshot.loading && view().current === 9000);
            expect(view().stale).to.equal(false);
            expect(
                socket.methods().filter(m => m === 'subscribeState'),
                'socket-client renews it itself',
            ).to.have.length(1);
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

            expect(view().current).to.equal(8000);
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
            expect(second.view().current).to.equal(11000);
            expect(view().current).to.equal(5000);
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
            expect(monitor.snapshot.loading).to.equal(false);

            socket.holdReads = false;
            socket.reconnect();
            await waitFor(() => monitor.snapshot.loaded && !monitor.snapshot.loading);
            expect(lib.describeWarnLimit(monitor.snapshot).current).to.equal(5000);
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
            expect(lib.describeWarnLimit(monitor.snapshot)).to.include({ status: 'disconnected' });
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

            expect(snapshots.length).to.equal(count);
            expect(socket.subscriptions.has(id)).to.equal(false);
            expect(socket.connectionHandlers).to.have.length(0);
        });
    });

    describe('changing the limit', () => {
        it('a typed value is a change only when it differs from what is stored', async () => {
            const { states, objects } = installation({ state: { val: 5000, ack: true } });
            const { monitor } = createMonitor(new FakeAdminSocket({ states, objects }));
            await monitor.start();
            const snap = monitor.snapshot;

            expect(lib.evaluateDraft(null, snap)).to.include({ dirty: false });
            expect(lib.evaluateDraft('5000', snap)).to.include({ dirty: false });
            expect(lib.evaluateDraft('10000', snap)).to.deep.equal({ dirty: true, valid: true, value: 10000 });
            expect(lib.evaluateDraft('10.000', snap)).to.deep.equal({ dirty: true, valid: false, value: null });
            expect(lib.evaluateDraft('', snap)).to.include({ dirty: true, valid: false });
        });

        it('an emptied field is no change when nothing usable was stored', () => {
            const { id } = installation({});
            const snapshot = {
                ...lib.initialSnapshot(id),
                loaded: true,
                state: { status: 'ok', value: { val: '10000' } },
            };
            expect(lib.evaluateDraft('', snapshot)).to.include({ dirty: false });
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

            expect(result.outcome).to.equal('limit');
            expect(calls, 'writing the instance object would restart the instance').to.deep.equal(['finish']);
            expect(socket.writes).to.deep.equal([{ id, state: { val: 10000, ack: false } }]);
            expect(typeof socket.states[id].val, 'js-controller only takes a number').to.equal('number');
            expect(view().current).to.equal(10000);
            expect(view().ack).to.equal(false);
            expect(view().messages.map(m => m.key)).to.include('warnLimit_hint_pending');
            expect(lib.evaluateDraft('10000', monitor.snapshot).dirty, 'the draft is saved now').to.equal(false);
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

            expect(result.outcome).to.equal('both');
            expect(order).to.deep.equal(['state', 'settings']);
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
                expect(result.outcome).to.equal('settings');
            }
            expect(calls).to.deep.equal(['settings', 'settings']);
            expect(socket.writes).to.have.length(0);
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

            expect(result.outcome).to.equal('failed');
            expect(lib.classifyError(result.error, true).kind).to.equal('permission');
            expect(calls).to.have.length(0);
            expect(socket.states[id].val).to.equal(5000);
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
            expect(result.outcome).to.equal('invalid');
            expect(socket.writes).to.have.length(0);
        });

        it('never creates the state without its object, and never writes anything but a whole number', async () => {
            const { id, states, objects } = installation({ object: false });
            const socket = new FakeAdminSocket({ states, objects });
            const { monitor } = createMonitor(socket);
            await monitor.start();
            await expect(monitor.save(10000)).to.be.rejectedWith('does not exist');

            objects[id] = { type: 'state', common: { type: 'number' } };
            socket.objects[id] = objects[id];
            await monitor.refresh();
            await expect(monitor.save(/** @type {any} */ ('10000'))).to.be.rejectedWith('not a valid limit');
            await expect(monitor.save(0)).to.be.rejectedWith('not a valid limit');
            expect(socket.writes).to.have.length(0);
        });

        it('does not take the encrypted token GenericApp remembers after a save for a changed setting', () => {
            const secret = 'Zgfr56gFe87jJOM';
            const xor = value =>
                [...value]
                    .map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0)))
                    .join('');
            const native = { host: '10.0.0.2', appToken: 'abcdef', smartHomeApiKey: '' };
            const savedNative = { host: '10.0.0.2', appToken: xor('abcdef'), smartHomeApiKey: '' };

            expect(JSON.stringify(native) !== JSON.stringify(savedNative), 'what GenericApp compares').to.equal(true);
            expect(lib.isNativeChanged(native, savedNative, ['appToken', 'smartHomeApiKey'], xor)).to.equal(false);
            expect(lib.isNativeChanged({ ...native, host: '10.0.0.3' }, savedNative, ['appToken'], xor)).to.equal(true);
            expect(lib.isNativeChanged({ ...native, appToken: 'other' }, savedNative, ['appToken'], xor)).to.equal(
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
            const html = renderToStaticMarkup(
                React.createElement(Settings, {
                    native: { dataPollInterval: 100 },
                    onChange: (...args) => changes.push(args),
                    onSendTo: async () => ({}),
                    alive: false,
                    t: key => words[key] || key,
                    initialTab: tab,
                    lang,
                    warnLimit: { snapshot: monitor.snapshot, draft, draftBase: 5000, saveError: '' },
                }),
            );
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

            expect(text).to.contain('Objekt-Warngrenze');
            expect(text).to.contain('Aktuell eingestellte Warngrenze 5.000 Objekte');
            expect(text).to.contain('Adapter-Standard 10.000 Objekte');
            expect(text).to.contain('Quelle Instanz-Datenpunkt');
            expect(text).to.contain('system.adapter.digitalstrom.0.objectsWarnLimit');
            expect(text).to.contain('Die eingestellte Warngrenze weicht vom Adapter-Standard ab.');
            expect(text).to.contain('Neu einlesen');
            expect(text).to.contain('Datenpunkt kopieren');
            expect(html, 'a difference is no error').to.not.contain('MuiAlert-standardError');
            expect(changes, 'showing the card changes no setting').to.have.length(0);
            expect(socket.writes).to.have.length(0);
        });

        it('formats the numbers for the language', async () => {
            const { text } = await render({ install: { state: { val: 15000, ack: true } }, lang: 'en' });
            expect(text).to.contain('Currently configured warning limit 15,000 objects');
            expect(text).to.contain('Adapter default 10,000 objects');
        });

        it('shows 10000 without a difference hint', async () => {
            const { text } = await render({ install: { state: { val: 10000, ack: true } } });
            expect(text).to.contain('Aktuell eingestellte Warngrenze 10.000 Objekte');
            expect(text).to.not.contain('weicht vom Adapter-Standard ab');
        });

        it('names the state of instance 1 for instance 1', async () => {
            const { text } = await render({ instance: 1, install: { state: { val: 8000, ack: true } } });
            expect(text).to.contain('system.adapter.digitalstrom.1.objectsWarnLimit');
            expect(text).to.not.contain('system.adapter.digitalstrom.0.objectsWarnLimit');
        });

        it('says in plain words what an invalid entry means and how to fix it', async () => {
            const { text, html } = await render({ install: { state: { val: '10000', ack: false } } });
            expect(text).to.contain('Aktuell eingestellte Warngrenze Kein gültiger Wert');
            expect(text).to.contain('Beim Start gilt: 5.000 Objekte – Ersatzwert des js-controllers');
            expect(text).to.contain('Quelle Ersatzwert des js-controllers – im Datenpunkt steht keine gültige Zahl');
            // "10000" looks like a number - the text has to say that it is stored as text
            expect(text).to.contain('Im Datenpunkt steht "10000" – aber als Text, nicht als Zahl.');
            expect(text).to.contain('seinen Ersatzwert von 5.000 Objekten');
            expect(text).to.contain('So behebst du es:');
            expect(html, 'the fix is set in bold').to.contain('<strong>So behebst du es:</strong>');
            expect(text, 'a status chip would repeat the message').to.not.contain('gilt ab dem nächsten Start');
            expect((html.match(/MuiAlert-standardWarning/g) || []).length, 'one warning, not two').to.equal(1);
        });

        it('marks a saved but not yet applied value as such', async () => {
            const { text } = await render({ install: { state: { val: 12000, ack: false } } });
            expect(text).to.contain('Aktuell eingestellte Warngrenze 12.000 Objekte gilt ab dem nächsten Start');
            expect(text).to.contain('bis dahin ändert sich nichts');
        });

        it('explains a controller without the feature and locks the field', async () => {
            const { text, html } = await render({ install: { object: false, controller: '7.0.7' } });
            expect(text).to.contain('Aktuell eingestellte Warngrenze Nicht unterstützt');
            expect(text).to.contain('js-controller 7.0.7');
            expect(text).to.contain('Nicht änderbar');
            expect(html).to.match(/<input[^>]*disabled/);
        });

        it('answers what one wants to know before changing it', async () => {
            const { text } = await render({ install: { state: { val: 5000, ack: true } } });
            expect(text).to.contain('Vor dem Ändern');
            expect(text).to.contain('Muss ich die Grenze ändern?');
            expect(text).to.contain('6.000 Objekte bei einer Grenze von 5.000');
            expect(text).to.contain('Alle Objekte werden trotzdem angelegt und arbeiten normal');
            expect(text).to.contain('Wird digitalSTROM oder ioBroker dadurch langsamer oder schneller?');
            expect(text).to.contain('Der Adapter selbst liest die Grenze nicht');
            expect(text).to.contain('Eine andere Grenze legt kein Objekt an und entfernt keines.');
            expect(text).to.contain('Welcher Wert ist sinnvoll?');
            expect(text).to.contain('Betrifft das andere Instanzen oder Adapter?');
        });

        it('explains the limit, the start-only check and where else it can be changed', async () => {
            const { text } = await render({ install: { state: { val: 5000, ack: true } } });
            expect(text).to.contain('Sie begrenzt weder die Anzahl der angelegten Objekte noch deren Anzeige');
            expect(text).to.contain('Eine höhere Grenze reduziert nicht den Speicherverbrauch');
            expect(text).to.contain('nur beim Start der Instanz');
            expect(text).to.contain('Expertenmodus');
            expect(text).to.contain('nicht common.def');
            expect(text).to.contain('z. B. 10000');
        });

        it('tells a typed value from a saved one and refuses separators', async () => {
            const pending = await render({ install: { state: { val: 5000, ack: true } }, draft: '12000' });
            expect(pending.text).to.contain('Noch nicht gespeichert – klicke unten auf „Speichern“.');
            const invalid = await render({ install: { state: { val: 5000, ack: true } }, draft: '12.000' });
            expect(invalid.text).to.contain('Nur Ziffern');
        });

        it('stays out of the other tabs', async () => {
            for (const tab of [0, 1, 3]) {
                const { text } = await render({ install: { state: { val: 5000, ack: true } }, tab });
                expect(text, `tab ${tab}`).to.not.contain('Objekt-Warngrenze');
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
            expect(app.state.changed).to.equal(true);
            expect(posted).to.include('change');

            await app.onSave(false);
            expect(socket.writes).to.deep.equal([{ id, state: { val: 10000, ack: false } }]);
            expect(socket.methods(), 'an object write restarts the instance').to.not.include('setObject');
            expect(app.state.changed).to.equal(false);
            expect(app.state.warnLimit.draft).to.equal(null);
            app.componentWillUnmount();
        });

        it('after a save that kept the dialog open, a reverted draft leaves nothing to save', async () => {
            const { app, socket } = await openDialog();
            app.updateNativeValue('host', '10.0.0.3');
            app.onSave(false);
            await waitFor(() => socket.methods().includes('setObject') && !app.state.changed);
            expect(JSON.stringify(app.state.native), 'GenericApp keeps the token encrypted now').to.not.equal(
                JSON.stringify(app.savedNative),
            );

            app.onWarnLimitDraft('12000');
            expect(app.state.changed).to.equal(true);
            app.onWarnLimitDraft(null);
            expect(app.state.changed, 'the review found this stuck on true').to.equal(false);

            await app.onSave(false);
            expect(socket.methods().filter(m => m === 'setObject')).to.have.length(1);
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
            expect(posted).to.include('close');
            expect(socket.methods()).to.not.include('setObject');
            app.componentWillUnmount();
        });

        it('clears its own configuration error whatever language it was raised in', async () => {
            const { app } = await openDialog();
            app.onWarnLimitDraft('10.000');
            expect(app.state.isConfigurationError).to.not.equal('');
            app.setState({ isConfigurationError: 'Object warning limit: please enter a whole number of at least 1.' });
            app.onWarnLimitDraft('12000');
            expect(app.state.isConfigurationError).to.equal('');
            app.componentWillUnmount();
        });

        it('closing after "discard" inside the page does not make admin ask a second time', async () => {
            const { app } = await openDialog();
            app.onWarnLimitDraft('12000');
            posted.length = 0;
            // what GenericApp's own confirmation calls after "discard"
            Object.getPrototypeOf(App).onClose();
            expect(posted).to.deep.equal(['nochange', 'close']);
            app.componentWillUnmount();
        });

        it('readings never mark the dialog as changed', async () => {
            const { app, socket, id } = await openDialog();
            socket.external(id, { val: 7000, ack: false });
            await app.warnLimitMonitor.refresh();
            expect(app.state.changed).to.equal(false);
            expect(posted).to.not.include('change');
            expect(socket.writes).to.have.length(0);
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
            expect(keys.size).to.be.at.least(30);
            for (const lang of languages) {
                const words = JSON.parse(require('fs').readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
                for (const key of keys) {
                    expect(words, `${lang}.json lacks ${key}`).to.have.property(key);
                }
            }
        });

        it('the save path asks only for texts that exist', () => {
            const app = require('fs').readFileSync(path.join(__dirname, '..', 'src-admin', 'src', 'App.jsx'), 'utf8');
            const used = [...app.matchAll(/I18n\.t\('([a-zA-Z0-9_]+)'\)/g)].map(match => match[1]);
            expect(used).to.include.members([
                'warnLimit_configError',
                'warnLimit_save_permission',
                'warnLimit_save_connection',
                'warnLimit_save_failed',
            ]);
            for (const lang of languages) {
                const words = JSON.parse(require('fs').readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
                used.forEach(key => expect(words, `${lang}.json lacks ${key}`).to.have.property(key));
            }
        });
    });

    describe('versions', () => {
        it('compares like semver and ignores a prerelease', () => {
            expect(lib.compareVersions('7.1.0', '7.1.0')).to.equal(0);
            expect(lib.compareVersions('7.0.7', '7.1.0')).to.be.below(0);
            expect(lib.compareVersions('7.2.3-alpha.18', '7.1.2')).to.be.above(0);
            expect(lib.compareVersions('garbage', '7.1.0')).to.equal(null);
        });
    });
});
