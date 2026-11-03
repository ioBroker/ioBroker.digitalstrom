const { expect } = require('chai');
const proxyquire = require('proxyquire');
const ObjectHelper = require('@apollon/iobroker-tools');

const { Digitalstrom } = proxyquire('../main', {
    '@iobroker/adapter-core': {
        Adapter: class FakeAdapter {
            on() {}
        },
        '@noCallThru': true,
    },
});

const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal adapter double that records which namespace an object write ended up on.
 *
 * @param {string} namespace
 * @param {string[]} sink
 * @returns {Record<string, any>} fake adapter, open for tests that swap single methods
 */
function fakeAdapter(namespace, sink) {
    return {
        namespace,
        log: silentLog,
        getObject: (id, cb) => cb(null, null),
        setObject: (id, obj, cb) => {
            sink.push(`${namespace}/${id}`);
            cb && cb();
        },
        extendObject: (id, obj, cb) => {
            sink.push(`${namespace}/ext/${id}`);
            cb && cb();
        },
        setState: (id, value, ack, cb) => {
            sink.push(`${namespace}/state/${id}`);
            cb && cb();
        },
        getAdapterObjects: cb => cb({}),
    };
}

const stateObject = { type: 'state', common: { type: 'boolean', role: 'switch' } };

describe('objectHelper instance isolation', () => {
    it('the shared helper of the dependency really is a singleton', () => {
        // Documents why the private copy is needed - if this ever changes, revisit
        expect(ObjectHelper.objectHelper).to.equal(ObjectHelper.objectHelper);
        expect(ObjectHelper.objectHelper.init).to.be.a('function');
    });

    it('createObjectHelper returns a separate helper per call', () => {
        const first = Digitalstrom.createObjectHelper(silentLog);
        const second = Digitalstrom.createObjectHelper(silentLog);
        expect(first).to.not.equal(second);
        expect(first).to.not.equal(ObjectHelper.objectHelper);
        expect(first.setOrUpdateObject).to.be.a('function');
    });

    it('does not disturb the module cache of other consumers', () => {
        const before = require('@apollon/iobroker-tools').objectHelper;
        Digitalstrom.createObjectHelper(silentLog);
        expect(require('@apollon/iobroker-tools').objectHelper).to.equal(before);
    });

    it('writes of instance 0 stay on instance 0 after instance 1 was initialized', done => {
        const writes0 = [];
        const writes1 = [];
        const helper0 = Digitalstrom.createObjectHelper(silentLog);
        const helper1 = Digitalstrom.createObjectHelper(silentLog);

        helper0.init(fakeAdapter('digitalstrom.0', writes0));
        // instance 1 starts afterwards - with the shared singleton it would take over
        helper1.init(fakeAdapter('digitalstrom.1', writes1));

        helper0.setOrUpdateObject('devices.a.state', stateObject, ['name'], true);
        helper0.processObjectQueue(() => {
            expect(writes0, 'the write must stay on its own instance').to.include('digitalstrom.0/devices.a.state');
            expect(writes1, 'nothing may end up on the other instance').to.deep.equal([]);
            done();
        });
    });

    it('keeps the known objects of the instances apart', done => {
        const helper0 = Digitalstrom.createObjectHelper(silentLog);
        const helper1 = Digitalstrom.createObjectHelper(silentLog);
        const adapter0 = fakeAdapter('digitalstrom.0', []);
        const adapter1 = fakeAdapter('digitalstrom.1', []);
        // clearAdditionalObjects() deletes everything listed in existingStates - with a
        // shared helper instance 0 would see the objects of instance 1 here
        adapter0.getAdapterObjects = cb => cb({ 'digitalstrom.0.devices.own': {} });
        adapter1.getAdapterObjects = cb => cb({ 'digitalstrom.1.devices.other': {} });

        helper0.init(adapter0);
        helper1.init(adapter1);
        helper0.loadExistingObjects(() => {
            helper1.loadExistingObjects(() => {
                expect(Object.keys(helper0.existingStates)).to.deep.equal(['devices.own']);
                expect(Object.keys(helper1.existingStates)).to.deep.equal(['devices.other']);
                done();
            });
        });
    });

    it('falls back to the shared helper with a warning when the private copy fails', () => {
        const warnings = [];
        // Every require.resolve goes through Module._resolveFilename, so this also affects
        // the call inside main.js. Simulates a future version that hides the subpath.
        // _resolveFilename is an internal node API without public typings
        const Module = /** @type {any} */ (require('node:module'));
        const originalResolveFilename = Module._resolveFilename;
        Module._resolveFilename = function (request, ...rest) {
            if (request === '@apollon/iobroker-tools/lib/objectHelper') {
                /** @type {import('../lib/configUtils').AdapterError} */
                const err = new Error(`Package subpath not exported: ${request}`);
                err.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
                throw err;
            }
            return originalResolveFilename.call(this, request, ...rest);
        };
        try {
            const helper = Digitalstrom.createObjectHelper({ warn: msg => warnings.push(String(msg)) });
            expect(helper, 'the adapter must still work').to.equal(ObjectHelper.objectHelper);
            expect(warnings).to.have.lengthOf(1);
            expect(warnings[0]).to.contain('compact');
        } finally {
            Module._resolveFilename = originalResolveFilename;
        }
    });
});

