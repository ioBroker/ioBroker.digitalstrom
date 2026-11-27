const EventEmitter = require('node:events');
const assert = require('node:assert');
const { DSSStructure } = require('../build/lib/dssStructure');

const { DSSQueue } = require('../build/lib/dssQueue');
const dssConstants = require('../build/lib/constants');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createStructure(overrides) {
    return new DSSStructure(
        Object.assign(
            {
                dss: {},
                dssQueue: {},
                adapter: { log: silentLogger, config: {} },
            },
            overrides,
        ),
    );
}

describe('DSSStructure', () => {
    it('convertSceneName strips bracket suffixes and spaces', () => {
        const struct = createStructure();
        assert.strictEqual(struct.convertSceneName('Deep Off'), 'DeepOff');
        assert.strictEqual(struct.convertSceneName('Preset 2 (Standard)'), 'Preset2');
        assert.strictEqual(struct.convertSceneName(''), '');
    });

    it('convertObject maps arrays by the given name field', () => {
        const struct = createStructure();
        const res = struct.convertObject(
            [
                { id: 1, name: 'one' },
                { id: 2, name: 'two' },
            ],
            'id',
        );
        assert.ok('1' in res);
        assert.strictEqual(res[2].name, 'two');
    });

    it('convertObject tolerates invalid input', () => {
        const struct = createStructure();
        assert.deepStrictEqual(struct.convertObject(null, 'id'), {});
        assert.deepStrictEqual(struct.convertObject('nope', 'id'), {});
        assert.deepStrictEqual(struct.convertObject([{ noIdField: true }], 'id'), {});
    });

    it('clearTimeouts cancels pending timeouts', done => {
        const struct = createStructure();
        let fired = false;
        struct.setClearableTimeout(() => {
            fired = true;
        }, 5);
        struct.clearTimeouts();
        assert.strictEqual(struct.pendingTimeouts.size, 0);
        setTimeout(() => {
            assert.strictEqual(fired, false);
            done();
        }, 15);
    });

    it('updateMeterData reports failed and total request counts', done => {
        const struct = createStructure({
            dssQueue: {
                pushQueryQueue: (circuit, entryId, entry, prio, callback) => {
                    // getConsumption succeeds, getEnergyMeterValue fails
                    if (entryId === 'getConsumption') {
                        setImmediate(() => callback(null, { ok: true, result: { consumption: 42 } }));
                    } else {
                        setImmediate(() => callback(new Error('unreachable')));
                    }
                },
            },
            adapter: {
                log: silentLogger,
                config: {},
                setState: () => {},
            },
        });
        struct.apartmentCircuits = [
            { hasMetering: true, dSUID: 'meter1' },
            { hasMetering: false, dSUID: 'meter2' },
        ];
        struct.updateMeterData((failed, total) => {
            assert.strictEqual(total, 2);
            assert.strictEqual(failed, 1);
            done();
        });
    });
    // Regression from a real installation: at 23:13 the DSS answered with temperature,
    // humidity and the two sun angles, but without brightness - the outdoor brightness
    // sensor stops sending in the dark. The state vanished on that restart.
    describe('outdoor sensors', () => {
        function createWithOutdoor(outdoor, existingStates) {
            const struct = createStructure({
                adapter: { log: silentLogger, config: {}, objectHelper: { existingStates: existingStates || {} } },
            });
            struct.sensorValues = outdoor === null ? {} : { outdoor };
            struct.createOutdoorSensors();
            return struct;
        }

        it('keeps a known state when the DSS reports no value for it', () => {
            const struct = createWithOutdoor(
                { temperature: { value: 13.275, time: '2026-09-17T21:00:30.962Z' } },
                { 'apartment.sensors.outdoor.brightness': { common: {} } },
            );
            assert.ok('apartment.sensors.outdoor.brightness' in struct.dssObjects, 'the known sensor keeps its object');
            assert.strictEqual(
                struct.initialObjectValues['apartment.sensors.outdoor.brightness'],
                undefined,
                'and no value is written over the old one',
            );
            assert.strictEqual(struct.initialObjectValues['apartment.sensors.outdoor.temperature'].val, 13.275);
        });

        it('creates nothing for a sensor ioBroker does not know either', () => {
            const struct = createWithOutdoor({ temperature: { value: 13.275, time: 0 } }, {});
            assert.ok(!('apartment.sensors.outdoor.brightness' in struct.dssObjects));
            assert.ok('apartment.sensors.outdoor.temperature' in struct.dssObjects);
        });

        it('keeps a known state even when the answer carries no outdoor block at all', () => {
            const struct = createWithOutdoor(null, { 'apartment.sensors.outdoor.brightness': { common: {} } });
            assert.ok('apartment.sensors.outdoor' in struct.dssObjects);
            assert.ok('apartment.sensors.outdoor.brightness' in struct.dssObjects);
        });

        it('still reports a sensor name the adapter does not know', () => {
            const warnings = [];
            const struct = createStructure({
                adapter: {
                    log: { ...silentLogger, warn: msg => warnings.push(msg) },
                    config: {},
                    objectHelper: { existingStates: {} },
                },
            });
            struct.sensorValues = { outdoor: { nonsense: { value: 1, time: 0 } } };
            struct.createOutdoorSensors();
            assert.ok(warnings.join(' ').includes('nonsense'));
        });
    });

    // The DSS answers this state with "hot water", not with active/inactive. As a boolean
    // every word but "inactive" collapsed to true and the operating mode was lost.
    describe('apartment state heating_water_system', () => {
        it('carries the wording of the DSS instead of a flag', () => {
            const map = dssConstants.apartmentStateRoleMap.heating_water_system;
            assert.strictEqual(map.type, 'string');
            assert.strictEqual(map.native, undefined, 'no flag mapping that could not match');
        });

        it('passes the DSS wording through as the initial value', () => {
            assert.strictEqual(
                DSSStructure.initialStateValue({ name: 'heating_water_system', value: 1, state: 'hot water' }),
                'hot water',
            );
        });
    });

    describe('setStateSafe', () => {
        function writingStructure(written) {
            return createStructure({
                adapter: {
                    log: silentLogger,
                    config: {},
                    setState: () => {},
                    setDssState: (id, v) => written.push([id, v]),
                },
            });
        }

        it('parks values as initial values while the objects do not exist yet', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = false;
            struct.setStateSafe('devices.m1.dev1.shadePositionOutside', 42);
            assert.deepStrictEqual(written, [], 'must not write to a not yet existing object');
            assert.strictEqual(struct.initialObjectValues['devices.m1.dev1.shadePositionOutside'], 42);
        });

        it('writes via the type conversion once the objects are created', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            struct.setStateSafe('devices.m1.dev1.shadePositionOutside', 42);
            assert.deepStrictEqual(written, [['devices.m1.dev1.shadePositionOutside', 42]]);
        });

        it('ignores undefined values', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            struct.setStateSafe('devices.m1.dev1.x', undefined);
            assert.deepStrictEqual(written, []);
            assert.ok(!('devices.m1.dev1.x' in struct.initialObjectValues));
        });

        it('repeats a value that a poll re-asserts only when it really moved', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            const id = 'devices.m1.dev1.shadePositionOutside';
            const poll = { skipUnchanged: true };

            struct.setStateSafe(id, 42, poll);
            // setDssState is what tells the structure what is in the state now
            struct.notePublishedValue(id, 42);
            struct.setStateSafe(id, 42, poll);
            struct.setStateSafe(id, 43, poll);

            assert.deepStrictEqual(
                written,
                [
                    [id, 42],
                    [id, 43],
                ],
                'the second poll of an unchanged value must not reach ioBroker',
            );
        });

        it('never suppresses a write that carries no skipUnchanged', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            const id = 'devices.m1.dev1.shadePositionOutside';

            struct.setStateSafe(id, 42);
            struct.notePublishedValue(id, 42);
            // An event and the acknowledgement of a user command both land here: the same
            // value again is a message of its own and has to be published
            struct.setStateSafe(id, 42);

            assert.deepStrictEqual(written, [
                [id, 42],
                [id, 42],
            ]);
        });

        it('writes again after someone else changed the state behind our back', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            const id = 'devices.m1.dev1.shadePositionOutside';
            const poll = { skipUnchanged: true };

            struct.setStateSafe(id, 42, poll);
            struct.notePublishedValue(id, 42);
            // onStateChange() reports the acknowledged write of another adapter
            struct.notePublishedValue(id, 7);
            struct.setStateSafe(id, 42, poll);

            assert.deepStrictEqual(
                written,
                [
                    [id, 42],
                    [id, 42],
                ],
                'the reconciliation has to be able to correct a foreign value',
            );
        });
    });

    describe('logOutputReadError', () => {
        function loggingStructure(entries) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        info: msg => entries.push(['info', String(msg)]),
                        debug: msg => entries.push(['debug', String(msg)]),
                        warn: msg => entries.push(['warn', String(msg)]),
                    }),
                    config: {},
                },
            });
        }
        const dev = { dSUID: 'dev1', name: 'Wohnen Rollladen' };

        it('reports a device that does not deliver a value exactly once', () => {
            const entries = [];
            const struct = loggingStructure(entries);
            const err = new Error('HTTP 500 for /json/device/getConfig');

            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);

            assert.deepStrictEqual(
                entries.map(e => e[0]),
                ['info', 'debug', 'debug'],
                'only the first one is visible',
            );
            assert.ok(entries[0][1].includes('Wohnen Rollladen'));
            assert.ok(entries[0][1].includes('shadeOpeningAngleOutside'));
            assert.ok(entries[0][1].includes('HTTP 500'));
            assert.strictEqual(
                entries.some(e => e[0] === 'warn'),
                false,
                'never a warning',
            );
        });

        it('keeps devices and channels apart', () => {
            const entries = [];
            const struct = loggingStructure(entries);
            const err = new Error('HTTP 500');
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadePositionOutside', err);
            struct.logOutputReadError({ dSUID: 'dev2' }, 'shadeOpeningAngleOutside', err);
            assert.deepStrictEqual(
                entries.map(e => e[0]),
                ['info', 'info', 'info'],
            );
        });

        it('falls back to the dSUID when the device has no name', () => {
            const entries = [];
            loggingStructure(entries).logOutputReadError({ dSUID: 'dev9' }, 'brightness', new Error('boom'));
            assert.ok(entries[0][1].includes('dev9'));
        });
    });

    describe('logQueueError', () => {
        function loggingStructure(levels) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        debug: () => levels.push('debug'),
                        warn: () => levels.push('warn'),
                    }),
                    config: {},
                },
            });
        }

        it('reports errors caused by the stop as debug', () => {
            const levels = [];
            /** @type {import('../lib/configUtils').AdapterError} */
            const err = new Error('Queue cleared');
            err.shutdown = true;
            loggingStructure(levels).logQueueError('Err getReachableScenes for zone 2 group 1', err);
            assert.deepStrictEqual(levels, ['debug']);
        });

        it('still warns about real errors', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Err getReachableScenes for zone 2 group 1', new Error('boom'));
            assert.deepStrictEqual(levels, ['warn']);
        });
    });

    describe('initialStateValue', () => {
        // Regression: five apartment states carried no value at all from the first start
        // onwards, because the property dump describes them with a raw value and no word.
        it('takes the word when the dSS sends one', () => {
            assert.strictEqual(
                DSSStructure.initialStateValue({ name: 'presence', state: 'present', value: 'present' }),
                'present',
            );
        });

        it('falls back to the raw value when there is no word', () => {
            assert.strictEqual(
                DSSStructure.initialStateValue({ name: 'daylight', value: true, script_id: 'solar_computer' }),
                true,
                'measured against a dSS20 1.19.13',
            );
            assert.strictEqual(DSSStructure.initialStateValue({ name: 'holiday', value: 'off' }), 'off');
        });

        it('stays undefined when the entry carries neither', () => {
            assert.strictEqual(DSSStructure.initialStateValue({ name: 'nothing' }), undefined);
            assert.strictEqual(DSSStructure.initialStateValue(null), undefined);
        });

        it('keeps a word that means false', () => {
            assert.strictEqual(DSSStructure.initialStateValue({ state: 'inactive', value: 2 }), 'inactive');
        });
    });

    describe('toBoolean', () => {
        it('maps the common DSS off words to false', () => {
            ['', '0', 'false', 'off', 'inactive', 'no', 'INACTIVE', ' Off '].forEach(v =>
                assert.strictEqual(DSSStructure.toBoolean(v), false, `${v} must be false`),
            );
        });

        it('maps the common DSS on words to true', () => {
            ['1', 'true', 'on', 'active', 'yes'].forEach(v =>
                assert.strictEqual(DSSStructure.toBoolean(v), true, `${v} must be true`),
            );
        });

        it('keeps non string values working', () => {
            assert.strictEqual(DSSStructure.toBoolean(0), false);
            assert.strictEqual(DSSStructure.toBoolean(1), true);
            assert.strictEqual(DSSStructure.toBoolean(null), false);
        });
    });

    describe('scene resolution', () => {
        it('resolves zone/room scenes that only exist in zoneSceneCommands', () => {
            const struct = createStructure();
            // 0, 5 and 17 are basic room scenes
            assert.strictEqual(struct.resolveSceneStateName(0), 'Preset0');
            assert.strictEqual(struct.resolveSceneStateName(5), 'Preset1');
            assert.strictEqual(struct.resolveSceneStateName(17), 'Preset2');
        });

        it('resolves apartment scenes', () => {
            const struct = createStructure();
            assert.strictEqual(struct.resolveSceneStateName(67), 'Standby');
            assert.strictEqual(struct.resolveSceneStateName(72), 'Absent');
        });

        it('returns null for an unknown scene instead of an undefined path', () => {
            const struct = createStructure();
            assert.strictEqual(struct.resolveSceneStateName(9999), null);
            assert.strictEqual(struct.resolveSceneStateName(undefined), null);
        });
    });

    describe('defensive handling of optional DSS data', () => {
        it('findStates survives missing property states', () => {
            const struct = createStructure();
            struct.propertyStates = undefined;
            assert.deepStrictEqual(struct.findStates('^zone\\.1\\.(.*)$'), []);
            struct.propertyStates = [null, { noName: true }, { name: 'zone.1.heating' }];
            const res = struct.findStates('^zone\\.1\\.(.*)$');
            assert.strictEqual(res.length, 1);
            assert.strictEqual(res[0].matchedName, 'heating');
        });

        it('processZone tolerates a zone without sensor values and with temperature control', done => {
            const struct = createStructure({
                dssQueue: {
                    // answers every queued request, the last argument is always the callback
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        setImmediate(() => callback(null, { ok: true, result: { scene: 5 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {} },
            });
            struct.propertyStates = [];
            const zone = { id: 5, isPresent: true, isValid: true, name: 'Living', groups: [] };
            // sensorValues intentionally undefined, temperature control present
            struct.processZone('apartment.1', zone, [], undefined, { ControlMode: 1 }, err => {
                assert.strictEqual(err, null);
                // the initial zone scene must be resolved via zoneSceneCommands
                assert.strictEqual(struct.initialObjectValues['apartment.1.5.scenes.sceneId'], 5);
                assert.strictEqual(struct.initialScenes['5.0'], 5);
                done();
            });
        });

        it('creates zone states with their declared type and the untouched DSS value', done => {
            const struct = createStructure({
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        setImmediate(() => callback(null, { ok: true, result: { scene: 5 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {}, setDssState: () => {} },
            });
            // The DSS reports zone states as strings
            struct.propertyStates = [{ name: 'zone.5.heating', state: 'inactive' }];
            const zone = { id: 5, isPresent: true, isValid: true, name: 'Living', groups: [] };
            struct.processZone('apartment.1', zone, [], undefined, undefined, () => {
                const obj = struct.dssObjects['apartment.1.5.states.heating'];
                assert.strictEqual(obj.common.type, 'boolean', 'the object must stay boolean');
                assert.deepStrictEqual(obj.native, { valueTrue: 'active', valueFalse: 'inactive' });
                // Converted centrally when written, so the raw DSS value is kept here
                assert.strictEqual(obj.value, 'inactive');
                assert.strictEqual(struct.initialObjectValues['apartment.1.5.states.heating'], 'inactive');
                done();
            });
        });

        it('processZone skips a zone that is not part of the structure', done => {
            const struct = createStructure();
            struct.processZone('apartment.1', undefined, [], undefined, undefined, err => {
                assert.strictEqual(err, null);
                done();
            });
        });
    });

    describe('shader devices and initializeOutputValues', () => {
        const POSITION_ID = 'devices.m1.dev1.shadePositionOutside';
        const ANGLE_ID = 'devices.m1.dev1.shadeOpeningAngleOutside';

        function shaderContext(initializeOutputValues) {
            const writes = [];
            const reads = [];
            const scenes = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (dev, index, length, value, prio, callback) => {
                        writes.push({ index, length, value });
                        setImmediate(() => callback && callback(null, value));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) => {
                        reads.push({ index, length });
                        setImmediate(() => callback && callback(null, 0));
                    },
                    pushQueryQueue: (circuit, entry, prio, callback) => {
                        scenes.push(entry.params.sceneNumber);
                        setImmediate(() => callback && callback(null, { ok: true }));
                    },
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            struct.objectsReady = true;
            struct.dssObjects[POSITION_ID] = { type: 'state', common: {}, native: {} };
            struct.dssObjects[ANGLE_ID] = { type: 'state', common: {}, native: {} };
            const dev = {
                dSUID: 'dev1',
                meterDSUID: 'meter1',
                name: 'Wohnen Rollladen',
                outputChannelList: {
                    shadePositionOutside: POSITION_ID,
                    shadeOpeningAngleOutside: ANGLE_ID,
                },
            };
            return { struct, dev, writes, reads, scenes };
        }

        // Regression: the write handlers used to be registered inside the
        // initializeOutputValues block, so switching that option off silently disabled
        // the whole blind control instead of only skipping the initial read.
        [true, false].forEach(initializeOutputValues => {
            it(`forwards a position write to the DSS with initializeOutputValues=${initializeOutputValues}`, done => {
                const { struct, dev, writes } = shaderContext(initializeOutputValues);
                struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                    assert.strictEqual(
                        typeof struct.dssObjects[POSITION_ID].onChange,
                        'function',
                        'a write handler must exist',
                    );
                    struct.dssObjects[POSITION_ID].onChange(50);
                    setTimeout(() => {
                        assert.deepStrictEqual(
                            writes,
                            [{ index: 2, length: 65535, value: Math.round((50 * 65535) / 100) }],
                            'the position must reach the DSS',
                        );
                        done();
                    }, 10);
                });
            });

            it(`forwards an angle write to the DSS with initializeOutputValues=${initializeOutputValues}`, done => {
                const { struct, dev, writes } = shaderContext(initializeOutputValues);
                struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                    assert.strictEqual(
                        typeof struct.dssObjects[ANGLE_ID].onChange,
                        'function',
                        'a write handler must exist',
                    );
                    struct.dssObjects[ANGLE_ID].onChange(40);
                    setTimeout(() => {
                        assert.deepStrictEqual(writes, [
                            { index: 4, length: 255, value: Math.round((40 * 255) / 100) },
                        ]);
                        done();
                    }, 10);
                });
            });
        });

        it('uses the scene call for the end positions in both configurations', done => {
            const { struct, dev, scenes } = shaderContext(false);
            struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                struct.dssObjects[POSITION_ID].onChange(100);
                struct.dssObjects[POSITION_ID].onChange(0);
                setTimeout(() => {
                    assert.deepStrictEqual(scenes, [14, 13], 'open = scene 14, close = scene 13');
                    done();
                }, 10);
            });
        });

        it('reads the initial values only when initializeOutputValues is on', done => {
            const on = shaderContext(true);
            on.struct.createShaderDevice(on.dev, 'devices.m1.dev1', () => {
                const off = shaderContext(false);
                off.struct.createShaderDevice(off.dev, 'devices.m1.dev1', () => {
                    setTimeout(() => {
                        assert.strictEqual(on.reads.length, 2, 'position and angle are read');
                        assert.deepStrictEqual(off.reads, [], 'no read at all when switched off');
                        done();
                    }, 10);
                });
            });
        });

        it('reads after a scene event only when initializeOutputValues is on', done => {
            const on = shaderContext(true);
            on.struct.createShaderDevice(on.dev, 'devices.m1.dev1', () => {
                const off = shaderContext(false);
                off.struct.createShaderDevice(off.dev, 'devices.m1.dev1', () => {
                    on.reads.length = 0;
                    const event = { name: 'callScene', source: { isDevice: true }, properties: { sceneID: '17' } };
                    on.struct.dss.emit('dev1', event);
                    off.struct.dss.emit('dev1', event);
                    setTimeout(() => {
                        assert.ok(on.reads.length > 0, 'the real values are re-read');
                        assert.deepStrictEqual(off.reads, [], 'no DSS read when switched off');
                        on.struct.clearTimeouts();
                        off.struct.clearTimeouts();
                        done();
                    }, 2100);
                });
            });
        }).timeout(6000);
    });

    describe('boolean output channels', () => {
        const STATE_ID = 'devices.meter1.dev1.airLouverAuto';

        function booleanChannelContext() {
            const writes = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (dev, index, length, value, prio, callback) => {
                        writes.push(value);
                        setImmediate(() => callback && callback(null, value));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 0)),
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: Object.assign({}, silentLogger, { warn: msg => warnings.push(String(msg)) }),
                    config: { initializeOutputValues: false, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            const warnings = [];
            struct.adapter.log.warn = msg => warnings.push(String(msg));
            struct.objectsReady = true;
            const dev = {
                dSUID: 'dev1',
                meterDSUID: 'meter1',
                zoneID: 5,
                name: 'Lueftung',
                hwInfo: 'BL-KM200',
                isValid: true,
                isPresent: true,
                outputMode: 1,
                outputChannels: [{ channelId: 'airLouverAuto', channelType: 'airLouverAuto', channelIndex: 20 }],
            };
            return { struct, dev, writes, warnings };
        }

        // Regression: the write handler only accepted numbers, so the two boolean
        // ventilation channels could not be switched at all.
        it('sends true as 1 and false as 0', done => {
            const { struct, dev, writes, warnings } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange(true);
                struct.dssObjects[STATE_ID].onChange(false);
                setTimeout(() => {
                    assert.deepStrictEqual(writes, [1, 0], 'the DSS representation of the boolean channel');
                    assert.deepStrictEqual(warnings, [], 'a valid boolean must not warn');
                    done();
                }, 10);
            });
        });

        it('also accepts the string form the DSS and ioBroker use', done => {
            const { struct, dev, writes } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange('true');
                struct.dssObjects[STATE_ID].onChange('off');
                setTimeout(() => {
                    assert.deepStrictEqual(writes, [1, 0]);
                    done();
                }, 10);
            });
        });

        it('still rejects an invalid type in a controlled way', done => {
            const { struct, dev, writes, warnings } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange({ some: 'object' });
                setTimeout(() => {
                    assert.deepStrictEqual(writes, [], 'nothing may be sent');
                    assert.ok(warnings.join(' ').includes(STATE_ID), 'the rejection must be visible');
                    done();
                }, 10);
            });
        });
    });

    // Die Offset-Reads erreichen vDC-Ausgaenge nicht (live verifiziert: HTTP 500
    // "deviceOutputIndex:255"), der benannte Read device/getOutputChannelValue2
    // beantwortet sie - eine Antwort traegt ALLE Kanaele in der offiziellen
    // Kanalskala (live verifiziert gegen 4 Sonos und ein vDC-Farblicht)
    describe('vDC named channel reads', () => {
        function vdcContext(answer) {
            const reads = [];
            const written = [];
            const infoStates = [];
            const struct = createStructure({
                dssQueue: {
                    queueReadOutputChannels: (dev, prio, callback) => {
                        reads.push({ dSUID: dev.dSUID, prio });
                        setImmediate(() => callback(...answer));
                    },
                },
                adapter: {
                    log: silentLogger,
                    config: {},
                    setState: (id, value, ack) => infoStates.push({ id, value, ack }),
                    isStopping: () => false,
                },
            });
            struct.setStateSafe = (id, value) => {
                written.push({ id, value });
                return true;
            };
            const dev = {
                dSUID: 'sonos1',
                meterDSUID: 'm1',
                isVdcDevice: true,
                outputChannelList: {
                    audioVolume: 'devices.m1.sonos1.audioVolume',
                    powerState: 'devices.m1.sonos1.powerState',
                },
            };
            return { struct, dev, reads, written, infoStates };
        }

        const SONOS_ANSWER = [
            null,
            {
                audioVolume: { value: 14.4, age: 12.5 },
                powerState: { value: 0, age: null },
                // Kanaele ohne ioBroker-State und ohne Zahlenwert bleiben folgenlos
                contentSource: { value: '', age: null },
                repeatMode: { value: 0, age: 1 },
            },
        ];

        it('serves channels without an offset read through the named read', done => {
            const { struct, dev, reads, written, infoStates } = vdcContext(SONOS_ANSWER);
            struct.queueClassicOutputRead(dev, 'audioVolume', 'medium');
            setTimeout(() => {
                assert.deepStrictEqual(reads, [{ dSUID: 'sonos1', prio: 'medium' }]);
                assert.deepStrictEqual(
                    written.sort((a, b) => a.id.localeCompare(b.id)),
                    [
                        { id: 'devices.m1.sonos1.audioVolume', value: 14 },
                        { id: 'devices.m1.sonos1.powerState', value: 0 },
                    ],
                );
                assert.deepStrictEqual(infoStates, [{ id: 'info.outputApi', value: 'classic', ack: true }]);
                done();
            }, 20);
        });

        it('coalesces the channels of one device into one request', done => {
            const { struct, dev, reads, written } = vdcContext(SONOS_ANSWER);
            struct.queueClassicOutputRead(dev, 'audioVolume', 'medium');
            struct.queueClassicOutputRead(dev, 'powerState', 'medium');
            setTimeout(() => {
                assert.strictEqual(reads.length, 1, 'one answer serves every channel');
                assert.strictEqual(written.length, 2);
                done();
            }, 20);
        });

        it('keeps info.outputApi untouched without the report flag', done => {
            const { struct, dev, infoStates, written } = vdcContext(SONOS_ANSWER);
            struct.queueClassicOutputRead(dev, 'audioVolume', 'medium', { report: false });
            setTimeout(() => {
                assert.strictEqual(written.length, 2);
                assert.strictEqual(infoStates.length, 0);
                done();
            }, 20);
        });

        it('remembers a dSS that rejects the call', done => {
            // Der echte Vertrag: requestAsync wirft ok:false-Antworten als Error-Objekt,
            // die Ablehnung steht in dessen message
            const { struct, dev, reads } = vdcContext([
                new Error(
                    'Error response for /json/device/getOutputChannelValue2: This call is currently only supported on vDCs',
                ),
            ]);
            struct.queueClassicOutputRead(dev, 'audioVolume', 'medium');
            setTimeout(() => {
                struct.queueClassicOutputRead(dev, 'audioVolume', 'medium');
                setTimeout(() => {
                    assert.strictEqual(reads.length, 1, 'after the rejection no further request');
                    done();
                }, 20);
            }, 20);
        });

        // Ein Farblicht liefert CIE x/y als 0..1 - die States halten 0..10000
        it('scales the CIE x/y coordinates to the state range', done => {
            const { struct, reads, written } = vdcContext([
                null,
                {
                    hue: { value: 168.35106151615946, age: 1 },
                    saturation: { value: 100, age: 1 },
                    colortemp: { value: 100, age: null },
                    x: { value: 0.225, age: 1 },
                    y: { value: 0.3944, age: 1 },
                },
            ]);
            const light = {
                dSUID: 'hue1',
                meterDSUID: 'm1',
                isVdcDevice: true,
                outputChannelList: {
                    hue: 'devices.m1.hue1.hue',
                    saturation: 'devices.m1.hue1.saturation',
                    colortemp: 'devices.m1.hue1.colortemp',
                    x: 'devices.m1.hue1.x',
                    y: 'devices.m1.hue1.y',
                },
            };
            struct.queueClassicOutputRead(light, 'hue', 'medium');
            setTimeout(() => {
                assert.strictEqual(reads.length, 1);
                assert.deepStrictEqual(
                    written.sort((a, b) => a.id.localeCompare(b.id)),
                    [
                        { id: 'devices.m1.hue1.colortemp', value: 100 },
                        { id: 'devices.m1.hue1.hue', value: 168 },
                        { id: 'devices.m1.hue1.saturation', value: 100 },
                        { id: 'devices.m1.hue1.x', value: 2250 },
                        { id: 'devices.m1.hue1.y', value: 3944 },
                    ],
                );
                done();
            }, 20);
        });

        it('upgrades the report wish of a joining caller', done => {
            const { struct, dev, reads, infoStates } = vdcContext(SONOS_ANSWER);
            struct.queueClassicOutputRead(dev, 'audioVolume', 'medium', { report: false });
            // Springt auf den laufenden Read auf und darf melden - der Read uebernimmt das
            struct.queueClassicOutputRead(dev, 'powerState', 'medium');
            setTimeout(() => {
                assert.strictEqual(reads.length, 1);
                assert.deepStrictEqual(infoStates, [{ id: 'info.outputApi', value: 'classic', ack: true }]);
                done();
            }, 20);
        });

        it('leaves native devices to the offset read path', done => {
            const { struct, reads } = vdcContext(SONOS_ANSWER);
            struct.queueClassicOutputRead(
                { dSUID: 'native1', meterDSUID: 'm1', isVdcDevice: false, outputChannelList: {} },
                'powerLevel',
                'medium',
            );
            setTimeout(() => {
                assert.strictEqual(reads.length, 0, 'no named read for a native terminal');
                done();
            }, 20);
        });
    });

    // vDC-Geraete (Hue, Sonos) haben keinen eigenen create*Device-Pfad und lasen ihre
    // Ausgaenge deshalb NIE - im Sammelzweig gab es bei mehreren Kanaelen nur eine
    // Debug-Zeile, bei einem Kanal einen Offset-Read, den vDCs nicht beantworten
    describe('generic devices reach the reads that work for them', () => {
        function genericContext() {
            const namedReads = [];
            const offsetReads = [];
            const syncRequests = [];
            const written = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueReadOutputChannels: (dev, prio, callback) => {
                        namedReads.push({ dSUID: dev.dSUID, prio });
                        setImmediate(() => callback(null, { brightness: { value: 50 }, colortemp: { value: 370 } }));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) => {
                        offsetReads.push({ dSUID: dev.dSUID, index });
                        setImmediate(() => callback && callback(null, 0));
                    },
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues: true, usePresetValues: false },
                    setState: () => {},
                    isStopping: () => false,
                },
            });
            struct.objectsReady = true;
            struct.setStateSafe = (id, value) => {
                written.push({ id, value });
                return true;
            };
            return { struct, namedReads, offsetReads, syncRequests, written };
        }

        function vdcDevice(channels, hwInfo = 'Extended color light: LCT001') {
            return {
                dSUID: 'hue1',
                meterDSUID: 'vdc1',
                zoneID: 5,
                name: 'Kuecheninsel',
                hwInfo,
                isValid: true,
                isPresent: true,
                isVdcDevice: true,
                outputMode: 22,
                outputChannels: channels.map((channelId, index) => ({
                    channelId,
                    channelType: channelId,
                    channelIndex: index,
                })),
            };
        }

        it('reads a multi channel vDC device through the named read', done => {
            const { struct, namedReads, offsetReads, written } = genericContext();
            struct.createDevice(vdcDevice(['brightness', 'colortemp']), () => {
                setTimeout(() => {
                    assert.deepStrictEqual(namedReads, [{ dSUID: 'hue1', prio: 'medium' }]);
                    assert.strictEqual(offsetReads.length, 0, 'no offset read a vDC cannot answer');
                    // Eine Antwort, beide Kanaele - in der Kanalskala der States
                    assert.deepStrictEqual(
                        written.sort((a, b) => a.id.localeCompare(b.id)),
                        [
                            { id: 'devices.vdc1.hue1.brightness', value: 50 },
                            { id: 'devices.vdc1.hue1.colortemp', value: 370 },
                        ],
                    );
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });

        // Ein Kanal: hier lief bisher ein Offset-Read, den der dSS fuer vDCs mit
        // "Could not find item. deviceOutputIndex:255" beantwortet
        it('reads a single channel vDC device through the named read as well', done => {
            const { struct, namedReads, offsetReads } = genericContext();
            struct.createDevice(vdcDevice(['brightness'], 'Dimmable light: LWV001'), () => {
                setTimeout(() => {
                    assert.strictEqual(namedReads.length, 1);
                    assert.strictEqual(offsetReads.length, 0);
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });

        it('prefers the bundled status request when the sync is available', done => {
            const { struct, namedReads, offsetReads } = genericContext();
            const syncRequests = [];
            struct.smartHomeSync = /** @type {any} */ ({
                requestDeviceSync: dev => {
                    syncRequests.push(dev.dSUID);
                    return true;
                },
                stop: () => {},
            });
            struct.createDevice(vdcDevice(['brightness', 'colortemp']), () => {
                setTimeout(() => {
                    assert.deepStrictEqual(syncRequests, ['hue1']);
                    assert.strictEqual(namedReads.length, 0, 'the status already carries every channel');
                    assert.strictEqual(offsetReads.length, 0);
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });

        it('refreshes them after a scene call through the sync', done => {
            const { struct } = genericContext();
            const syncRequests = [];
            struct.smartHomeSync = /** @type {any} */ ({
                requestDeviceSync: dev => {
                    syncRequests.push(dev.dSUID);
                    return true;
                },
                stop: () => {},
            });
            struct.createDevice(vdcDevice(['brightness', 'colortemp']), () => {
                syncRequests.length = 0;
                struct.dss.emit('hue1', { name: 'callScene', source: { isDevice: true }, properties: {} });
                struct.dss.emit('hue1', { name: 'deviceSensorValue', source: { isDevice: true }, properties: {} });
                setTimeout(() => {
                    assert.deepStrictEqual(syncRequests, ['hue1'], 'only scene calls trigger a re-read');
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });

        // Regression: eine native Klemme hat keinen benannten Read, und der Fallback
        // des Syncs (queueClassicOutputRead) findet fuer einen Kanal ohne festen
        // channelIndex keinen Weg - heatingPower hatte immer nur den Offset-Read
        // dieses Zweigs, der den vom GERAET deklarierten channelIndex benutzt
        it('keeps the offset read of a native single channel device even with a sync', done => {
            const { struct, namedReads, offsetReads } = genericContext();
            const syncRequests = [];
            struct.smartHomeSync = /** @type {any} */ ({
                requestDeviceSync: dev => {
                    syncRequests.push(dev.dSUID);
                    return true;
                },
                stop: () => {},
            });
            const native = {
                dSUID: 'blkm200',
                meterDSUID: 'm1',
                zoneID: 5,
                name: 'Heizung',
                hwInfo: 'BL-KM200',
                isValid: true,
                isPresent: true,
                isVdcDevice: false,
                outputMode: 1,
                outputChannels: [{ channelId: 'heatingPower', channelType: 'heatingPower', channelIndex: 15 }],
            };
            struct.createDevice(native, () => {
                setTimeout(() => {
                    assert.deepStrictEqual(syncRequests, [], 'a native terminal must not hand its read over');
                    assert.strictEqual(namedReads.length, 0);
                    assert.deepStrictEqual(
                        offsetReads,
                        [{ dSUID: 'blkm200', index: 15 }],
                        'the channelIndex the device declares',
                    );
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });

        // Der Weg, den die Sonos auf Andrés Anlage wirklich gehen: der ECHTE Sync lernt
        // die Kanaele als nicht lieferbar und uebergibt sie klassisch - seit dem
        // vorgezogenen Named Read landet auch brightness dort statt im Offset-Read
        it('serves a learned vDC device through one named read, brightness included', async () => {
            const { struct, namedReads, offsetReads, written } = genericContext();
            const { SmartHomeOutputSync } = require('../build/lib/dssSmartHomeSync');
            struct.smartHomeSync = new SmartHomeOutputSync({
                structure: struct,
                smartHome: { getApartmentStatus: async () => ({ included: { dsDevices: [] } }) },
                adapter: struct.adapter,
                debounce: 10,
                followUpDelay: 10,
                maxFollowUps: 1,
                learnAfterMisses: 1,
            });
            const dev = vdcDevice(['brightness', 'colortemp']);
            struct.createDevice(dev, () => {});
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.ok(namedReads.length > 0, 'the learned channels went to ONE named read');
            assert.strictEqual(offsetReads.length, 0, 'brightness must not take the offset path on a vDC');
            assert.deepStrictEqual(written.map(w => w.id).sort(), [
                'devices.vdc1.hue1.brightness',
                'devices.vdc1.hue1.colortemp',
            ]);
            struct.clearTimeouts();
        });

        it('leaves a native multi channel device untouched', done => {
            const { struct, namedReads, offsetReads } = genericContext();
            const native = vdcDevice(['brightness', 'colortemp'], 'BL-KM200');
            native.dSUID = 'native1';
            native.isVdcDevice = false;
            struct.createDevice(native, () => {
                setTimeout(() => {
                    assert.strictEqual(namedReads.length, 0, 'no named read for a native terminal');
                    assert.strictEqual(offsetReads.length, 0, 'multi channel natives have no read path');
                    struct.clearTimeouts();
                    done();
                }, 30);
            });
        });
    });

    // Der Preset-Wert war der Platzhalter fuer eine Position, die waehrend der Fahrt
    // nicht zu wissen war. Mit dem Sync ist sie es - und der Preset traegt den
    // GRUPPEN-Szenenwert, der fuer das einzelne Geraet falsch sein kann
    describe('the scene preset of a shade', () => {
        function shadeContext(withSync) {
            const written = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 0)),
                    queueSetOutputValue: () => {},
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues: false, usePresetValues: true },
                    setState: () => {},
                    isStopping: () => false,
                },
            });
            struct.objectsReady = true;
            struct.setStateSafe = (id, value) => {
                written.push({ id, value });
                return true;
            };
            if (withSync) {
                struct.smartHomeSync = /** @type {any} */ ({ requestDeviceSync: () => true, stop: () => {} });
            }
            const positionId = 'devices.m1.shade1.shadePositionOutside';
            struct.dssObjects[positionId] = { type: 'state', common: {}, native: {} };
            const dev = {
                dSUID: 'shade1',
                meterDSUID: 'm1',
                name: 'Rolladen',
                outputChannelList: { shadePositionOutside: positionId },
            };
            return { struct, dev, written, positionId };
        }

        it('is written when the values can only come from the classic path', done => {
            const { struct, dev, written, positionId } = shadeContext(false);
            struct.createShaderDevice(dev, 'devices.m1.shade1', () => {
                written.length = 0;
                struct.dss.emit('shade1', {
                    name: 'callScene',
                    source: { isDevice: true },
                    properties: { sceneID: '5' },
                });
                setTimeout(() => {
                    assert.deepStrictEqual(written, [{ id: positionId, value: 100 }]);
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });

        it('is left out when the real position follows two seconds later', done => {
            const { struct, dev, written } = shadeContext(true);
            struct.createShaderDevice(dev, 'devices.m1.shade1', () => {
                written.length = 0;
                struct.dss.emit('shade1', {
                    name: 'callScene',
                    source: { isDevice: true },
                    properties: { sceneID: '5' },
                });
                setTimeout(() => {
                    assert.deepStrictEqual(written, [], 'kein geratener Wert vor dem echten');
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });
    });

    // Skripte schreiben ihre User-States alle paar Minuten mit dem bereits gesetzten
    // Wert neu - live gemessen 31 sinnlose Requests an den dSS in 40 Minuten
    describe('writes to an apartment user state', () => {
        function userStateContext() {
            const sent = [];
            const written = [];
            const struct = createStructure({
                dssQueue: {
                    pushQueryQueue: (circuit, entry, prio, callback) => {
                        sent.push(entry.params.value);
                        setImmediate(() => callback && callback(null, { ok: true }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {}, isStopping: () => false },
            });
            struct.objectsReady = true;
            struct.setStateSafe = (id, value) => {
                written.push({ id, value });
                return true;
            };
            struct.propertyUserStates = [{ name: '1614106429', displayName: 'Regensensor', state: 'inactive' }];
            struct.createApartmentUserStates();
            return { struct, sent, written };
        }

        it('goes to the dSS when the value really changes, and only then', () => {
            const { struct, sent, written } = userStateContext();
            const stateId = 'apartment.userStates.1614106429';
            const onChange = struct.dssObjects[stateId].onChange;

            onChange('inactive');
            assert.deepStrictEqual(sent, [], 'derselbe Wert wie im dSS - nichts gesendet');
            assert.deepStrictEqual(written, [{ id: stateId, value: 'inactive' }], 'trotzdem quittiert');

            onChange('active');
            assert.deepStrictEqual(sent, ['active'], 'die echte Aenderung geht raus');

            onChange('active');
            assert.deepStrictEqual(sent, ['active'], 'die Wiederholung nicht');
        });

        it('sends again after the dSS reported something else', () => {
            const { struct, sent } = userStateContext();
            const stateId = 'apartment.userStates.1614106429';
            const onChange = struct.dssObjects[stateId].onChange;

            onChange('active');
            assert.deepStrictEqual(sent, ['active']);
            // Jemand hat den State im dSS umgestellt - das Ereignis kommt hier an
            struct.noteUserStateValue(stateId, 'inactive');
            onChange('active');
            assert.deepStrictEqual(sent, ['active', 'active'], 'jetzt ist der Wert wieder eine Aenderung');
        });
    });

    // Ein Joker mit Ausgang (geschaltete Steckdose) hatte fuer diesen Ausgang gar keinen
    // Lesepfad: der Wert kam erst mit dem naechsten Abgleich, live gemessen 57 s nach
    // dem Einschalten
    describe('a joker with an output follows its scenes', () => {
        function jokerContext(withSync) {
            const syncRequests = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 0)),
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues: true, usePresetValues: false },
                    setState: () => {},
                    isStopping: () => false,
                },
            });
            struct.objectsReady = true;
            struct.setStateSafe = () => true;
            if (withSync) {
                struct.smartHomeSync = /** @type {any} */ ({
                    requestDeviceSync: dev => {
                        syncRequests.push(dev.dSUID);
                        return true;
                    },
                    stop: () => {},
                });
            }
            const dev = {
                dSUID: 'socket1',
                meterDSUID: 'm1',
                zoneID: 5,
                name: 'Steckdose Drucker',
                hwInfo: 'SW-KL200',
                isValid: true,
                isPresent: true,
                isVdcDevice: false,
                outputMode: 1,
                buttonInputCount: 1,
                outputChannels: [{ channelId: 'powerLevel', channelType: 'powerLevel', channelIndex: 0 }],
            };
            return { struct, dev, syncRequests };
        }

        it('reads its output at startup and again after a scene', done => {
            const { struct, dev, syncRequests } = jokerContext(true);
            struct.createDevice(dev, () => {
                assert.deepStrictEqual(syncRequests, ['socket1'], 'einmal beim Anlegen');
                struct.dss.emit('socket1', {
                    name: 'callScene',
                    source: { isDevice: true },
                    properties: { sceneID: '14' },
                });
                struct.dss.emit('socket1', { name: 'buttonClick', source: { isDevice: true }, properties: {} });
                setTimeout(() => {
                    assert.deepStrictEqual(syncRequests, ['socket1', 'socket1'], 'nur der Szenenaufruf liest nach');
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });

        it('stays quiet without the sync', done => {
            const { struct, dev } = jokerContext(false);
            struct.createDevice(dev, () => {
                struct.dss.emit('socket1', { name: 'callScene', source: { isDevice: true }, properties: {} });
                setTimeout(() => {
                    assert.strictEqual(struct.sceneRefreshDevices.size, 0, 'nichts registriert');
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });

        // createJokerDevice ist aus zwei Pfaden erreichbar - der Handler darf nur einmal haengen
        it('registers the refresh only once per device', done => {
            const { struct, dev, syncRequests } = jokerContext(true);
            struct.createDevice(dev, () => {
                struct.registerSceneOutputRefresh(dev);
                struct.registerSceneOutputRefresh(dev);
                syncRequests.length = 0;
                struct.dss.emit('socket1', { name: 'callScene', source: { isDevice: true }, properties: {} });
                setTimeout(() => {
                    assert.deepStrictEqual(syncRequests, ['socket1'], 'ein Handler, eine Anfrage');
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });
    });

    // Als invalid markierte Metering-Sensoren liefern ohne Event nie einen Wert -
    // ein Drucker im Standby sendet monatelang keins. Ein einmaliger Bus-Read mit
    // niedriger Prioritaet fuellt den State (live verifiziert: die Steckdose
    // beantwortet device/getSensorValue fuer alle fuenf Sensoren)
    describe('initial device sensor reads', () => {
        function sensorContext(sensors) {
            const sensorReads = [];
            const written = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueReadSensorValue: (dev, sensorIndex, prio, callback) => {
                        sensorReads.push({ dSUID: dev.dSUID, sensorIndex, prio });
                        setImmediate(() => callback(null, 30));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 0)),
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: silentLogger,
                    config: {},
                    setState: () => {},
                    isStopping: () => false,
                },
            });
            struct.setStateSafe = (id, value) => {
                written.push({ id, value });
                return true;
            };
            const dev = {
                dSUID: 'dev1',
                meterDSUID: 'meter1',
                zoneID: 5,
                name: 'Steckdose',
                hwInfo: 'SW-KL200',
                isValid: true,
                isPresent: true,
                outputMode: 1,
                sensorInputCount: sensors.length,
                sensors,
                outputChannels: [],
            };
            return { struct, dev, sensorReads, written };
        }

        it('reads an invalid metering sensor once at low priority', done => {
            const { struct, dev, sensorReads, written } = sensorContext([
                { type: 4, valid: false, value: 0 },
                // Energy meter (6): native Aufloesung unverifiziert - bleibt bei den Events
                { type: 6, valid: false, value: 0 },
            ]);
            struct.createDevice(dev, () => {
                setTimeout(() => {
                    assert.deepStrictEqual(sensorReads, [{ dSUID: 'dev1', sensorIndex: 0, prio: 'low' }]);
                    assert.deepStrictEqual(written, [{ id: 'devices.meter1.dev1.sensors.0', value: 30 }]);
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });

        it('trusts a value the structure already delivered', done => {
            const { struct, dev, sensorReads } = sensorContext([{ type: 4, valid: true, value: 42 }]);
            struct.createDevice(dev, () => {
                setTimeout(() => {
                    assert.strictEqual(sensorReads.length, 0, 'no bus read for a valid sensor');
                    assert.strictEqual(struct.initialObjectValues['devices.meter1.dev1.sensors.0'], 42);
                    struct.clearTimeouts();
                    done();
                }, 20);
            });
        });
    });

    describe('apartment ventilation status', () => {
        // Regression: the state was created as boolean, which turned every status code
        // other than 0 into "true" and lost the difference between malfunction and service.
        it('is a numeric state with the DSS status codes', () => {
            const definition = dssConstants.sensorUnitRoleMap[60];
            assert.strictEqual(definition.type, 'number', 'the constants declare a status code');
            [0, 2, 4, 6].forEach(code =>
                assert.ok(String(code) in definition.states, `status code ${code} must be named`),
            );
            assert.strictEqual(definition.states[0], 'OK');
            assert.strictEqual(definition.states[2], 'Malfunction');
            assert.strictEqual(definition.states[4], 'Service');
            assert.strictEqual(definition.states[6], 'Malfunction+Service');
        });

        it('creates the apartment state with the numeric definition', () => {
            const struct = createStructure();
            struct.addStateObject('apartment.sensors.VentilationStatusValue', '0.sensors.60', {
                ...dssConstants.sensorUnitRoleMap[60],
                name: 'Ventilation Status',
                read: true,
                write: false,
            });
            const obj = struct.dssObjects['apartment.sensors.VentilationStatusValue'];
            assert.strictEqual(obj.common.type, 'number', 'a boolean would collapse 2, 4 and 6 to true');
            assert.strictEqual(obj.common.states[6], 'Malfunction+Service');
            assert.strictEqual(struct.stateMap['0.sensors.60'], 'apartment.sensors.VentilationStatusValue');
        });
    });

    describe('scene state ids', () => {
        function convert(name) {
            return createStructure().convertSceneName(name);
        }

        // Regression: scene 22 and scene 25 were both called "Preset 24", so they produced
        // the same state id - one scene silently overwrote the other.
        it('produces a unique state id for every zone scene', () => {
            const seen = {};
            Object.keys(dssConstants.zoneSceneCommands).forEach(sceneId => {
                const stateName = convert(dssConstants.zoneSceneCommands[sceneId]);
                assert.strictEqual(
                    seen[stateName],
                    undefined,
                    `scene ${sceneId} collides with scene ${seen[stateName]}`,
                );
                seen[stateName] = sceneId;
            });
        });

        it('produces a unique state id for every apartment scene', () => {
            const seen = {};
            Object.keys(dssConstants.apartmentScenes).forEach(sceneId => {
                const stateName = convert(dssConstants.apartmentScenes[sceneId]);
                assert.strictEqual(
                    seen[stateName],
                    undefined,
                    `scene ${sceneId} collides with scene ${seen[stateName]}`,
                );
                seen[stateName] = sceneId;
            });
        });

        it('produces a unique state id for every special group scene', () => {
            ['temperatureControlScenes', 'ventilationControlScenes'].forEach(mapName => {
                const seen = {};
                Object.keys(dssConstants[mapName]).forEach(sceneId => {
                    const stateName = convert(dssConstants[mapName][sceneId]);
                    assert.strictEqual(
                        seen[stateName],
                        undefined,
                        `${mapName}: scene ${sceneId} collides with scene ${seen[stateName]}`,
                    );
                    seen[stateName] = sceneId;
                });
            });
        });

        it('keeps scene 22 and scene 25 apart and maps them to the right presets', () => {
            assert.strictEqual(dssConstants.zoneSceneCommands[22], 'Preset 14');
            assert.strictEqual(dssConstants.zoneSceneCommands[25], 'Preset 24');
            assert.notStrictEqual(
                convert(dssConstants.zoneSceneCommands[22]),
                convert(dssConstants.zoneSceneCommands[25]),
            );
        });
    });

    describe('initial scene state of special groups', () => {
        // Regression: the initial state was resolved with the generic scene names, so
        // group 48 scene 0 activated "Preset0" while every event toggled "HeatingOff".
        it('uses the state map instead of the generic scene name', () => {
            const struct = createStructure();
            const groupBaseId = 'apartment.zones.5.groups.48';
            // Both states exist for group 48, the special one owns the DSS key
            struct.dssObjects[`${groupBaseId}.scenes.Preset0`] = { type: 'state', common: {} };
            struct.dssObjects[`${groupBaseId}.scenes.HeatingOff`] = { type: 'state', common: {} };
            struct.stateMap['5.48.scenes.0'] = `${groupBaseId}.scenes.HeatingOff`;

            const stateId = struct.resolveSceneStateId('5.48.scenes.0', 0, groupBaseId);
            assert.strictEqual(stateId, `${groupBaseId}.scenes.HeatingOff`, 'the special scene state must win');
            assert.strictEqual(
                struct.resolveSceneStateName(0),
                'Preset0',
                'the generic name still resolves to Preset0',
            );
        });

        it('does the same for the ventilation groups', () => {
            const struct = createStructure();
            const groupBaseId = 'apartment.zones.7.groups.10';
            struct.stateMap['7.10.scenes.0'] = `${groupBaseId}.scenes.Off`;
            assert.strictEqual(
                struct.resolveSceneStateId('7.10.scenes.0', 0, groupBaseId),
                `${groupBaseId}.scenes.Off`,
            );
        });

        it('falls back to the generic name when the scene is not in the state map', () => {
            const struct = createStructure();
            assert.strictEqual(
                struct.resolveSceneStateId('5.1.scenes.0', 0, 'apartment.zones.5.groups.1'),
                'apartment.zones.5.groups.1.scenes.Preset0',
            );
            assert.strictEqual(struct.resolveSceneStateId('5.1.scenes.9999', 9999, 'apartment.zones.5.groups.1'), null);
        });

        it('activates only the special state of group 48 during processGroup', done => {
            const struct = createStructure({
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        // The DSS reports scene 0 as the last called scene
                        setImmediate(() => callback(null, { ok: true, result: { scene: 0 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {} },
            });
            struct.propertyStates = [];
            const group = { id: 48, name: 'Temperature Control', isPresent: true, isValid: true, devices: ['dev1'] };
            struct.processGroup('apartment.zones.5.groups.48', 5, group, () => {
                const base = 'apartment.zones.5.groups.48';
                assert.strictEqual(
                    struct.initialObjectValues[`${base}.scenes.HeatingOff`],
                    true,
                    'the state the events use must be the active one',
                );
                assert.strictEqual(
                    struct.initialObjectValues[`${base}.scenes.Preset0`],
                    false,
                    'the generic state must not be active at the same time',
                );
                done();
            });
        });
    });

    describe('binary input value mapping', () => {
        function binaryInputDevice(inputType) {
            return {
                dSUID: 'dev1',
                meterDSUID: 'm1',
                zoneID: 5,
                name: 'Fenster',
                hwInfo: 'EnOcean',
                isValid: true,
                isPresent: true,
                buttonActiveGroup: -1,
                buttonInputCount: 0,
                sensorInputCount: 0,
                binaryInputCount: 1,
                binaryInputs: [{ inputType, targetGroup: 8, state: 1 }],
                groups: [8],
            };
        }

        function structure() {
            return createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (d, i, l, v, p, cb) => setImmediate(() => cb && cb(null, v)),
                    queueUpdateOutputValue: (d, i, l, p, cb) => setImmediate(() => cb && cb(null, 0)),
                    pushQueryQueue: (...args) => {
                        const cb = args[args.length - 1];
                        setImmediate(() => cb && cb(null, { ok: true }));
                    },
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues: false, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
        }

        // The value of a binary input used to be a bare number without any meaning attached,
        // so a window handle reported 1, 2 or 3 and nothing said which position that was.
        // Observed on an EnOcean window handle (F6-10-00) against the readable device state
        // of the same handle: closed 1, open 2, tilted 3.
        it('names the three positions of a window handle', done => {
            const struct = structure();
            struct.createDevice(binaryInputDevice(15), () => {
                const obj = struct.dssObjects['devices.m1.dev1.binaryInputs.0'];
                assert.strictEqual(obj.common.name, 'Window is tilted');
                assert.deepStrictEqual(obj.common.states, { 1: 'closed', 2: 'open', 3: 'tilted' });
                assert.strictEqual(obj.common.type, 'number', 'the raw number stays, history keeps working');
                done();
            });
        });

        it('names the two states of every other binary input', done => {
            const struct = structure();
            struct.createDevice(binaryInputDevice(5), () => {
                const obj = struct.dssObjects['devices.m1.dev1.binaryInputs.0'];
                assert.strictEqual(obj.common.name, 'Motion');
                assert.deepStrictEqual(obj.common.states, { 1: 'inactive', 2: 'active' });
                done();
            });
        });
    });

    describe('button state of index 0', () => {
        function deviceStructure() {
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (d, i, l, v, p, cb) => setImmediate(() => cb && cb(null, v)),
                    queueUpdateOutputValue: (d, i, l, p, cb) => setImmediate(() => cb && cb(null, 0)),
                    pushQueryQueue: (...args) => {
                        const cb = args[args.length - 1];
                        setImmediate(() => cb && cb(null, { ok: true }));
                    },
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues: false, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            return struct;
        }

        function jokerDevice(buttonActiveGroup) {
            return {
                dSUID: 'dev1',
                meterDSUID: 'm1',
                zoneID: 5,
                name: 'Taster',
                hwInfo: 'SW-TKM210',
                isValid: true,
                isPresent: true,
                buttonActiveGroup,
                buttonInputCount: 4,
                sensorInputCount: 0,
                binaryInputCount: 0,
                groups: [8],
            };
        }

        // Regression: the state of button 0 was only created for buttonActiveGroup 1..8, while
        // buttonClickType/buttonHoldCount of the same button were always created. main.js aborts
        // the whole buttonClick handler when the plain button state is missing, so every press
        // of the first button was dropped on devices with buttonActiveGroup -1, 0 or > 8.
        [-1, 0, 9, 12].forEach(group => {
            it(`creates the button state for buttonActiveGroup ${group}`, done => {
                const struct = deviceStructure();
                struct.createDevice(jokerDevice(group), () => {
                    assert.strictEqual(
                        struct.stateMap['dev1.0.button'],
                        'devices.m1.dev1.button',
                        'the handler in main.js needs this entry',
                    );
                    assert.strictEqual(typeof struct.stateMap['dev1.0.buttonClickType'], 'string');
                    assert.strictEqual(typeof struct.stateMap['dev1.0.buttonHoldCount'], 'string');
                    assert.strictEqual(
                        typeof struct.stateMap['dev1.1.button'],
                        'string',
                        'the further buttons stay as they were',
                    );
                    done();
                });
            });
        });

        it('keeps working for the groups that were already correct', done => {
            const struct = deviceStructure();
            struct.createDevice(jokerDevice(1), () => {
                assert.strictEqual(struct.stateMap['dev1.0.button'], 'devices.m1.dev1.button');
                assert.strictEqual(struct.initialObjectValues['devices.m1.dev1.button'], false);
                done();
            });
        });
    });

    describe('extraneous zones', () => {
        function apartmentStructure(levels) {
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const cb = args[args.length - 1];
                        setImmediate(() => cb && cb(null, { ok: true, result: { scene: 0 } }));
                    },
                },
                adapter: {
                    log: Object.assign({}, silentLogger, { warn: msg => levels.push(String(msg)) }),
                    config: {},
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            struct.propertyStates = [];
            struct.sensorValues = { outdoor: {}, zones: {} };
            struct.temperatureControlStatus = { zones: {} };
            return struct;
        }

        const zone = id => ({ id, name: `Zone ${id}`, isPresent: true, isValid: true, groups: [], devices: [] });

        // Regression: the check used processedZones, but the zones are handed to processZone()
        // via setImmediate - the map was still empty, so EVERY regular zone was reported at
        // every single adapter start.
        it('does not report a zone that is assigned to a floor', done => {
            const warnings = [];
            const struct = apartmentStructure(warnings);
            struct.createApartment(
                {
                    floors: { 0: { id: 0, name: 'EG', zones: [5] } },
                    zones: { 5: zone(5) },
                    zone0: { groups: [] },
                    clusters: {},
                },
                {},
                () => {
                    assert.deepStrictEqual(
                        warnings.filter(w => w.includes('EXTRANOUS')),
                        [],
                        'no false alarm',
                    );
                    struct.clearTimeouts();
                    done();
                },
            );
        });

        // A real DSS does not send isValid for a zone at all - a plain truthiness check
        // silenced the whole check on such an installation
        it('works even when the DSS reports no isValid for the zones', done => {
            const warnings = [];
            const struct = apartmentStructure(warnings);
            const withoutFlag = id => ({ id, name: `Zone ${id}`, isPresent: true, groups: [], devices: [] });
            struct.createApartment(
                {
                    floors: { 0: { id: 0, name: 'EG', zones: [5] } },
                    zones: { 5: withoutFlag(5), 9: withoutFlag(9) },
                    zone0: { groups: [] },
                    clusters: {},
                },
                {},
                () => {
                    const extraneous = warnings.filter(w => w.includes('EXTRANOUS'));
                    assert.strictEqual(extraneous.length, 1, 'the unassigned zone must still be found');
                    assert.ok(extraneous[0].includes('9'));
                    struct.clearTimeouts();
                    done();
                },
            );
        });

        it('stays quiet about a zone the DSS marks as not present', done => {
            const warnings = [];
            const struct = apartmentStructure(warnings);
            struct.createApartment(
                {
                    floors: { 0: { id: 0, name: 'EG', zones: [5] } },
                    zones: {
                        5: zone(5),
                        // 65534 is the dS zone for devices that are not assigned to a room
                        65534: { id: 65534, name: '', isPresent: false, groups: [], devices: [] },
                    },
                    zone0: { groups: [] },
                    clusters: {},
                },
                {},
                () => {
                    assert.deepStrictEqual(
                        warnings.filter(w => w.includes('EXTRANOUS')),
                        [],
                    );
                    struct.clearTimeouts();
                    done();
                },
            );
        });

        it('still reports a zone that belongs to no floor', done => {
            const warnings = [];
            const struct = apartmentStructure(warnings);
            struct.createApartment(
                {
                    floors: { 0: { id: 0, name: 'EG', zones: [5] } },
                    zones: { 5: zone(5), 9: zone(9) },
                    zone0: { groups: [] },
                    clusters: {},
                },
                {},
                () => {
                    const extraneous = warnings.filter(w => w.includes('EXTRANOUS'));
                    assert.strictEqual(extraneous.length, 1, 'exactly the unassigned zone');
                    assert.ok(extraneous[0].includes('9'));
                    struct.clearTimeouts();
                    done();
                },
            );
        });
    });

    describe('output channel definitions', () => {
        it('names the indoor shade channels as indoor', () => {
            assert.ok(dssConstants.outputChannelUnitRoleMap.shadePositionIndoor.name.includes('Indoor'));
            assert.ok(dssConstants.outputChannelUnitRoleMap.shadePositionOutside.name.includes('Outside'));
            assert.ok(dssConstants.outputChannelUnitRoleMap.shadeOpeningAngleIndoor.name.includes('Indoor'));
            assert.ok(dssConstants.outputChannelUnitRoleMap.shadeOpeningAngleOutside.name.includes('Outside'));
        });

        it('gives every output channel a unique name', () => {
            const seen = {};
            Object.keys(dssConstants.outputChannelUnitRoleMap).forEach(key => {
                const name = dssConstants.outputChannelUnitRoleMap[key].name;
                assert.strictEqual(seen[name], undefined, `${key} shares its name with ${seen[name]}`);
                seen[name] = key;
            });
        });
    });

    describe('room temperature control', () => {
        // Real answer of apartment/getTemperatureControlStatus from a productive DSS.
        // Regulated rooms carry values, rooms without a controller only ControlMode 0.
        const REGULATED = {
            id: 2,
            name: 'Wohnen',
            ControlMode: 1,
            ControlState: 0,
            OperationMode: 0,
            TemperatureValue: 23.5,
            NominalValue: 8,
            ControlValue: 0,
        };
        const UNREGULATED = { id: 1, name: 'Flur', ControlMode: 0, ControlState: 0 };

        function tempStructure(setpointAnswer) {
            const asked = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    asked,
                    pushQueryQueue(circuit, entry, prio, callback) {
                        asked.push(entry);
                        if (entry.dssFunction === 'getTemperatureControlValues') {
                            return setImmediate(() => callback(null, setpointAnswer));
                        }
                        setImmediate(() => callback(null, { ok: true }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {}, setDssState: () => {} },
            });
            return { struct, asked };
        }

        it('only regulates zones the DSS really controls', () => {
            const { struct } = tempStructure({ ok: false });
            assert.strictEqual(struct.hasTemperatureControl(REGULATED), true, 'ControlMode 1 is a real controller');
            assert.strictEqual(struct.hasTemperatureControl(UNREGULATED), false, 'ControlMode 0 has no values at all');
            assert.strictEqual(struct.hasTemperatureControl(undefined), false);
            assert.strictEqual(struct.hasTemperatureControl({}), false, 'a zone without ControlMode');
        });

        it('creates the controller states with the values of the DSS', done => {
            const { struct } = tempStructure({ ok: false });
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                const base = 'apartment.0.2.temperatureControl';
                assert.strictEqual(struct.dssObjects[`${base}.ControlMode`].common.write, false, 'reported by the DSS');
                assert.strictEqual(struct.initialObjectValues[`${base}.ControlMode`], 1);
                assert.strictEqual(struct.initialObjectValues[`${base}.ControlState`], 0);
                assert.strictEqual(struct.initialObjectValues[`${base}.OperationMode`], 0);
                assert.strictEqual(
                    struct.dssObjects[`${base}.OperationMode`].common.states[0],
                    'Heating Off',
                    'the modes are the scenes of group 48',
                );
                assert.strictEqual(
                    struct.stateMap['2.48.operationMode'],
                    `${base}.OperationMode`,
                    'events must find it',
                );
                done();
            });
        });

        it('switches the operation mode through a scene of group 48', done => {
            const { struct, asked } = tempStructure({ ok: false });
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                asked.length = 0;
                struct.dssObjects['apartment.0.2.temperatureControl.OperationMode'].onChange(1);
                setTimeout(() => {
                    assert.strictEqual(asked.length, 1);
                    assert.strictEqual(asked[0].dssFunction, 'callScene');
                    assert.deepStrictEqual(asked[0].params, { id: 2, groupID: 48, sceneNumber: 1 });
                    done();
                }, 10);
            });
        });

        it('rejects an operation mode the temperature control does not know', done => {
            const warnings = [];
            const { struct, asked } = tempStructure({ ok: false });
            struct.adapter.log.warn = msg => warnings.push(String(msg));
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                asked.length = 0;
                struct.dssObjects['apartment.0.2.temperatureControl.OperationMode'].onChange(99);
                setTimeout(() => {
                    assert.deepStrictEqual(asked, [], 'nothing may be sent');
                    assert.ok(warnings.join(' ').includes('Invalid operation mode'));
                    done();
                }, 10);
            });
        });

        it('creates a writable state per set point the DSS reports', done => {
            const answer = { ok: true, result: { Off: 6, Comfort: 21, Economy: 18, Night: 16, Holiday: 12 } };
            const { struct, asked } = tempStructure(answer);
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                const base = 'apartment.0.2.temperatureControl.setpoints';
                assert.strictEqual(struct.initialObjectValues[`${base}.Comfort`], 21);
                assert.strictEqual(struct.initialObjectValues[`${base}.Off`], 6);
                assert.strictEqual(struct.dssObjects[`${base}.Comfort`].common.unit, '°C');

                asked.length = 0;
                struct.dssObjects[`${base}.Comfort`].onChange(22);
                setTimeout(() => {
                    assert.strictEqual(asked.length, 1);
                    assert.strictEqual(asked[0].dssFunction, 'setTemperatureControlValues');
                    assert.deepStrictEqual(asked[0].params, { id: 2, Comfort: 22 });
                    done();
                }, 10);
            });
        });

        // Not every DSS firmware knows the endpoint - then there must be no dead states
        it('creates no set point states when the DSS does not support them', done => {
            const { struct } = tempStructure({ ok: false, message: 'Unknown function' });
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                const dead = Object.keys(struct.dssObjects).filter(id => id.includes('.setpoints'));
                assert.deepStrictEqual(dead, [], 'no folder and no states');
                // The controller states themselves must still exist
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.0.2.temperatureControl.ControlMode']),
                    '[object Object]',
                );
                done();
            });
        });

        it('ignores non numeric fields of the set point answer', done => {
            const answer = { ok: true, result: { Comfort: 21, ControlMode: 'pid', Nothing: null } };
            const { struct } = tempStructure(answer);
            struct.createTemperatureControl('apartment.0.2', { id: 2, name: 'Wohnen' }, REGULATED, () => {
                const ids = Object.keys(struct.dssObjects).filter(id => id.includes('.setpoints.'));
                assert.deepStrictEqual(ids, ['apartment.0.2.temperatureControl.setpoints.Comfort']);
                done();
            });
        });
    });

    describe('group and cluster states', () => {
        function groupStructure(propertyStates) {
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const cb = args[args.length - 1];
                        setImmediate(() => cb && cb(null, { ok: true, result: { scene: 0 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {}, setDssState: () => {} },
            });
            struct.propertyStates = propertyStates;
            return struct;
        }

        // Regression: the cluster states of a real installation had no object at all -
        // the group folders apartment.groups.17 ... exist, but the DSS names their states
        // "cluster.17.user_lock" instead of "zone.0.group.17.user_lock".
        it('creates the states of an apartment cluster', done => {
            const struct = groupStructure([
                { name: 'cluster.17.user_lock', state: 'inactive' },
                { name: 'cluster.17.operation_lock', state: 'active' },
                { name: 'cluster.18.user_lock', state: 'inactive' },
            ]);
            const group = { id: 17, name: 'Rollladen Nord', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.groups.17', 0, group, () => {
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.groups.17.states.user_lock']),
                    '[object Object]',
                    'user_lock',
                );
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.groups.17.states.operation_lock']),
                    '[object Object]',
                );
                assert.strictEqual(struct.dssObjects['apartment.groups.17.states.user_lock'].common.type, 'boolean');
                assert.strictEqual(struct.initialObjectValues['apartment.groups.17.states.operation_lock'], 'active');
                assert.strictEqual(
                    struct.dssObjects['apartment.groups.18.states.user_lock'],
                    undefined,
                    'a state of another cluster must not land here',
                );
                done();
            });
        });

        // Regression: the cluster locks were created with an empty native, so the write
        // handler could only ever take its "no value mapping known" branch - the queue push
        // behind it was unreachable code.
        it('gives the cluster locks the value mapping the dSS answers with', done => {
            const struct = groupStructure([
                { name: 'cluster.17.user_lock', state: 'inactive' },
                { name: 'cluster.17.operation_lock', state: 'active' },
            ]);
            const group = { id: 17, name: 'Rollladen Nord', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.groups.17', 0, group, () => {
                const lock = struct.dssObjects['apartment.groups.17.states.user_lock'];
                assert.strictEqual(lock.native.valueTrue, 'active');
                assert.strictEqual(lock.native.valueFalse, 'inactive');
                assert.strictEqual(
                    struct.dssObjects['apartment.groups.17.states.operation_lock'].native.valueTrue,
                    'active',
                );
                done();
            });
        });

        it('leaves a state the dSS computes itself without a mapping', done => {
            const struct = groupStructure([{ name: 'zone.2.group.10.status.malfunction', state: 'inactive' }]);
            const group = { id: 10, name: 'Lueftung', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.0.2.10', 2, group, () => {
                const malfunction = struct.dssObjects['apartment.0.2.10.states.status.malfunction'];
                assert.strictEqual(
                    Object.prototype.toString.call(malfunction),
                    '[object Object]',
                    'the state still exists',
                );
                assert.strictEqual(
                    malfunction.native.valueTrue,
                    undefined,
                    'writing a malfunction back would only earn a rejection',
                );
                done();
            });
        });

        it('does not take cluster states into a room group', done => {
            const struct = groupStructure([{ name: 'cluster.17.user_lock', state: 'inactive' }]);
            const group = { id: 17, name: 'Licht', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.0.2.17', 2, group, () => {
                assert.strictEqual(
                    struct.dssObjects['apartment.0.2.17.states.user_lock'],
                    undefined,
                    'clusters are apartment wide',
                );
                done();
            });
        });

        // Regression: the group state pattern only matched a single segment, so the
        // ventilation status states of a room were dropped
        it('creates a group state whose name contains a dot as a nested state', done => {
            const struct = groupStructure([
                { name: 'zone.2.group.10.status.malfunction', state: 'inactive' },
                { name: 'zone.2.group.10.status.service', state: 'inactive' },
            ]);
            const group = { id: 10, name: 'Lüftung', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.0.2.10', 2, group, () => {
                const base = 'apartment.0.2.10.states';
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects[`${base}.status.malfunction`]),
                    '[object Object]',
                    'the state itself',
                );
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects[`${base}.status.service`]),
                    '[object Object]',
                );
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects[`${base}.status`]),
                    '[object Object]',
                    'and the folder in between',
                );
                assert.strictEqual(struct.dssObjects[`${base}.status`].type, 'channel');
                assert.strictEqual(struct.stateMap['zone.2.group.10.status.malfunction'], `${base}.status.malfunction`);
                done();
            });
        });

        it('keeps the simple group states working', done => {
            const struct = groupStructure([{ name: 'zone.2.group.1.heating', state: 'inactive' }]);
            const group = { id: 1, name: 'Licht', isPresent: true, isValid: true, devices: ['d1'] };
            struct.processGroup('apartment.0.2.1', 2, group, () => {
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.0.2.1.states.heating']),
                    '[object Object]',
                );
                done();
            });
        });
    });

    describe('unmapped property states', () => {
        function reportingStructure(entries) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        info: msg => entries.push(String(msg)),
                    }),
                    config: {},
                },
            });
        }

        it('reports states that belong to no device, room, group or the apartment', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [
                { name: 'presence', state: 'active' },
                { name: 'zone.5.heating', state: 'inactive' },
                // A state of a device the DSS does not list in the apartment structure,
                // e.g. an EnOcean window contact on a DSB
                { name: 'dev.302ed89f43f000000000458002a35af000.302ed89f43f000000000458002a35af000_open-tilded' },
            ];
            // The apartment and the zone claim their states, the device does not exist
            struct.findStates('^([^.]*)$');
            struct.findStates('^zone\\.5\\.([^.]*)$');

            struct.reportUnmappedStates();

            assert.strictEqual(entries.length, 1, 'exactly one summary line');
            assert.ok(entries[0].includes('open-tilded'));
            assert.ok(!entries[0].includes('zone.5.heating'), 'the claimed states must not be listed');
            assert.ok(!entries[0].includes('"presence"'));
        });

        it('does not ask for an issue about zones and groups it skipped itself', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [
                // a group no zone can reach, and a zone the dSS reports as not present -
                // this adapter builds no objects for either, by its own decision
                { name: 'zone.2274.group.10.status.malfunction' },
                { name: 'zone.2274.group.10.status.service' },
                { name: 'zone.65534.light' },
                { name: 'zone.0.group.64.status.service' },
                // this one really belongs to nobody and has to survive the filter
                { name: 'dev.302ed89f43f000000000458002a35af100.0' },
            ];
            struct.skippedStatePrefixes.add('zone.2274.group.10.');
            struct.skippedStatePrefixes.add('zone.65534.');
            struct.skippedStatePrefixes.add('zone.0.group.64.');

            struct.reportUnmappedStates();

            assert.strictEqual(entries.length, 1, 'exactly one summary line');
            assert.ok(entries[0].includes('a35af100'), 'the orphan is still named');
            assert.ok(!entries[0].includes('group.10'), 'a skipped group must not be listed');
            assert.ok(!entries[0].includes('65534'), 'a skipped zone must not be listed');
            assert.ok(!entries[0].includes('group.64'));
        });

        it('stays quiet when only skipped zones and groups are left over', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [{ name: 'zone.65534.heating' }];
            struct.skippedStatePrefixes.add('zone.65534.');
            struct.reportUnmappedStates();
            assert.deepStrictEqual(entries, [], 'nothing to report, nothing to ask for');
        });

        it('stays quiet when every state was assigned', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [{ name: 'presence', state: 'active' }];
            struct.findStates('^([^.]*)$');
            struct.reportUnmappedStates();
            assert.deepStrictEqual(entries, []);
        });

        describe('the coupled input of a 2-way button', () => {
            // Taken from a real installation: three GR-KL300 whose push buttons are wired
            // as a 2-way switch. getStructure lists the terminal block with
            // buttonInputMode 10 ("2-way up with input 2") and leaves its second input -
            // the next dSID - out, /usr/states still carries that input's binary state.
            const master = {
                dSUID: '302ed89f43f000000000458002a35a2800',
                name: 'Rolladen Büro',
                hwInfo: 'GR-KL300',
                isVdcDevice: false,
                buttonInputMode: 10,
            };
            const partnerState = { name: 'dev.302ed89f43f000000000458002a35a2900.0', value: 2, state: 'inactive' };
            // A second hidden pair of the same installation. The tests that still expect an
            // info line pass it along, so each of them also shows that the rule tells the
            // two cases apart instead of just leaving everything as it was.
            const otherMaster = Object.assign({}, master, {
                dSUID: '302ed89f43f000000000458002a35af000',
                name: 'Rolladen Wohnen Fenster',
            });
            const otherPartnerState = { name: 'dev.302ed89f43f000000000458002a35af100.0', value: 2, state: 'inactive' };

            function loggingStructure(info, debug) {
                return createStructure({
                    adapter: {
                        log: Object.assign({}, silentLogger, {
                            info: msg => info.push(String(msg)),
                            debug: msg => debug.push(String(msg)),
                        }),
                        config: {},
                    },
                });
            }

            it('names it on debug with its device instead of asking for an issue', () => {
                const info = [];
                const debug = [];
                const struct = loggingStructure(info, debug);
                struct.propertyStates = [partnerState];

                struct.reportUnmappedStates([master]);

                assert.deepStrictEqual(info, [], 'nothing to report - the dSS hides that input itself');
                const line = debug.find(msg => msg.includes('a35a2900'));
                assert.strictEqual(typeof line, 'string', 'but it is still named');
                assert.ok(line.includes('Rolladen Büro'));
                assert.ok(line.includes('GR-KL300'));
            });

            it('gets the devices from parseData, skipped ones included', done => {
                const info = [];
                const debug = [];
                const struct = loggingStructure(info, debug);
                // a master the adapter skips (not present) still explains its partner
                const absentMaster = Object.assign({}, master, { isPresent: false, isValid: true });
                struct.apartmentStructure = { clusters: [], floors: [], zones: [{ id: 0, devices: [absentMaster] }] };
                struct.reachableGroups = { zones: [] };
                struct.sensorValues = { zones: [] };
                struct.temperatureControlStatus = { zones: [] };
                struct.apartmentCircuits = [];
                struct.propertyStates = [partnerState];
                struct.createUserActions = () => {};
                struct.createApartment = (apt, reachable, callback) => callback();

                struct.parseData(err => {
                    assert.strictEqual(err, null);
                    assert.deepStrictEqual(info, []);
                    assert.strictEqual(
                        debug.some(msg => msg.includes('a35a2900')),
                        true,
                    );
                    done();
                });
            });

            it('keeps reporting the next dSID of a device that is no 2-way master', () => {
                const info = [];
                const debug = [];
                const struct = loggingStructure(info, debug);
                struct.propertyStates = [partnerState, otherPartnerState];

                struct.reportUnmappedStates([Object.assign({}, master, { buttonInputMode: 0 }), otherMaster]);

                assert.strictEqual(info.length, 1, 'a 1-way device hides nothing - this one really is unknown');
                assert.ok(info[0].includes('a35a2900'));
                assert.ok(!info[0].includes('a35af100'), 'the real 2-way partner is still explained');
                assert.strictEqual(
                    debug.some(msg => msg.includes('a35af100')),
                    true,
                );
            });

            it('never explains away a dSUID the structure lists itself', () => {
                const info = [];
                const struct = loggingStructure(info, []);
                struct.propertyStates = [partnerState, otherPartnerState];
                const listedPartner = {
                    dSUID: '302ed89f43f000000000458002a35a2900',
                    name: 'Eingang 2',
                    hwInfo: 'GR-KL300',
                };

                struct.reportUnmappedStates([master, listedPartner, otherMaster]);

                assert.strictEqual(info.length, 1);
                assert.ok(info[0].includes('a35a2900'));
                assert.ok(!info[0].includes('a35af100'));
            });

            it('does not count along name based dSUIDs of vDC devices', () => {
                const info = [];
                const struct = loggingStructure(info, []);
                // one digit above a real vDC dSUID - there is no dSID to count with
                struct.propertyStates = [
                    { name: 'dev.d4b9d12ce8655325c0e4e0e3dc33484900.0' },
                    partnerState,
                    otherPartnerState,
                ];
                const vdc = { dSUID: 'd4b9d12ce8655325c0e4e0e3dc33484800', isVdcDevice: true, buttonInputMode: 10 };
                const vdcShaped = Object.assign({}, master, { isVdcDevice: true });

                struct.reportUnmappedStates([vdc, vdcShaped, otherMaster]);

                assert.strictEqual(info.length, 1);
                assert.ok(info[0].includes('d4b9d12ce8655325c0e4e0e3dc33484900'));
                assert.ok(info[0].includes('a35a2900'));
                assert.ok(!info[0].includes('a35af100'));
            });

            // Every value of ButtonInputMode (dss-mainline modelconst.h) on an even and an
            // odd master, against Device::is2WayMaster() (device.cpp): 6/8/10/12 always,
            // 13/14 only on an even dSID, nothing else
            it('follows Device::is2WayMaster() for every buttonInputMode', () => {
                const always = [6, 8, 10, 12];
                const evenOnly = [13, 14];
                const modes = [0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 65, 255];
                const evenDsuid = master.dSUID; // serial ...02a35a28
                const oddDsuid = '302ed89f43f000000000458002a35a2900';
                const partnerOf = { [evenDsuid]: 'a35a2900', [oddDsuid]: 'a35a2a00' };
                for (const dSUID of [evenDsuid, oddDsuid]) {
                    const even = dSUID === evenDsuid;
                    for (const mode of modes) {
                        const dev = { dSUID, isVdcDevice: false, buttonInputMode: mode };
                        const expected = always.includes(mode) || (even && evenOnly.includes(mode)) ? dev : undefined;
                        assert.strictEqual(
                            DSSStructure.twoWayMasterOf(
                                `dev.302ed89f43f000000000458002${partnerOf[dSUID]}.0`,
                                new Map([[dSUID, dev]]),
                            ),
                            expected,
                            `mode ${mode} on an ${even ? 'even' : 'odd'} dSID`,
                        );
                    }
                }
            });

            it('takes TWO_WAY and ONE_WAY masters only on an even dSID, as the dSS does', () => {
                const odd = { dSUID: '302ed89f43f000000000458002a35a2900', isVdcDevice: false, buttonInputMode: 13 };
                const even = Object.assign({}, master, { buttonInputMode: 14 });
                const devices = new Map([odd, even].map(dev => [dev.dSUID, dev]));

                assert.strictEqual(
                    DSSStructure.twoWayMasterOf('dev.302ed89f43f000000000458002a35a2a00.0', devices),
                    undefined,
                );
                assert.strictEqual(
                    DSSStructure.twoWayMasterOf(
                        'dev.302ed89f43f000000000458002a35a2900.0',
                        new Map([[even.dSUID, even]]),
                    ),
                    even,
                );
            });
        });

        it('survives missing or broken property states', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = undefined;
            assert.doesNotThrow(() => struct.reportUnmappedStates());
            struct.propertyStates = [null, { noName: true }];
            struct.reportUnmappedStates();
            assert.deepStrictEqual(entries, [], 'unusable entries are not reported as missing states');
        });
    });

    // The climate control of a real installation (dSS20 1.19.13) keeps
    // zone.zone<id>.group0.type9.passiveCooling for every room it regulates. It is neither
    // in /usr/states nor among the user-defined states, so it had no object and each
    // threshold crossing ended as "Unhandled State Change".
    describe('sensor states of other dSS apps', () => {
        const passiveCooling = (zoneId, state, groupId = 0) => ({
            name: `zone.zone${zoneId}.group${groupId}.type9.passiveCooling`,
            addon: 'heating-controller',
            zoneId,
            groupId,
            sensorType: 9,
            identifier: 'passiveCooling',
            value: state === 'active' ? 1 : 2,
            state,
        });

        function zoneStructure(entries = []) {
            return createStructure({
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        setImmediate(() => callback(null, { ok: true, result: { scene: 5 } }));
                    },
                },
                adapter: {
                    log: Object.assign({}, silentLogger, { info: msg => entries.push(String(msg)) }),
                    config: {},
                    setState: () => {},
                    setDssState: () => {},
                },
            });
        }

        const duschbad = { id: 4, isPresent: true, isValid: true, name: 'Duschbad', groups: [] };

        it('collectAddonSensorStates keeps the sensor states of other apps only', () => {
            const collected = DSSStructure.collectAddonSensorStates({
                // already apartment.userStates, and would be a second object for the same state
                'system-addon-user-defined-states': {
                    'zone.zone65347.group0.type11.1616436385': {
                        name: 'zone.zone65347.group0.type11.1616436385',
                        value: 2,
                        state: 'inactive',
                    },
                },
                'heating-controller': {
                    'zone.zone4.group0.type9.passiveCooling': {
                        name: 'zone.zone4.group0.type9.passiveCooling',
                        value: 2,
                        state: 'inactive',
                        callOrigin: 9,
                    },
                    // unusable entries of a dSS answer
                    broken: null,
                    alsoBroken: 'text',
                },
                // helper states have no object on purpose
                'system-addon-user-defined-states-helper': {
                    '9be5e52c9e465cd880b6b06494f9dcf600_open-tilded': {
                        name: '9be5e52c9e465cd880b6b06494f9dcf600_open-tilded',
                        value: 2,
                        state: 'inactive',
                    },
                },
                // an entry without a name falls back to its node name
                'some-app': { 'zone.zone2.group0.type9.passiveCooling': { value: 1, state: 'active' } },
                'not-an-app': null,
            });
            assert.deepStrictEqual(collected, [
                {
                    name: 'zone.zone4.group0.type9.passiveCooling',
                    addon: 'heating-controller',
                    zoneId: 4,
                    groupId: 0,
                    sensorType: 9,
                    identifier: 'passiveCooling',
                    value: 2,
                    state: 'inactive',
                    callOrigin: 9,
                },
                {
                    name: 'zone.zone2.group0.type9.passiveCooling',
                    addon: 'some-app',
                    zoneId: 2,
                    groupId: 0,
                    sensorType: 9,
                    identifier: 'passiveCooling',
                    value: 1,
                    state: 'active',
                },
            ]);
            assert.deepStrictEqual(DSSStructure.collectAddonSensorStates(null), []);
        });

        it('collectAddonSensorStates keeps a state the dSS lists under two app ids once', () => {
            // Measured on a dSS20 1.19.13: the climate control appears as
            // system-addon-heating-controller AND as heating-controller, with the same states
            const entry = {
                name: 'zone.zone4.group0.type9.passiveCooling',
                value: 1,
                state: 'active',
                callOrigin: 9,
            };
            const collected = DSSStructure.collectAddonSensorStates({
                'system-addon-heating-controller': { [entry.name]: { ...entry } },
                'heating-controller': { [entry.name]: { ...entry } },
            });
            assert.deepStrictEqual(
                collected.map(state => `${state.addon} ${state.name}`),
                ['system-addon-heating-controller zone.zone4.group0.type9.passiveCooling'],
            );
        });

        it('reads them with a single query2 of /usr/addon-states', async () => {
            const requests = [];
            const struct = createStructure({
                dss: {
                    requestAsync: async (dssClass, dssFunction, params) => {
                        requests.push([dssClass, dssFunction, params]);
                        return {
                            ok: true,
                            result: {
                                'heating-controller': {
                                    'zone.zone4.group0.type9.passiveCooling': {
                                        name: 'zone.zone4.group0.type9.passiveCooling',
                                        value: 1,
                                        state: 'active',
                                    },
                                },
                            },
                        };
                    },
                },
            });
            await struct.readAddonSensorStates();
            assert.deepStrictEqual(requests, [['property', 'query2', { query: '/usr/addon-states/*(*)/*(*)' }]]);
            assert.deepStrictEqual(
                struct.addonSensorStates.map(state => state.name),
                ['zone.zone4.group0.type9.passiveCooling'],
            );
        });

        it('readAddonSensorStates never fails the start', async () => {
            /** @type {string[]} */
            const logged = [];
            const record = level => msg => logged.push(`${level}: ${msg}`);
            let call = 0;
            const struct = createStructure({
                dss: {
                    requestAsync: async () => {
                        call++;
                        if (call === 1) {
                            // a dSS without the node or without query2
                            return { ok: false, message: 'Property not found' };
                        }
                        throw new Error('timeout');
                    },
                },
                adapter: {
                    log: {
                        ...silentLogger,
                        info: record('info'),
                        warn: record('warn'),
                        error: record('error'),
                    },
                    config: {},
                },
            });
            await struct.readAddonSensorStates();
            assert.deepStrictEqual(struct.addonSensorStates, []);
            await struct.readAddonSensorStates();
            assert.strictEqual(call, 2);
            assert.deepStrictEqual(struct.addonSensorStates, []);
            assert.deepStrictEqual(logged, [], 'nothing above debug');
        });

        it('creates passiveCooling next to the zone states, read-only and boolean', done => {
            const entries = [];
            const struct = zoneStructure(entries);
            struct.propertyStates = [{ name: 'zone.4.light', state: 'inactive' }];
            struct.addonSensorStates = [passiveCooling(4, 'active')];
            struct.processZone('apartment.0', duschbad, [], undefined, undefined, () => {
                const id = 'apartment.0.4.states.passiveCooling';
                const obj = struct.dssObjects[id];
                assert.strictEqual(Object.prototype.toString.call(obj), '[object Object]', 'the object exists');
                assert.strictEqual(obj.common.type, 'boolean');
                assert.strictEqual(obj.common.write, false, 'the dSS computes it');
                assert.deepStrictEqual(obj.native, {
                    valueTrue: 'active',
                    valueFalse: 'inactive',
                    dssStateName: 'zone.zone4.group0.type9.passiveCooling',
                });
                assert.strictEqual(obj.onChange, undefined, 'no write handler');
                assert.strictEqual(struct.stateMap['zone.zone4.group0.type9.passiveCooling'], id);
                assert.strictEqual(struct.initialObjectValues[id], 'active', 'a value right after the start');
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.0.4.states.light']),
                    '[object Object]',
                    'the zone state stays',
                );
                // A state with an object must not end up in the line that asks for an issue
                struct.reportUnmappedStates();
                assert.deepStrictEqual(entries, [], 'nothing is reported');
                done();
            });
        });

        // A start whose query2 failed (ECONNRESET, a timeout while the dSS is busy after an
        // update) left the objects of the last start unclaimed: listed as unknown, deleted
        // with "Delete unknown objects" together with their history, and each change asked
        // for a GitHub issue about a state the adapter has an object for.
        it('keeps the objects of the last start when the read failed', async () => {
            const entries = [];
            const struct = zoneStructure(entries);
            struct.dss = {
                requestAsync: async () => {
                    throw new Error('Request error for /json/property/query2: read ECONNRESET');
                },
            };
            const stored = name => ({
                type: 'state',
                common: { type: 'boolean', custom: { 'history.0': { enabled: true } } },
                native: { valueTrue: 'active', valueFalse: 'inactive', dssStateName: name },
            });
            struct.adapter.objectHelper = {
                existingStates: {
                    'apartment.0.4.states.passiveCooling': stored('zone.zone4.group0.type9.passiveCooling'),
                    // the id of the last start stays, suffix included
                    'apartment.0.4.states.motion_type9': stored('zone.zone4.group0.type9.motion'),
                    // another room, a group of this room, and a zone state without a dSS name
                    'apartment.0.2.states.passiveCooling': stored('zone.zone2.group0.type9.passiveCooling'),
                    'apartment.0.4.states.x': stored('zone.zone4.group48.type9.x'),
                    'apartment.0.4.states.light': { type: 'state', common: {}, native: {} },
                },
            };
            await struct.readAddonSensorStates();
            struct.propertyStates = [];
            await new Promise(resolve =>
                struct.processZone('apartment.0', duschbad, [], undefined, undefined, resolve),
            );

            const id = 'apartment.0.4.states.passiveCooling';
            assert.strictEqual(
                Object.prototype.toString.call(struct.dssObjects[id]),
                '[object Object]',
                'not an unknown object',
            );
            assert.strictEqual(struct.dssObjects[id].common.write, false);
            assert.strictEqual(struct.dssObjects[id].native.dssStateName, 'zone.zone4.group0.type9.passiveCooling');
            assert.strictEqual(struct.stateMap['zone.zone4.group0.type9.passiveCooling'], id, 'its events apply');
            assert.strictEqual(struct.stateMap['zone.zone4.group0.type9.motion'], 'apartment.0.4.states.motion_type9');
            assert.ok(!(id in struct.initialObjectValues), 'the last value stays');
            assert.strictEqual(struct.dssObjects['apartment.0.4.states'].type, 'channel', 'its channel');
            assert.ok(!('apartment.0.2.states.passiveCooling' in struct.dssObjects));
            assert.ok(!('apartment.0.4.states.x' in struct.dssObjects));
            assert.ok(!('apartment.0.4.states.light' in struct.dssObjects));
            struct.reportUnmappedStates();
            assert.deepStrictEqual(entries, [], 'nothing is reported');
        });

        // A state the dSS answered without is gone - it stays an unknown object as before
        it('lets a state the dSS no longer reports become unknown when the read worked', async () => {
            const struct = zoneStructure();
            struct.dss = { requestAsync: async () => ({ ok: true, result: { 'heating-controller': {} } }) };
            struct.adapter.objectHelper = {
                existingStates: {
                    'apartment.0.4.states.passiveCooling': {
                        type: 'state',
                        common: { type: 'boolean' },
                        native: { dssStateName: 'zone.zone4.group0.type9.passiveCooling' },
                    },
                },
            };
            await struct.readAddonSensorStates();
            struct.propertyStates = [];
            await new Promise(resolve =>
                struct.processZone('apartment.0', duschbad, [], undefined, undefined, resolve),
            );
            assert.ok(!('apartment.0.4.states.passiveCooling' in struct.dssObjects));
            assert.ok(!('zone.zone4.group0.type9.passiveCooling' in struct.stateMap));
        });

        // The dSS takes the identifier unchecked from the app (zone.addStateSensor()), and
        // js-controller only cleans an object id in setObject - setState keeps the raw one
        it('cleans characters js-controller forbids out of the object id, the dSS name stays the key', done => {
            const struct = zoneStructure();
            struct.propertyStates = [];
            struct.addonSensorStates = DSSStructure.collectAddonSensorStates({
                'third-party-app': {
                    'zone.zone4.group0.type9.too*warm?': {
                        name: 'zone.zone4.group0.type9.too*warm?',
                        value: 1,
                        state: 'active',
                    },
                    'zone.zone4.group0.type9.Wärme': {
                        name: 'zone.zone4.group0.type9.Wärme',
                        value: 2,
                        state: 'inactive',
                    },
                },
            });
            struct.processZone('apartment.0', duschbad, [], undefined, undefined, () => {
                const id = 'apartment.0.4.states.too_warm_';
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects[id]),
                    '[object Object]',
                    'the object exists under the cleaned id',
                );
                assert.deepStrictEqual(
                    Object.keys(struct.dssObjects).filter(key => /[*?]/.test(key)),
                    [],
                );
                assert.strictEqual(struct.stateMap['zone.zone4.group0.type9.too*warm?'], id);
                assert.strictEqual(struct.initialObjectValues[id], 'active');
                // letters of any language are allowed in an id and stay
                assert.strictEqual(struct.stateMap['zone.zone4.group0.type9.Wärme'], 'apartment.0.4.states.Wärme');
                done();
            });
        });

        it('gives a room with only sensor states its states channel', done => {
            const struct = zoneStructure();
            struct.propertyStates = [];
            struct.addonSensorStates = [passiveCooling(4, 'inactive')];
            struct.processZone('apartment.0', duschbad, [], undefined, undefined, () => {
                assert.strictEqual(struct.dssObjects['apartment.0.4.states'].type, 'channel');
                assert.strictEqual(
                    Object.prototype.toString.call(struct.dssObjects['apartment.0.4.states.passiveCooling']),
                    '[object Object]',
                );
                done();
            });
        });

        it('leaves sensor states of other rooms and of groups out of this room', done => {
            const entries = [];
            const struct = zoneStructure(entries);
            struct.propertyStates = [];
            struct.addonSensorStates = [
                passiveCooling(2, 'active'),
                passiveCooling(4, 'active', 48),
                // a zone the dSS reports as not present, skipped on purpose
                passiveCooling(7, 'active'),
            ];
            struct.skippedStatePrefixes.add('zone.7.');
            struct.processZone('apartment.0', duschbad, [], undefined, undefined, () => {
                const ids = Object.keys(struct.dssObjects);
                assert.deepStrictEqual(
                    ids.filter(id => id.includes('passiveCooling')),
                    [],
                );
                assert.deepStrictEqual(
                    ids.filter(id => id.startsWith('apartment.0.2')),
                    [],
                );
                assert.strictEqual(struct.dssObjects['apartment.0.4.states'], undefined, 'no empty states channel');

                struct.reportUnmappedStates();
                assert.strictEqual(entries.length, 1, 'exactly one summary line');
                assert.ok(entries[0].includes('zone.zone4.group48.type9.passiveCooling'));
                assert.ok(entries[0].includes('zone.zone2.group0.type9.passiveCooling'), 'zone 2 was not built here');
                assert.ok(!entries[0].includes('zone.zone7.'), 'a skipped zone is not reported');
                done();
            });
        });

        it('does not ask for an issue about a sensor state of a group processZone skipped', done => {
            const entries = [];
            const debug = [];
            const struct = zoneStructure(entries);
            struct.adapter.log.debug = msg => debug.push(String(msg));
            struct.propertyStates = [];
            struct.addonSensorStates = [passiveCooling(4, 'active', 48)];
            // group 48 is not reachable, so processZone skips it on purpose
            const zone = { ...duschbad, groups: [{ id: 48, devices: [] }] };
            struct.processZone('apartment.0', zone, [], undefined, undefined, () => {
                assert.strictEqual(struct.skippedStatePrefixes.has('zone.4.group.48.'), true);
                struct.reportUnmappedStates();
                assert.ok(!entries.join('\n').includes('zone.zone4.group48.'), 'no info line asks for an issue');
                assert.strictEqual(
                    debug.some(msg => /^1 DSS state\(s\) belong to zones or groups this adapter skipped/.test(msg)),
                    true,
                );
                done();
            });
        });

        it('a sensor state named like a zone state does not overwrite it', done => {
            const struct = zoneStructure();
            struct.propertyStates = [{ name: 'zone.4.motion', state: 'inactive' }];
            struct.addonSensorStates = [
                {
                    name: 'zone.zone4.group0.type9.motion',
                    addon: 'some-app',
                    zoneId: 4,
                    groupId: 0,
                    sensorType: 9,
                    identifier: 'motion',
                    value: 1,
                    state: 'active',
                },
            ];
            struct.processZone('apartment.0', duschbad, [], undefined, undefined, () => {
                assert.strictEqual(struct.stateMap['zone.4.motion'], 'apartment.0.4.states.motion');
                assert.strictEqual(
                    struct.stateMap['zone.zone4.group0.type9.motion'],
                    'apartment.0.4.states.motion_type9',
                );
                const sensor = struct.dssObjects['apartment.0.4.states.motion_type9'];
                assert.strictEqual(sensor.common.type, 'boolean');
                assert.strictEqual(sensor.common.write, false);
                assert.strictEqual(
                    typeof struct.dssObjects['apartment.0.4.states.motion'].onChange,
                    'function',
                    'the zone state is kept',
                );
                done();
            });
        });
    });

    describe('instance isolation', () => {
        // Regression: this.groupTypes referenced the shared constants object, so a cluster
        // name of one apartment leaked into every other instance of the same process.
        it('gives every structure its own group type map', () => {
            const originalName = dssConstants.groupTypes[16];
            const first = createStructure();
            const second = createStructure();

            first.groupTypes[16] = 'Cluster Erdgeschoss';
            assert.strictEqual(second.groupTypes[16], originalName, 'a second instance must not see it');
            assert.strictEqual(dssConstants.groupTypes[16], originalName, 'the module constants must stay untouched');
        });

        it('keeps two apartments with the same cluster id apart', () => {
            const first = createStructure();
            const second = createStructure();
            first.apartmentStructure = {
                clusters: [{ id: 16, name: 'Rollladen Nord' }],
                floors: [],
                zones: [],
            };
            second.apartmentStructure = {
                clusters: [{ id: 16, name: 'Rollladen Sued' }],
                floors: [],
                zones: [],
            };
            // parseData aborts without zone 0, the cluster merge happens before that
            first.parseData(() => {});
            second.parseData(() => {});

            assert.strictEqual(first.groupTypes[16], 'Rollladen Nord');
            assert.strictEqual(second.groupTypes[16], 'Rollladen Sued');
            assert.strictEqual(dssConstants.groupTypes[16], undefined, 'no global mutation');
        });
    });

    describe('expected queue errors', () => {
        function loggingStructure(levels) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        debug: () => levels.push('debug'),
                        info: () => levels.push('info'),
                        warn: () => levels.push('warn'),
                    }),
                    config: {},
                },
            });
        }

        // Regression: a coalesced write produced
        // "Error while set State for apartment-user: SupersededError: ..." as a warning,
        // although replacing a not yet sent value is normal last-write-wins behaviour.
        it('reports a superseded request as debug, not as warning', () => {
            const levels = [];
            loggingStructure(levels).logQueueError(
                'Error while set State for apartment-user',
                new DSSQueue.SupersededError('Request was superseded by a newer value'),
            );
            assert.deepStrictEqual(levels, ['debug']);
        });

        it('still warns about a real DSS error', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Error while set State for apartment-user', new Error('HTTP 500'));
            assert.deepStrictEqual(levels, ['warn']);
        });

        it('still warns when the DSS answered with ok=false and no error object', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Error while callScene for group: {"ok":false}', undefined);
            assert.deepStrictEqual(levels, ['warn']);
        });

        it('treats a superseded output write as expected', () => {
            const levels = [];
            loggingStructure(levels).logOutputWriteError(
                { dSUID: 'dev1' },
                new DSSQueue.SupersededError('superseded by a newer value'),
            );
            assert.deepStrictEqual(levels, ['debug']);
        });

        it('does not burn the "reported once" slot of an output read on a shutdown', () => {
            const levels = [];
            const struct = loggingStructure(levels);
            const shutdownErr = Object.assign(new Error('Queue cleared'), { shutdown: true });
            struct.logOutputReadError({ dSUID: 'dev1' }, 'brightness', shutdownErr);
            assert.deepStrictEqual(levels, ['debug'], 'a stop is not a device property');
            // The real report must still be possible afterwards
            struct.logOutputReadError({ dSUID: 'dev1' }, 'brightness', new Error('HTTP 500'));
            assert.deepStrictEqual(levels, ['debug', 'info']);
        });
    });
});

