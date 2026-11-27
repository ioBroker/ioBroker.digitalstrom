const { expect } = require('chai');

const DSSQueue = require('../lib/dssQueue');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Tiny prio timeouts so the tests run fast
function createQueue(dss, logger) {
    return new DSSQueue({
        logger: logger || silentLogger,
        prioTimeouts: { high: 1, medium: 2, low: 3 },
        dss,
    });
}

const DEV = { dSUID: 'dev1', meterDSUID: 'meter1' };

describe('DSSQueue', () => {
    it('processes an entry and calls the callback with the result', done => {
        const dss = {
            requestAsync: async (dssClass, dssFunction) => ({ ok: true, result: { dssClass, dssFunction } }),
        };
        const queue = createQueue(dss);
        queue.pushQueryQueue('c1', 'e1', { dssClass: 'a', dssFunction: 'b', params: {} }, 'high', (err, res) => {
            expect(err).to.equal(null);
            expect(res.result.dssClass).to.equal('a');
            done();
        });
    });

    it('processes entries in priority order', done => {
        const order = [];
        const dss = {
            requestAsync: async dssClass => {
                order.push(dssClass);
                return { ok: true };
            },
        };
        const queue = createQueue(dss);
        let doneCount = 3;
        const finish = () => {
            if (--doneCount) {
                return;
            }
            expect(order).to.deep.equal(['high', 'medium', 'low']);
            done();
        };
        queue.pushQueryQueue('c1', 'eLow', { dssClass: 'low', dssFunction: 'f', params: {} }, 'low', finish);
        queue.pushQueryQueue('c1', 'eMed', { dssClass: 'medium', dssFunction: 'f', params: {} }, 'medium', finish);
        queue.pushQueryQueue('c1', 'eHigh', { dssClass: 'high', dssFunction: 'f', params: {} }, 'high', finish);
    });

    it('merges identical read requests into one request', done => {
        let requestCount = 0;
        const dss = {
            requestAsync: async () => {
                requestCount++;
                return { ok: true, result: { value: 5 } };
            },
        };
        const queue = createQueue(dss);
        let callbackCount = 0;
        const finish = err => {
            expect(err).to.equal(null);
            if (++callbackCount === 2) {
                expect(requestCount).to.equal(1);
                done();
            }
        };
        queue.queueUpdateOutputValue(DEV, 0, 255, 'medium', finish);
        queue.queueUpdateOutputValue(DEV, 0, 255, 'medium', finish);
    });

    it('releases the queue after an error so further entries are processed', done => {
        let first = true;
        const dss = {
            requestAsync: async () => {
                if (first) {
                    first = false;
                    throw new Error('boom');
                }
                return { ok: true };
            },
        };
        const queue = createQueue(dss);
        queue.pushQueryQueue('c1', 'fail', { dssClass: 'a', dssFunction: 'b', params: {} }, 'high', err => {
            expect(err).to.be.an('error');
            expect(err.message).to.equal('boom');
        });
        queue.pushQueryQueue('c1', 'ok', { dssClass: 'a', dssFunction: 'c', params: {} }, 'high', (err, res) => {
            expect(err).to.equal(null);
            expect(res.ok).to.equal(true);
            done();
        });
    });

    it('fails pending callbacks exactly once when the queue is cleared', done => {
        let resolveRequest;
        const dss = {
            requestAsync: () =>
                new Promise(resolve => {
                    resolveRequest = resolve;
                }),
        };
        const queue = createQueue(dss);
        let calls = 0;
        queue.pushQueryQueue('c1', 'inflight', { dssClass: 'a', dssFunction: 'b', params: {} }, 'high', err => {
            calls++;
            expect(err).to.be.an('error');
            expect(err.message).to.equal('Queue cleared');
            expect(err.shutdown, 'callers must be able to recognize the stop').to.equal(true);
        });
        setTimeout(() => {
            queue.clearQueues();
            // let the in-flight request settle afterwards - the callback must not fire again
            resolveRequest && resolveRequest({ ok: true });
            setTimeout(() => {
                expect(calls).to.equal(1);
                done();
            }, 30);
        }, 30);
    });

    it('reports a request aborted by the stop as debug, not as warning', done => {
        const levels = [];
        const logger = {
            silly: () => {},
            debug: () => levels.push('debug'),
            info: () => {},
            warn: () => levels.push('warn'),
            error: () => {},
        };
        /** @type {import('../lib/configUtils').AdapterError} */
        const shutdownError = new Error('Request error for /json/zone/getLastCalledScene: socket hang up');
        shutdownError.shutdown = true;
        const queue = createQueue({ requestAsync: async () => Promise.reject(shutdownError) }, logger);
        queue.pushQueryQueue(
            'c1',
            'e1',
            { dssClass: 'zone', dssFunction: 'getLastCalledScene', params: {} },
            'high',
            err => {
                expect(err).to.equal(shutdownError);
                expect(levels, 'a stop must not produce warnings').to.not.include('warn');
                expect(levels).to.include('debug');
                done();
            },
        );
    });

    it('does not warn when a best effort output read fails', done => {
        const levels = [];
        const logger = {
            silly: () => {},
            debug: () => levels.push('debug'),
            info: () => {},
            warn: () => levels.push('warn'),
            error: () => {},
        };
        // A blind without tilt answers the angle parameter with HTTP 500 - the value is
        // re-read after every scene, so this must not produce a warning every time
        const queue = createQueue(
            { requestAsync: async () => Promise.reject(new Error('HTTP 500 for /json/device/getConfig')) },
            logger,
        );
        queue.queueUpdateOutputValue(DEV, 4, 255, 'medium', err => {
            expect(err, 'the caller still learns about the failure').to.be.an('error');
            expect(levels, 'the queue must stay quiet here').to.not.include('warn');
            expect(levels).to.include('debug');
            done();
        });
    });

    it('still warns about a real request error', done => {
        const levels = [];
        const logger = {
            silly: () => {},
            debug: () => levels.push('debug'),
            info: () => {},
            warn: () => levels.push('warn'),
            error: () => {},
        };
        const queue = createQueue({ requestAsync: async () => Promise.reject(new Error('boom')) }, logger);
        queue.pushQueryQueue(
            'c1',
            'e1',
            { dssClass: 'zone', dssFunction: 'getLastCalledScene', params: {} },
            'high',
            () => {
                expect(levels).to.include('warn');
                done();
            },
        );
    });

    describe('stop handling', () => {
        it('rejects new entries after stop() instead of queueing them', done => {
            let requests = 0;
            const queue = createQueue({
                requestAsync: async () => {
                    requests++;
                    return { ok: true };
                },
            });
            queue.stop();
            queue.pushQueryQueue(
                'c1',
                'e1',
                { dssClass: 'zone', dssFunction: 'callScene', params: {} },
                'high',
                err => {
                    expect(err, 'the caller must be answered').to.be.an('error');
                    expect(err.shutdown, 'recognizable as a stop').to.equal(true);
                    setTimeout(() => {
                        expect(requests, 'nothing may be sent to the DSS after stop()').to.equal(0);
                        expect(queue.queryQueue.c1 || [], 'no entry may be queued').to.deep.equal([]);
                        done();
                    }, 20);
                },
            );
        });

        it('creates no new timer after stop()', done => {
            const queue = createQueue({ requestAsync: async () => ({ ok: true }) });
            queue.stop();
            queue.pushQueryQueue(
                'c1',
                'e1',
                { dssClass: 'zone', dssFunction: 'callScene', params: {} },
                'high',
                () => {},
            );
            setTimeout(() => {
                const timers = Object.values(queue.nextEntryTimeout).filter(Boolean);
                expect(timers, 'no timer may outlive the unload').to.deep.equal([]);
                done();
            }, 20);
        });

        it('is idempotent and answers waiting entries exactly once', done => {
            let resolveRequest;
            const queue = createQueue({
                requestAsync: () =>
                    new Promise(resolve => {
                        resolveRequest = resolve;
                    }),
            });
            let calls = 0;
            queue.pushQueryQueue('c1', 'inflight', { dssClass: 'a', dssFunction: 'b', params: {} }, 'high', () => {
                calls++;
            });
            queue.pushQueryQueue('c1', 'waiting', { dssClass: 'a', dssFunction: 'c', params: {} }, 'low', () => {
                calls++;
            });
            setTimeout(() => {
                queue.stop();
                queue.stop();
                queue.stop();
                resolveRequest && resolveRequest({ ok: true });
                setTimeout(() => {
                    expect(calls, 'every caller answered exactly once').to.equal(2);
                    expect(queue.stopped).to.equal(true);
                    done();
                }, 30);
            }, 30);
        });

        it('accepts entries again only after a fresh queue is created', done => {
            const queue = createQueue({ requestAsync: async () => ({ ok: true }) });
            queue.pushQueryQueue('c1', 'e1', { dssClass: 'a', dssFunction: 'b', params: {} }, 'high', err => {
                expect(err).to.equal(null);
                // the same queue stays closed afterwards
                queue.stop();
                queue.pushQueryQueue('c1', 'e2', { dssClass: 'a', dssFunction: 'c', params: {} }, 'high', err2 => {
                    expect(err2.shutdown).to.equal(true);
                    done();
                });
            });
        });
    });

    describe('write coalescing', () => {
        it('never reports success for a value that was not sent (pending 10 -> 80)', done => {
            const sent = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push(params.value);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            const acked = [];
            queue.queueSetOutputValue(DEV, 0, 255, 10, 'high', (err, value) => {
                if (!err) {
                    acked.push(value);
                }
                expect(err && err.superseded, 'old value must be marked as superseded').to.equal(true);
            });
            queue.queueSetOutputValue(DEV, 0, 255, 80, 'high', (err, value) => {
                expect(err).to.equal(null);
                acked.push(value);
                setTimeout(() => {
                    // Only the newest value is sent and only that one is acknowledged
                    expect(sent).to.deep.equal([80]);
                    expect(acked).to.deep.equal([80]);
                    done();
                }, 30);
            });
        });

        it('keeps a new value that arrives while an older one is in flight', done => {
            const sent = [];
            let releaseFirst;
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push(params.value);
                    if (sent.length === 1) {
                        await new Promise(resolve => (releaseFirst = resolve));
                    }
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            queue.queueSetOutputValue(DEV, 0, 255, 10, 'high', err => expect(err).to.equal(null));

            setTimeout(() => {
                expect(sent, 'first value must be in flight').to.deep.equal([10]);
                queue.queueSetOutputValue(DEV, 0, 255, 80, 'high', (err, value) => {
                    expect(err).to.equal(null);
                    expect(value).to.equal(80);
                    expect(sent, 'both values must reach the DSS').to.deep.equal([10, 80]);
                    done();
                });
                releaseFirst();
            }, 30);
        });

        it('does not coalesce different scenes', done => {
            const scenes = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    scenes.push(params.sceneNumber);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            let open = 2;
            const finish = () => {
                if (--open) {
                    return;
                }
                expect(scenes).to.have.members([13, 14]);
                done();
            };
            const scene = number => ({
                dssClass: 'device',
                dssFunction: 'callScene',
                params: { dsuid: 'dev1', sceneNumber: number, category: 'manual' },
            });
            queue.pushQueryQueue('meter1', scene(14), 'high', finish);
            queue.pushQueryQueue('meter1', scene(13), 'high', finish);
        });

        // Regression: a pending write used to absorb a later identical write even though
        // another command was queued in between - on, off, on ended up off.
        // Regression: a waiting write used to absorb a later one although another command
        // was queued in between - state true, false, true ended false. The merged entry
        // now moves to the end of the queue, which keeps the order AND the coalescing.
        describe('keeps the command order', () => {
            const scene = number => ({
                dssClass: 'device',
                dssFunction: 'callScene',
                params: { dsuid: 'dev1', sceneNumber: number, category: 'manual' },
            });
            const brightness = value => ({
                dssClass: 'device',
                dssFunction: 'setValue',
                params: { dsuid: 'dev1', value },
            });
            const read = () => ({
                dssClass: 'device',
                dssFunction: 'getOutputValue',
                params: { dsuid: 'dev1', offset: 0 },
            });
            const write = (dsuid, value) => ({ dssClass: 'device', dssFunction: 'setValue', params: { dsuid, value } });

            /**
             * Pushes every entry and compares the API calls that really went out.
             * The comparison must NOT happen inside the queue callback: runCallbacks
             * swallows callback errors, a failing expect would only show up as a timeout.
             *
             * @param {object[]} entries entries to push, in that order
             * @param {string[]} expected the requests that must reach the dSS, in order
             * @param {(err?: Error) => void} done mocha callback
             */
            function runSequence(entries, expected, done) {
                const sent = [];
                const dss = {
                    requestAsync: async (dssClass, dssFunction, params) => {
                        const value = params.sceneNumber !== undefined ? params.sceneNumber : params.value;
                        sent.push(`${params.dsuid}:${dssFunction}:${value === undefined ? '' : value}`);
                        return { ok: true };
                    },
                };
                const queue = createQueue(dss);
                let open = entries.length;
                const finish = () => {
                    if (--open) {
                        return;
                    }
                    setImmediate(() => {
                        try {
                            expect(sent).to.deep.equal(expected);
                        } catch (err) {
                            return done(/** @type {Error} */ (err));
                        }
                        done();
                    });
                };
                entries.forEach(entry => queue.pushQueryQueue('meter1', entry, 'high', finish));
            }

            it('on -> off -> on ends on', done => {
                // the repeated "on" is answered by the single send at the end
                runSequence([scene(5), scene(0), scene(5)], ['dev1:callScene:0', 'dev1:callScene:5'], done);
            });

            it('brightness 50 -> off -> brightness 75 ends at 75', done => {
                runSequence(
                    [brightness(127), scene(0), brightness(191)],
                    ['dev1:callScene:0', 'dev1:setValue:191'],
                    done,
                );
            });

            it('still merges identical reads into one request, answered after the write', done => {
                runSequence([read(), scene(0), read()], ['dev1:callScene:0', 'dev1:getOutputValue:'], done);
            });

            // The order must not cost the coalescing: with a command of another device in
            // between, a moving slider must still end up as ONE request
            it('coalesces a moving value behind a command of another device', done => {
                const entries = [write('dev1', 1), write('dev2', 99)];
                for (let i = 2; i <= 10; i++) {
                    entries.push(write('dev1', i));
                }
                runSequence(entries, ['dev2:setValue:99', 'dev1:setValue:10'], done);
            });

            // The worst case of the first attempt: two targets of one circuit changing
            // alternately (position and angle of one blind, or two dimmers on one meter)
            // used to defeat the coalescing completely - every single step was sent
            it('coalesces two targets of one circuit that change alternately', done => {
                const entries = [];
                for (let i = 1; i <= 10; i++) {
                    entries.push(write('dev1', i), write('dev2', i));
                }
                runSequence(entries, ['dev1:setValue:10', 'dev2:setValue:10'], done);
            });
        });
    });

    // Regression: every new entry restarted the idle wait, so a slider moving every 100 ms
    // sent nothing at all until it stopped.
    describe('bounded wait under continuous changes', () => {
        const sinon = require('sinon');
        let clock;
        beforeEach(() => {
            clock = sinon.useFakeTimers({ now: 100000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        });
        afterEach(() => clock.restore());

        it('sends while changes keep arriving, and a waiting command of another device too', async () => {
            const sent = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push({ at: Date.now(), dsuid: params.dsuid, value: params.value });
                    return { ok: true };
                },
            };
            const queue = new DSSQueue({
                logger: silentLogger,
                prioTimeouts: { high: 500, medium: 10000, low: 20000 },
                dss,
            });
            const start = Date.now();
            const noop = () => {};
            queue.pushQueryQueue(
                'meter1',
                { dssClass: 'device', dssFunction: 'callScene', params: { dsuid: 'dev2', sceneNumber: 5 } },
                'high',
                noop,
            );
            for (let i = 1; i <= 20; i++) {
                await clock.tickAsync(100);
                queue.pushQueryQueue(
                    'meter1',
                    { dssClass: 'device', dssFunction: 'setValue', params: { dsuid: 'dev1', value: i } },
                    'high',
                    noop,
                );
            }
            // 2 s of changes: the other device went out after its 500 ms, the slider follows
            expect(sent[0]).to.include({ dsuid: 'dev2', at: start + 500 });
            const sliderSends = sent.filter(item => item.dsuid === 'dev1');
            expect(sliderSends.length, 'slider values sent during the changes').to.be.at.least(2);
            for (let i = 1; i < sent.length; i++) {
                expect(sent[i].at - sent[i - 1].at, 'minimum spacing').to.be.at.least(500);
            }
            await clock.tickAsync(1000);
            expect(sent[sent.length - 1].value, 'last value arrives').to.equal(20);
        });
    });

    describe('re-entrant coalescing', () => {
        // Regression: the superseded callbacks used to run BEFORE the entry was replaced.
        // A callback that synchronously enqueued a newer value for the same target was
        // overwritten again by the outer (older) call - the newest value never reached the DSS.
        it('keeps a value that is enqueued from within a superseded callback (10 -> 90 -> 80)', done => {
            const sent = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push(params.value);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            const events = [];

            queue.queueSetOutputValue(DEV, 0, 255, 10, 'high', err => {
                events.push(['cb10', err && err.name]);
                // A slider that keeps moving: the next value arrives synchronously
                queue.queueSetOutputValue(DEV, 0, 255, 80, 'high', innerErr => {
                    events.push(['cb80', innerErr && innerErr.name]);
                });
            });
            queue.queueSetOutputValue(DEV, 0, 255, 90, 'high', err => {
                events.push(['cb90', err && err.name]);
            });

            setTimeout(() => {
                expect(sent, 'only the newest value must reach the DSS').to.deep.equal([80]);
                expect(events, 'every callback exactly once, in order').to.deep.equal([
                    ['cb10', 'SupersededError'],
                    ['cb90', 'SupersededError'],
                    ['cb80', null],
                ]);
                done();
            }, 40);
        });

        it('calls every callback exactly once even with several re-enqueues', done => {
            const sent = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push(params.value);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            const counts = {};
            const count = name => {
                counts[name] = (counts[name] || 0) + 1;
            };

            let chain = 0;
            const push = value => {
                queue.queueSetOutputValue(DEV, 0, 255, value, 'high', () => {
                    count(`cb${value}`);
                    if (chain++ < 3) {
                        push(value + 10);
                    }
                });
            };
            push(10);
            queue.queueSetOutputValue(DEV, 0, 255, 99, 'high', () => count('cb99'));

            setTimeout(() => {
                expect(Object.keys(counts).sort(), 'no callback may get lost').to.deep.equal([
                    'cb10',
                    'cb20',
                    'cb30',
                    'cb40',
                    'cb99',
                ]);
                Object.keys(counts).forEach(name =>
                    expect(counts[name], `${name} must be called exactly once`).to.equal(1),
                );
                // 10 and 99 were superseded before they were sent, everything after that was
                // enqueued only once the previous value had really been sent
                expect(sent, 'no superseded value may reach the DSS').to.deep.equal([20, 30, 40]);
                done();
            }, 60);
        });

        it('sends a value that was never superseded unchanged', done => {
            const sent = [];
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    sent.push(params.value);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            queue.queueSetOutputValue(DEV, 0, 255, 55, 'high', (err, value) => {
                expect(err).to.equal(null);
                expect(value).to.equal(55);
                expect(sent).to.deep.equal([55]);
                done();
            });
        });
    });

    describe('expected queue errors', () => {
        it('classifies superseded and shutdown as expected, real errors as not', () => {
            const superseded = new DSSQueue.SupersededError('x');
            const shutdown = Object.assign(new Error('Queue cleared'), { shutdown: true });
            expect(DSSQueue.isExpectedQueueError(superseded)).to.equal(true);
            expect(DSSQueue.isExpectedQueueError(shutdown)).to.equal(true);
            expect(DSSQueue.isExpectedQueueError(new Error('HTTP 500'))).to.equal(false);
            expect(DSSQueue.isExpectedQueueError(null)).to.equal(false);
            expect(DSSQueue.isExpectedQueueError(undefined)).to.equal(false);
        });

        it('never logs a superseded write as warning or error', done => {
            const levels = [];
            const logger = {
                silly: () => {},
                debug: () => levels.push('debug'),
                info: () => levels.push('info'),
                warn: () => levels.push('warn'),
                error: () => levels.push('error'),
            };
            const dss = { requestAsync: async () => ({ ok: true }) };
            const queue = createQueue(dss, logger);

            queue.queueSetOutputValue(DEV, 0, 255, 10, 'high', err => {
                expect(err.name).to.equal('SupersededError');
            });
            queue.queueSetOutputValue(DEV, 0, 255, 80, 'high', err => {
                expect(err).to.equal(null);
                setTimeout(() => {
                    expect(levels, 'a coalesced write is not a failure').to.not.include('warn');
                    expect(levels).to.not.include('error');
                    done();
                }, 30);
            });
        });
    });

    describe('callback isolation', () => {
        it('a throwing callback stops neither the other callbacks nor the queue', done => {
            const dss = { requestAsync: async () => ({ ok: true }) };
            const logged = [];
            const queue = createQueue(dss, { ...silentLogger, error: msg => logged.push(msg) });
            let secondCalled = false;

            const entry = { dssClass: 'a', dssFunction: 'b', params: { id: 1 } };
            queue.pushQueryQueue('c1', 'same', entry, 'high', () => {
                throw new Error('callback exploded');
            });
            queue.pushQueryQueue('c1', 'same', { ...entry }, 'high', () => {
                secondCalled = true;
            });

            // The next entry has to be processed even though the first callback threw
            queue.pushQueryQueue('c1', 'next', { dssClass: 'a', dssFunction: 'c', params: {} }, 'high', err => {
                expect(err).to.equal(null);
                expect(secondCalled, 'second callback of the same entry must run').to.equal(true);
                expect(logged.join(' ')).to.contain('callback exploded');
                done();
            });
        });
    });

    describe('createRequestKey', () => {
        it('distinguishes a valid 0 from undefined', () => {
            const withZero = DSSQueue.createRequestKey({
                dssClass: 'device',
                dssFunction: 'getConfig',
                params: { dsuid: 'a', index: 0 },
            });
            const withUndefined = DSSQueue.createRequestKey({
                dssClass: 'device',
                dssFunction: 'getConfig',
                params: { dsuid: 'a', index: undefined },
            });
            expect(withZero).to.not.equal(withUndefined);
        });

        it('distinguishes different channels and different functions', () => {
            const base = { dssClass: 'device', dssFunction: 'getConfig', params: { dsuid: 'a', index: 0 } };
            const otherChannel = { ...base, params: { dsuid: 'a', index: 2 } };
            const otherFunction = { ...base, dssFunction: 'setConfig' };
            const otherDevice = { ...base, params: { dsuid: 'b', index: 0 } };
            const keys = [base, otherChannel, otherFunction, otherDevice].map(e => DSSQueue.createRequestKey(e));
            expect(new Set(keys).size).to.equal(4);
        });

        it('ignores the payload only for the coalescing key', () => {
            const a = { dssClass: 'device', dssFunction: 'setValue', params: { dsuid: 'a', value: 10 } };
            const b = { dssClass: 'device', dssFunction: 'setValue', params: { dsuid: 'a', value: 80 } };
            expect(DSSQueue.createRequestKey(a, true)).to.equal(DSSQueue.createRequestKey(b, true));
            expect(DSSQueue.createRequestKey(a)).to.not.equal(DSSQueue.createRequestKey(b));
        });
    });

    describe('queueSetOutputValue signatures', () => {
        it('never sends the priority string as output value (legacy signature)', done => {
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    expect(params.value, 'priority must never be sent as value').to.not.equal('high');
                    expect(params.value).to.equal(42);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            // legacy call form (dev, index, value, prio, callback)
            queue.queueSetOutputValue(DEV, 0, 42, 'high', (err, value) => {
                expect(err).to.equal(null);
                expect(value).to.equal(42);
                done();
            });
        });

        it('sends the value with the current signature', done => {
            const dss = {
                requestAsync: async (dssClass, dssFunction, params) => {
                    expect(params.value).to.equal(200);
                    return { ok: true };
                },
            };
            const queue = createQueue(dss);
            queue.queueSetOutputValue(DEV, 0, 255, 200, 'high', err => {
                expect(err).to.equal(null);
                done();
            });
        });
    });
});