// The two properties of the dependency the unknown handling relies on - if either one
// changes, revisit Digitalstrom.onStateChange() and setInitialValues()
describe('objectHelper and a state without value', () => {
    const id = 'apartment.0.4.states.heating';
    const heating = () => ({
        type: 'state',
        common: { type: 'boolean', role: 'indicator' },
        native: { valueTrue: 'active', valueFalse: 'inactive' },
    });

    it('does not write a null initial value - setInitialValues has to', done => {
        const writes = [];
        const helper = Digitalstrom.createObjectHelper(silentLog);
        helper.init(fakeAdapter('digitalstrom.0', writes));
        helper.setOrUpdateObject(id, heating(), ['name'], null, () => {});
        helper.processObjectQueue(() => {
            expect(writes).to.deep.equal([`digitalstrom.0/${id}`]);
            done();
        });
    });

    it('turns a null command into false for a boolean state, so onStateChange stops it first', done => {
        const received = [];
        const helper = Digitalstrom.createObjectHelper(silentLog);
        helper.init(fakeAdapter('digitalstrom.0', []));
        helper.setOrUpdateObject(id, heating(), ['name'], null, value => received.push(value));
        helper.processObjectQueue(() => {
            helper.handleStateChange(`digitalstrom.0.${id}`, { val: null, ack: false });
            expect(received, 'what the helper alone does').to.deep.equal([false]);

            received.length = 0;
            const ctx = {
                log: silentLog,
                objectHelper: helper,
                isStopping: () => false,
                dssStruct: { notePublishedValue: () => {} },
            };
            Digitalstrom.prototype.onStateChange.call(ctx, `digitalstrom.0.${id}`, { val: null, ack: false });
            expect(received, 'nothing may reach the write handler').to.deep.equal([]);
            Digitalstrom.prototype.onStateChange.call(ctx, `digitalstrom.0.${id}`, { val: true, ack: false });
            expect(received).to.deep.equal([true]);
            done();
        });
    });
});