describe('DSSStructure names and meter values', () => {
    it('shows a name the dSS still stores with HTML codes with the real characters', () => {
        const struct = /** @type {any} */ (createStructure());
        // Measured on a real installation with 2.4.26: three circuit folders kept
        // "Büro &amp; Duschbad" after the start, because getCircuits itself still
        // answered with the codes old firmware stored
        struct.addFolderObject('devices.302ed89f43f0000000000e400000ff4300', 'Büro &amp; Duschbad');
        struct.addFolderObject('apartment.0.5', 'Eltern&#039;s Zimmer', 'folder');
        struct.addFolderObject('devices.m3', 'Küche');
        assert.strictEqual(
            struct.dssObjects['devices.302ed89f43f0000000000e400000ff4300'].common.name,
            'Büro & Duschbad',
        );
        assert.strictEqual(struct.dssObjects['apartment.0.5'].common.name, "Eltern's Zimmer");
        assert.strictEqual(struct.dssObjects['devices.m3'].common.name, 'Küche');
    });

    it('decodes state names once and never touches the id', () => {
        const struct = /** @type {any} */ (createStructure());
        struct.addStateObject('apartment.userStates.1617871548', 'user.1617871548', {
            name: 'Garten &amp;amp; Hof &lt;Süd&gt;',
            type: 'string',
            role: 'indicator',
        });
        const obj = struct.dssObjects['apartment.userStates.1617871548'];
        assert.strictEqual(obj.common.name, 'Garten &amp; Hof <Süd>', 'one pass: a literal "&amp;" stays one');
        assert.strictEqual(struct.stateMap['user.1617871548'], 'apartment.userStates.1617871548');
    });

    it('rounds the meter reading to whole watt hours', () => {
        // 4009.7331175000004 kWh was written before, measured on a real installation
        assert.strictEqual(DSSStructure.wattSecondsToKwh(14435039223), 4009.733);
        assert.strictEqual(DSSStructure.wattSecondsToKwh(637899639), 177.194);
        assert.strictEqual(DSSStructure.wattSecondsToKwh(3600000), 1);
        assert.strictEqual(DSSStructure.wattSecondsToKwh(0), 0);
        assert.strictEqual(String(DSSStructure.wattSecondsToKwh(1800)), '0.001', 'half a watt hour rounds up');
    });

    describe('meter polls', () => {
        /**
         * @param {Record<string, {consumption: number, meterValue: number}>} readings
         * @returns {any} structure whose meter reads answer from readings
         */
        function meterStructure(readings) {
            const writes = [];
            const struct = /** @type {any} */ (
                createStructure({
                    dssQueue: {
                        pushQueryQueue: (dSUID, entryId, entry, prio, callback) => {
                            const reading = readings[dSUID];
                            const result =
                                entryId === 'getConsumption'
                                    ? { consumption: reading.consumption }
                                    : { meterValue: reading.meterValue };
                            setImmediate(() => callback(null, { ok: true, result }));
                        },
                    },
                    adapter: {
                        log: silentLogger,
                        config: {},
                        setState: () => {},
                        setDssState: (id, value) => {
                            writes.push([id, value]);
                            struct.notePublishedValue(id, value);
                        },
                    },
                })
            );
            struct.apartmentCircuits = [{ hasMetering: true, dSUID: 'meter1' }];
            struct.objectsReady = true;
            struct.writes = writes;
            return struct;
        }

        const poll = struct => new Promise(resolve => struct.updateMeterData(() => resolve(undefined)));

        it('writes a reading once and skips the unchanged repeats', async () => {
            const readings = { meter1: { consumption: 0, meterValue: 14435039223 } };
            const struct = meterStructure(readings);
            await poll(struct);
            await poll(struct);
            // 300 Ws more is less than a tenth of a watt hour - the rounded total stays
            readings.meter1.meterValue += 300;
            await poll(struct);
            assert.deepStrictEqual(struct.writes, [
                ['devices.meter1.PowerConsumption', 0],
                ['devices.meter1.EnergyMeterValue', 4009.733],
            ]);
            readings.meter1.consumption = 120;
            readings.meter1.meterValue += 3600;
            await poll(struct);
            assert.deepStrictEqual(struct.writes.slice(2), [
                ['devices.meter1.PowerConsumption', 120],
                ['devices.meter1.EnergyMeterValue', 4009.734],
            ]);
        });

        it('writes again when someone else changed the state in between', async () => {
            const struct = meterStructure({ meter1: { consumption: 30, meterValue: 3600000 } });
            await poll(struct);
            // the acknowledged echo of a foreign write lands in publishedValues, under the id
            // without namespace - onStateChange strips it, see testAdapter.js
            struct.notePublishedValue('devices.meter1.PowerConsumption', 999);
            await poll(struct);
            assert.deepStrictEqual(
                struct.writes.filter(w => w[0] === 'devices.meter1.PowerConsumption'),
                [
                    ['devices.meter1.PowerConsumption', 30],
                    ['devices.meter1.PowerConsumption', 30],
                ],
            );
        });
    });
});