// The update path of an existing installation: registerObjects now hands every state an
// explicit common.write, and the objects that were stored without one have to get it.
describe('common.write of an existing installation', () => {
    const ID = 'devices.m1.hue1.hue';
    const definition = write => ({
        type: 'state',
        common: { name: 'Colored Light Hue', type: 'number', role: 'level.color.hue', ...write },
        native: {},
    });

    /**
     * Runs one start of the helper against a stored object.
     *
     * @param {Record<string, any>} stored the object as js-controller has it
     * @param {Record<string, any>} obj the definition of this start
     * @param {(value: any) => void} [onChange] write handler
     * @returns {Promise<Array<Record<string, any>>>} the extendObject payloads
     */
    function start(stored, obj, onChange) {
        const extended = [];
        const adapter = fakeAdapter('digitalstrom.0', []);
        adapter.getAdapterObjects = cb => cb({ [`digitalstrom.0.${ID}`]: JSON.parse(JSON.stringify(stored)) });
        adapter.getObject = (id, cb) => cb(null, stored);
        adapter.extendObject = (id, payload, cb) => {
            extended.push(JSON.parse(JSON.stringify(payload)));
            cb && cb();
        };
        const helper = Digitalstrom.createObjectHelper(silentLog);
        helper.init(adapter);
        return new Promise(resolve =>
            helper.loadExistingObjects(() => {
                helper.setOrUpdateObject(ID, obj, ['name'], undefined, onChange);
                helper.processObjectQueue(() => resolve(extended));
            }),
        );
    }

    // js-controller stored "write: undefined" as no property at all
    const storedWithoutWrite = definition({ read: true });

    it('gives a state stored without the flag write: false on the next start', async () => {
        const extended = await start(storedWithoutWrite, definition({ write: false }));
        expect(extended).to.have.lengthOf(1);
        expect(extended[0].common.write).to.equal(false);
    });

    // js-controller adds these to every object it stores
    const asStored = obj => ({
        ...obj,
        _id: `digitalstrom.0.${ID}`,
        from: 'system.adapter.digitalstrom.0',
        user: 'system.user.admin',
        ts: 1,
        acl: { object: 1636, state: 1636, owner: 'system.user.admin', ownerGroup: 'system.group.administrator' },
    });

    // Without `user` on purpose: the helper strips from/ts/acl/_id but not user, so a real
    // stored object is extended again at every start anyway. This isolates the flag.
    it('the flag alone no longer makes the stored object differ', async () => {
        const stored = definition({ read: true, write: false });
        expect(await start(stored, definition({ write: false })), 'nothing to write').to.deep.equal([]);
    });

    // An object as a real installation stores it (5300 of 5301 carry "user") - whatever
    // the helper writes again, the flag must not flip back
    it('a real stored object may be extended again, but the flag stays false', async () => {
        const extended = await start(asStored(definition({ read: true, write: false })), definition({ write: false }));
        for (const payload of extended) {
            expect(payload.common.write).to.equal(false);
        }
    });

    // Why the flag must not be put into the definitions of the output channels: the
    // helper keeps an explicit value, so a handler attached later could not lift it
    it('keeps an explicit write: false even with a handler', async () => {
        const extended = await start(storedWithoutWrite, definition({ write: false }), () => {});
        expect(extended[0].common.write).to.equal(false);
    });
});

describe('objectHelper name handling', () => {
    // registerObjects() relies on this: ['name'] keeps the stored name of an existing
    // object, [] writes the name from the dSS. The helper is a dependency, so pin it here.
    function storedFolder(name) {
        return {
            _id: 'digitalstrom.0.devices.m1',
            type: 'folder',
            common: { name, read: true },
            native: {},
            from: 'system.adapter.digitalstrom.0',
            user: 'system.user.admin',
            ts: 1,
        };
    }

    function run(keep, done, check) {
        const payloads = [];
        const helper = Digitalstrom.createObjectHelper(silentLog);
        const adapter = fakeAdapter('digitalstrom.0', []);
        adapter.getAdapterObjects = cb => cb({ 'digitalstrom.0.devices.m1': storedFolder('Schlafen &amp; Bad') });
        adapter.getObject = (id, cb) => cb(null, storedFolder('Schlafen &amp; Bad'));
        adapter.extendObject = (id, obj, cb) => {
            payloads.push(obj);
            cb && cb();
        };
        helper.init(adapter);
        helper.loadExistingObjects(() => {
            helper.setOrUpdateObject('devices.m1', { type: 'folder', common: { name: 'Schlafen & Bad' } }, keep);
            helper.processObjectQueue(() => {
                check(payloads);
                done();
            });
        });
    }

    it("['name'] keeps the stored name of an existing object", done => {
        run(['name'], done, payloads => {
            expect(payloads).to.have.lengthOf(1);
            expect(payloads[0].common).to.not.have.property('name');
        });
    });

    it('[] writes the name', done => {
        run([], done, payloads => {
            expect(payloads).to.have.lengthOf(1);
            expect(payloads[0].common.name).to.equal('Schlafen & Bad');
        });
    });
});
