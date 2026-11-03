const sinon = require('sinon');
const { expect } = require('chai');
const DSS = require('../lib/dss');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createDss(overrides) {
    return new DSS({ host: 'localhost', appToken: 'app', logger: silentLogger, ...overrides });
}

describe('DSS', () => {
    describe('host normalization', () => {
        const cases = [
            ['10.0.0.1', 'https://10.0.0.1:8080'],
            ['10.0.0.1:8080', 'https://10.0.0.1:8080'],
            ['10.0.0.1:443', 'https://10.0.0.1:443'],
            ['https://10.0.0.1:8080', 'https://10.0.0.1:8080'],
            ['https://dss.local', 'https://dss.local:8080'],
            ['dss.local', 'https://dss.local:8080'],
            ['dss.local:9000', 'https://dss.local:9000'],
            ['  dss.local  ', 'https://dss.local:8080'],
            ['[::1]:8080', 'https://[::1]:8080'],
            ['[2001:db8::1]', 'https://[2001:db8::1]:8080'],
            ['2001:db8::1', 'https://[2001:db8::1]:8080'],
            ['http://10.0.0.1:8080', 'http://10.0.0.1:8080'],
            // Regression: a trailing slash used to hide the explicit port, so an explicitly
            // configured default port (443/80) was silently replaced by the DSS default 8080
            ['https://dss.local:443/', 'https://dss.local:443'],
            ['https://dss.local:443', 'https://dss.local:443'],
            ['http://dss.local:80/', 'http://dss.local:80'],
            ['http://dss.local:80', 'http://dss.local:80'],
            ['https://[::1]:443/', 'https://[::1]:443'],
            ['https://[2001:db8::1]:443/', 'https://[2001:db8::1]:443'],
            ['https://10.0.0.1:443/', 'https://10.0.0.1:443'],
            // A trailing slash must not change anything else either
            ['https://dss.local/', 'https://dss.local:8080'],
            ['http://dss.local/', 'http://dss.local:8080'],
            ['https://10.0.0.1:8081/', 'https://10.0.0.1:8081'],
            ['https://[::1]/', 'https://[::1]:8080'],
            ['dss.local:443', 'https://dss.local:443'],
            ['10.0.0.1:80', 'https://10.0.0.1:80'],
        ];
        cases.forEach(([input, expected]) => {
            it(`normalizes "${input}"`, () => {
                expect(DSS.buildBaseUrl(input)).to.equal(expected);
            });
        });

        const invalid = [
            ['', 'empty'],
            ['   ', 'blank'],
            [undefined, 'undefined'],
            ['ftp://dss.local', 'unsupported scheme'],
            ['https://user:secret@dss.local', 'credentials'],
            ['https://dss.local/apartment', 'path'],
            ['https://dss.local?token=abc', 'query'],
        ];
        invalid.forEach(([input, label]) => {
            it(`rejects ${label}`, () => {
                expect(() => DSS.buildBaseUrl(/** @type {string} */ (input))).to.throw();
            });
        });

        it('does not leak credentials into the error message', () => {
            try {
                DSS.buildBaseUrl('https://user:supersecret@dss.local');
                throw new Error('should have thrown');
            } catch (err) {
                expect(/** @type {Error} */ (err).message).to.not.contain('supersecret');
            }
        });
    });

    describe('requests', () => {
        it('rejects requests without an appToken', async () => {
            const dss = createDss({ appToken: undefined });
            try {
                await dss.requestAsync('apartment', 'getName');
                throw new Error('should have rejected');
            } catch (err) {
                expect(/** @type {Error} */ (err).message).to.contain('appToken');
            } finally {
                dss.stop();
            }
        });

        it('caches the session token and renews it after invalidation', async () => {
            const dss = createDss();
            let logins = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    logins++;
                    return { ok: true, result: { token: `session-${logins}` } };
                }
                return { ok: true, result: {} };
            };
            await dss.requestAsync('apartment', 'getName');
            await dss.requestAsync('apartment', 'getName');
            expect(logins).to.equal(1);
            dss.invalidateSession();
            await dss.requestAsync('apartment', 'getName');
            expect(logins).to.equal(2);
            dss.stop();
        });

        it('retries once with a fresh login when the session was invalidated server side', async () => {
            const dss = createDss();
            let logins = 0;
            let dataCalls = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    logins++;
                    return { ok: true, result: { token: `session-${logins}` } };
                }
                dataCalls++;
                if (dataCalls === 1) {
                    return { ok: false, message: 'Application is not logged in' };
                }
                return { ok: true, result: { name: 'test' } };
            };
            const res = await dss.requestAsync('apartment', 'getName');
            expect(res.result.name).to.equal('test');
            expect(logins).to.equal(2);
            dss.stop();
        });

        it('rejects with the DSS message on an ok:false response', async () => {
            const dss = createDss();
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                return { ok: false, message: 'Subscription not found' };
            };
            try {
                await dss.requestAsync('event', 'get', { subscriptionID: 42 });
                throw new Error('should have rejected');
            } catch (err) {
                expect(/** @type {Error} */ (err).message).to.contain('Subscription not found');
            } finally {
                dss.stop();
            }
        });
    });

    describe('connection error retry', () => {
        it('retries a request once after a socket hang up', async () => {
            const dss = createDss();
            let calls = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                calls++;
                if (calls === 1) {
                    const err = new Error('Request error for /json/device/getConfigWord: socket hang up');
                    err.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                    throw err;
                }
                return { ok: true, result: { value: 42 } };
            };
            const res = await dss.requestAsync('device', 'getConfigWord', { dsuid: 'a' });
            expect(res.result.value).to.equal(42);
            expect(calls, 'exactly one retry').to.equal(2);
            dss.stop();
        });

        it('gives up after one retry and reports the original error', async () => {
            const dss = createDss();
            let calls = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                calls++;
                throw new Error('Request error for /json/system/version: socket hang up');
            };
            try {
                // a read - only those are repeated at all, see "retry policy per endpoint"
                await dss.requestAsync('system', 'version');
                throw new Error('should have rejected');
            } catch (err) {
                expect(/** @type {Error} */ (err).message).to.contain('socket hang up');
            }
            expect(calls, 'no endless retry loop').to.equal(2);
            dss.stop();
        });

        it('does not retry a normal DSS error response', async () => {
            const dss = createDss();
            let calls = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                calls++;
                return { ok: false, message: 'Device not found' };
            };
            try {
                await dss.requestAsync('device', 'getConfigWord');
                throw new Error('should have rejected');
            } catch (err) {
                expect(/** @type {Error} */ (err).message).to.contain('Device not found');
            }
            expect(calls).to.equal(1);
            dss.stop();
        });

        it('sends nothing at all after stop()', async () => {
            const dss = createDss();
            let calls = 0;
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                calls++;
                throw new Error('socket hang up');
            };
            dss.stop();
            /** @type {any} */
            let reported = null;
            try {
                await dss.requestAsync('x', 'y');
            } catch (err) {
                reported = err;
            }
            expect(calls, 'a stopped client must not open a new request').to.equal(0);
            expect(reported.shutdown, 'an aborted request must be recognizable as a stop').to.equal(true);
        });

        it('classifies errors correctly', () => {
            expect(DSS.isRetryableConnectionError(new Error('socket hang up'))).to.equal(true);
            expect(DSS.isRetryableConnectionError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).to.equal(
                true,
            );
            expect(DSS.isRetryableConnectionError(new Error('Error response for /json/x: Device not found'))).to.equal(
                false,
            );
            expect(DSS.isRetryableConnectionError(null)).to.equal(false);
        });
    });

    describe('retry policy per endpoint', () => {
        // Counts how often each path was really sent to the DSS
        function countingDss(behaviour) {
            const dss = createDss();
            const sent = [];
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                sent.push(path);
                return behaviour(sent.length);
            };
            return { dss, sent };
        }

        const connectionError = () => {
            /** @type {import('../lib/configUtils').AdapterError} */
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
        };

        it('classifies reads as retryable and actions as not retryable', () => {
            [
                'apartment/getStructure',
                'property/query',
                'device/getOutputValue',
                // the named channel read of a vDC device - for a Sonos player it is the
                // ONLY path to audioVolume and powerState, so a lost answer must retry
                'device/getOutputChannelValue2',
                'zone/getLastCalledScene',
                // a registration without side effects, repeating it changes nothing
                'event/subscribe',
                // pure startup read of the reachable groups of a zone
                'apartment/getReachableGroups',
                // pure startup read of the sensor states of the dSS apps
                'property/query2',
            ].forEach(entry => {
                const [c, f] = entry.split('/');
                expect(DSS.isRetryableRequest(c, f), `${entry} must be retryable`).to.equal(true);
            });
            [
                'zone/callScene',
                'device/callScene',
                'apartment/callScene',
                'zone/undoScene',
                'device/undoScene',
                'event/raise',
                // a read, but it consumes the pending events
                'event/get',
                'event/unsubscribe',
                'state/set',
                'device/setValue',
                'zone/pushSensorValue',
                'device/setConfig',
                // unknown endpoints must default to "no retry"
                'something/new',
            ].forEach(entry => {
                const [c, f] = entry.split('/');
                expect(DSS.isRetryableRequest(c, f), `${entry} must not be retryable`).to.equal(false);
            });
        });

        it('repeats apartment/getReachableGroups once after a connection error', async () => {
            const { dss, sent } = countingDss(call =>
                call === 1 ? connectionError() : { ok: true, result: { zones: [] } },
            );
            const res = await dss.requestAsync('apartment', 'getReachableGroups', { id: 0 });
            expect(res.ok).to.equal(true);
            expect(sent.length, 'exactly one retry for the idempotent startup read').to.equal(2);
            dss.stop();
        });

        it('repeats a read exactly once after ECONNRESET and returns the result', async () => {
            const { dss, sent } = countingDss(call =>
                call === 1 ? connectionError() : { ok: true, result: { x: 1 } },
            );
            const res = await dss.requestAsync('apartment', 'getStructure');
            expect(res.result.x).to.equal(1);
            expect(sent.length, 'exactly one retry').to.equal(2);
            dss.stop();
        });

        it('never repeats a read more than once', async () => {
            const { dss, sent } = countingDss(() => connectionError());
            await expect(dss.requestAsync('apartment', 'getStructure')).to.be.rejectedWith(/socket hang up/);
            expect(sent.length, 'no endless retry loop').to.equal(2);
            dss.stop();
        });

        // These must never be sent twice - a repeat could run the action a second time
        const nonIdempotent = [
            ['zone', 'callScene'],
            ['device', 'callScene'],
            ['zone', 'undoScene'],
            ['device', 'undoScene'],
            ['event', 'raise'],
            ['state', 'set'],
            ['device', 'setValue'],
            ['zone', 'pushSensorValue'],
        ];
        nonIdempotent.forEach(([dssClass, dssFunction]) => {
            it(`does not resend ${dssClass}/${dssFunction} after a connection error`, async () => {
                const { dss, sent } = countingDss(() => connectionError());
                await expect(dss.requestAsync(dssClass, dssFunction, { id: 1 })).to.be.rejectedWith(/socket hang up/);
                expect(sent.length, `${dssClass}/${dssFunction} must be sent exactly once`).to.equal(1);
                expect(sent[0]).to.contain(`/json/${dssClass}/${dssFunction}`);
                dss.stop();
            });
        });

        it('reports the connection error to the caller instead of a false success', async () => {
            const { dss } = countingDss(() => connectionError());
            /** @type {any} */
            let caught = null;
            try {
                await dss.requestAsync('zone', 'callScene', { id: 1, sceneNumber: 5 });
            } catch (err) {
                caught = err;
            }
            expect(caught, 'the error must reach the caller').to.be.an('error');
            expect(caught.shutdown, 'a normal error must not be marked as shutdown').to.equal(undefined);
            dss.stop();
        });

        it('allows an explicit opt-in for an absolute write', async () => {
            const { dss, sent } = countingDss(call => (call === 1 ? connectionError() : { ok: true }));
            const res = await dss.requestAsync(
                'device',
                'setValue',
                { dsuid: 'a', value: 80 },
                { retryOnConnectionError: true },
            );
            expect(res.ok).to.equal(true);
            expect(sent.length).to.equal(2);
            dss.stop();
        });

        it('allows an explicit opt-out for a read', async () => {
            const { dss, sent } = countingDss(() => connectionError());
            await expect(
                dss.requestAsync('apartment', 'getStructure', {}, { retryOnConnectionError: false }),
            ).to.be.rejectedWith(/socket hang up/);
            expect(sent.length).to.equal(1);
            dss.stop();
        });

        it('does not send a read at all while the adapter is stopping', async () => {
            const { dss, sent } = countingDss(() => connectionError());
            dss.stop();
            /** @type {any} */
            let caught = null;
            try {
                await dss.requestAsync('apartment', 'getStructure');
            } catch (err) {
                caught = err;
            }
            expect(sent.length, 'no request and no retry after stop()').to.equal(0);
            expect(caught.shutdown).to.equal(true);
        });

        it('keeps the legacy signature with timeout and event poll flag working', async () => {
            const dss = createDss();
            const seen = [];
            dss.httpRequest = async (path, query, timeout, isEventPoll) => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                seen.push({ timeout, isEventPoll });
                return { ok: true };
            };
            await dss.requestAsync('apartment', 'getStructure', {}, 1234, true);
            expect(seen).to.deep.equal([{ timeout: 1234, isEventPoll: true }]);
            dss.stop();
        });

        it('does not repeat the event long poll - it would drop pending events', async () => {
            const dss = createDss();
            const sent = [];
            dss.httpRequest = async path => {
                if (path.includes('loginApplication')) {
                    return { ok: true, result: { token: 'session' } };
                }
                sent.push(path);
                return connectionError();
            };
            dss.subscriptions.eventA = { subscriptionId: 42, timeout: 10 };
            dss.ensureChannel(42, 10);
            dss.scheduleEventRetry = () => {}; // no timers in the test
            dss.pollChannel(42);
            await new Promise(resolve => setTimeout(resolve, 40));
            expect(sent.length, 'event/get must be sent exactly once').to.equal(1);
            dss.stop();
        });
    });

    describe('subscriptions', () => {
        it('aggregates subscription errors into an array', done => {
            const dss = createDss();
            dss.requestAsync = async () => {
                throw new Error('nope');
            };
            dss.subscribeEvents(['eventA', 'eventB'], errs => {
                expect(errs).to.be.an('array').with.lengthOf(2);
                dss.stop();
                done();
            });
        });

        it('reports null when all subscriptions succeed', done => {
            const dss = createDss();
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe') {
                    return { ok: true };
                }
                return new Promise(() => {}); // keep the long-poll pending
            };
            dss.subscribeEvents(['eventA'], errs => {
                expect(errs).to.equal(null);
                expect(dss.subscriptions).to.have.property('eventA');
                expect(dss.getChannel(dss.subScriptionId), 'the channel of the subscription id exists').to.not.equal(
                    null,
                );
                dss.stop();
                done();
            });
        });

        it('completes exactly once for an empty event list without any request', done => {
            const dss = createDss();
            let requests = 0;
            dss.requestAsync = async () => {
                requests++;
                return { ok: true };
            };
            let calls = 0;
            dss.subscribeEvents([], errs => {
                calls++;
                expect(errs).to.equal(null);
            });
            setTimeout(() => {
                expect(calls, 'callback must be called exactly once').to.equal(1);
                expect(requests, 'no request may be sent').to.equal(0);
                dss.stop();
                done();
            }, 30);
        });

        // All event names share ONE subscription id, so the DSS only has to keep one
        // long-poll open instead of one per event name. Before this the adapter opened
        // nine permanent connections and re-established each of them every 40 seconds.
        it('subscribes every event on one subscription id and polls exactly once', done => {
            const dss = createDss();
            const subscribed = [];
            let polls = 0;
            /**
             * @param {string} dssClass
             * @param {string} dssFunction
             * @param {Record<string, any>} params every call of the client carries them
             * @returns {Promise<import('../lib/configUtils').DssResponse>} DSS answer
             */
            dss.requestAsync = async (dssClass, dssFunction, params) => {
                if (dssFunction === 'subscribe') {
                    subscribed.push({ id: params.subscriptionID, name: params.name });
                    return { ok: true };
                }
                if (dssFunction === 'get') {
                    polls++;
                    return new Promise(() => {}); // long-poll stays pending
                }
                return { ok: true };
            };

            const eventNames = ['callScene', 'buttonClick', 'stateChange', 'deviceSensorValue'];
            dss.subscribeEvents(eventNames, errs => {
                expect(errs).to.equal(null);
                expect(subscribed.map(entry => entry.name)).to.deep.equal(eventNames);
                const usedIds = [...new Set(subscribed.map(entry => entry.id))];
                expect(usedIds, 'one subscription id for all events').to.deep.equal([dss.subScriptionId]);
                expect(Object.keys(dss.eventChannels), 'exactly one channel').to.have.lengthOf(1);
                setTimeout(() => {
                    expect(polls, 'exactly one long-poll for all events').to.equal(1);
                    dss.stop();
                    done();
                }, 20);
            });
        });

        // A poll that is already running when a name is added would not have to deliver
        // its events, so the poll waits for the last subscription.
        it('starts the poll only after the last subscription', done => {
            const dss = createDss();
            let pending = 0;
            let polls = 0;
            const releases = [];
            dss.requestAsync = (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe') {
                    pending++;
                    return new Promise(resolve => releases.push(() => resolve({ ok: true })));
                }
                polls++;
                return new Promise(() => {});
            };

            dss.subscribeEvents(['eventA', 'eventB'], () => {});
            setTimeout(() => {
                expect(pending, 'both subscriptions are in flight').to.equal(2);
                releases[0]();
                setTimeout(() => {
                    expect(polls, 'no poll while a subscription is still open').to.equal(0);
                    releases[1]();
                    setTimeout(() => {
                        expect(polls, 'the poll starts after the last subscription').to.equal(1);
                        dss.stop();
                        done();
                    }, 20);
                }, 20);
            }, 20);
        });

        it('does not poll when every subscription failed', done => {
            const dss = createDss();
            let polls = 0;
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'get') {
                    polls++;
                    return new Promise(() => {});
                }
                throw new Error('subscribe failed');
            };
            dss.subscribeEvents(['eventA', 'eventB'], errs => {
                expect(errs).to.be.an('array').with.lengthOf(2);
                setTimeout(() => {
                    expect(polls, 'nothing to poll without a channel').to.equal(0);
                    expect(dss.getChannel(dss.subScriptionId)).to.equal(null);
                    dss.stop();
                    done();
                }, 20);
            });
        });

        it('delivers the events of every subscribed name through the one poll', done => {
            const dss = createDss();
            let answered = false;
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe') {
                    return { ok: true };
                }
                if (answered) {
                    return new Promise(() => {});
                }
                answered = true;
                return {
                    ok: true,
                    result: {
                        events: [
                            { name: 'callScene', source: { dSUID: 'dev1' }, properties: { sceneID: 5 } },
                            { name: 'buttonClick', source: { dSUID: 'dev2' }, properties: { clickType: 0 } },
                        ],
                    },
                };
            };

            const received = [];
            dss.on('callScene', () => received.push('callScene'));
            dss.on('buttonClick', () => received.push('buttonClick'));

            dss.subscribeEvents(['callScene', 'buttonClick'], () => {
                setTimeout(() => {
                    expect(received).to.deep.equal(['callScene', 'buttonClick']);
                    dss.stop();
                    done();
                }, 30);
            });
        });

        // The DSS loses the whole subscription id, e.g. after a restart. Re-subscribing
        // only the name whose poll failed would silently drop all other events.
        it('registers every name of the channel again on a re-subscribe', async () => {
            const clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
            try {
                const dss = createDss();
                const resubscribed = [];
                let subscribeCalls = 0;
                /**
                 * @param {string} dssClass
                 * @param {string} dssFunction
                 * @param {Record<string, any>} params every call of the client carries them
                 * @returns {Promise<import('../lib/configUtils').DssResponse>} DSS answer
                 */
                dss.requestAsync = async (dssClass, dssFunction, params) => {
                    if (dssFunction === 'subscribe') {
                        subscribeCalls++;
                        if (subscribeCalls > 3) {
                            resubscribed.push(params.name);
                        }
                        return { ok: true };
                    }
                    /** @type {import('../lib/configUtils').AdapterError} */
                    const err = new Error('HTTP 500 for /json/event/get');
                    err.status = 500;
                    throw err;
                };
                dss.on('eventError', () => {});

                dss.subscribeEvents(['eventA', 'eventB', 'eventC'], () => {});
                await clock.tickAsync(10);
                // First failure already asks for a re-subscribe because of the HTTP 500
                await clock.tickAsync(5000);

                expect(resubscribed.sort(), 'all names are registered again').to.deep.equal([
                    'eventA',
                    'eventB',
                    'eventC',
                ]);
                dss.stop();
            } finally {
                clock.restore();
            }
        });

        it('unsubscribes once per subscription id, not once per event name', done => {
            const dss = createDss();
            const unsubscribes = [];
            dss.requestAsync = async (dssClass, dssFunction, params) => {
                if (dssFunction === 'unsubscribe') {
                    unsubscribes.push(params);
                    return { ok: true };
                }
                if (dssFunction === 'get') {
                    return new Promise(() => {});
                }
                return { ok: true };
            };

            dss.subscribeEvents(['eventA', 'eventB', 'eventC'], () => {
                dss.unsubscribeAllEvents(() => {
                    expect(unsubscribes, 'one request for the whole subscription').to.have.lengthOf(1);
                    expect(unsubscribes[0].subscriptionID).to.equal(dss.subScriptionId);
                    expect(dss.subscriptions).to.deep.equal({});
                    expect(dss.eventChannels).to.deep.equal({});
                    dss.stop();
                    done();
                });
            });
        });

        // The DSS drops the whole subscription id, so the client must not pretend that the
        // other names are still delivered.
        it('drops the whole channel when one event is unsubscribed', done => {
            const dss = createDss();
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'get') {
                    return new Promise(() => {});
                }
                return { ok: true };
            };
            dss.subscribeEvents(['eventA', 'eventB'], () => {
                dss.unsubscribeEvent('eventA', err => {
                    expect(err).to.equal(null);
                    expect(dss.subscriptions, 'no name of that channel is left').to.deep.equal({});
                    expect(dss.getChannel(dss.subScriptionId)).to.equal(null);
                    dss.stop();
                    done();
                });
            });
        });

        it('calls back without error when unsubscribing an unknown event', done => {
            const dss = createDss();
            dss.unsubscribeEvent('unknownEvent', err => {
                expect(err).to.equal(null);
                dss.stop();
                done();
            });
        });
    });

    describe('event normalization', () => {
        it('accepts events without source or properties', () => {
            const event = DSS.normalizeEvent({ name: 'callScene' });
            expect(event?.source).to.deep.equal({});
            expect(event?.properties).to.deep.equal({});
        });

        it('maps the legacy dsid and the misspelled sceneId', () => {
            const event = DSS.normalizeEvent({
                name: 'callScene',
                source: { dsid: 'abc' },
                properties: { sceneId: 5 },
            });
            expect(event?.source.dSUID).to.equal('abc');
            expect(event?.properties.sceneID).to.equal(5);
        });

        it('rejects unusable entries', () => {
            expect(DSS.normalizeEvent(null)).to.equal(null);
            expect(DSS.normalizeEvent({})).to.equal(null);
            expect(DSS.normalizeEvent('nope')).to.equal(null);
            expect(DSS.normalizeEvent({ name: '' })).to.equal(null);
        });
    });

    describe('event polling robustness', () => {
        function pollingDss(responses) {
            const dss = createDss();
            let call = 0;
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction !== 'get') {
                    return { ok: true };
                }
                const response = responses[Math.min(call, responses.length - 1)];
                call++;
                if (response instanceof Error) {
                    throw response;
                }
                return response;
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            return dss;
        }

        it('keeps polling and emits the valid event when a broken event is in the same response', done => {
            const dss = pollingDss([
                {
                    ok: true,
                    result: {
                        events: [
                            { name: 'callScene' }, // no source/properties
                            null, // completely unusable
                            { name: 'callScene', source: { dSUID: 'dev1' }, properties: { sceneID: 5 } },
                        ],
                    },
                },
                new Promise(() => {}), // second poll stays pending
            ]);

            const received = [];
            dss.on('callScene', data => received.push(data));

            let rejected = null;
            const onRejection = err => (rejected = err);
            process.once('unhandledRejection', onRejection);

            dss.pollChannel(42);
            setTimeout(() => {
                process.removeListener('unhandledRejection', onRejection);
                expect(rejected, 'no unhandled rejection').to.equal(null);
                expect(received.length, 'all usable events are emitted').to.equal(2);
                expect(received[1].source.dSUID).to.equal('dev1');
                dss.stop();
                done();
            }, 60);
        });

        it('does not stop the poll loop when an event handler throws', done => {
            let polls = 0;
            const dss = createDss();
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction !== 'get') {
                    return { ok: true };
                }
                polls++;
                if (polls > 3) {
                    return new Promise(() => {});
                }
                return { ok: true, result: { events: [{ name: 'callScene', source: {}, properties: {} }] } };
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            dss.on('callScene', () => {
                throw new Error('handler exploded');
            });

            dss.pollChannel(42);
            setTimeout(() => {
                expect(polls, 'poll loop must continue').to.be.above(1);
                dss.stop();
                done();
            }, 80);
        });
    });

    describe('event retry handling', () => {
        let clock;

        beforeEach(() => {
            clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
        });

        afterEach(() => {
            clock.restore();
        });

        it('retries with backoff and finally reports eventError exactly once', async () => {
            const dss = createDss();
            const attempts = { get: 0, subscribe: 0 };
            dss.requestAsync = async (dssClass, dssFunction) => {
                attempts[dssFunction] = (attempts[dssFunction] || 0) + 1;
                throw new Error(`${dssFunction} failed`);
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);

            const errors = [];
            dss.on('eventError', (name, count, message) => errors.push({ name, count, message }));

            dss.pollChannel(42);
            // Walk through the whole backoff chain
            for (let i = 0; i < 10; i++) {
                await clock.tickAsync(70000);
            }

            expect(errors.length, 'eventError exactly once').to.equal(1);
            expect(errors[0].name).to.equal('testEvent');
            expect(attempts.subscribe, 're-subscribe must have been attempted').to.be.above(0);
            expect(dss.getChannel(42)?.retryTimer, 'no retry timer left').to.equal(null);
            dss.stop();
        });

        it('schedules only one retry timer per event', async () => {
            const dss = createDss();
            dss.requestAsync = async () => {
                throw new Error('always fails');
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            dss.pollChannel(42);
            await clock.tickAsync(1);
            const firstTimer = dss.getChannel(42)?.retryTimer;
            expect(firstTimer, 'a retry must be scheduled').to.not.equal(null);
            // A second failure must replace, not add, a timer
            dss.handleEventFailure(42, new Error('again'), 'polling');
            expect(dss.getChannel(42)?.retryTimer).to.not.equal(firstTimer);
            dss.stop();
        });

        it('starts no further retry after stop()', async () => {
            const dss = createDss();
            let calls = 0;
            dss.requestAsync = async () => {
                calls++;
                throw new Error('fails');
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            dss.pollChannel(42);
            await clock.tickAsync(1);
            const callsBeforeStop = calls;

            dss.stop();
            await clock.tickAsync(300000);
            expect(calls, 'no request after stop').to.equal(callsBeforeStop);
        });

        // Regression: a working event/subscribe used to reset errorCount, so a permanently
        // failing event/get never reached the limit. The adapter stayed "connected" while it
        // re-subscribed every two seconds and never processed an event again.
        it('ends in eventError when subscribe works but event/get keeps failing', async () => {
            const dss = createDss();
            const attempts = { get: 0, subscribe: 0 };
            dss.requestAsync = async (dssClass, dssFunction) => {
                attempts[dssFunction] = (attempts[dssFunction] || 0) + 1;
                if (dssFunction === 'subscribe') {
                    return { ok: true }; // subscribing always works
                }
                /** @type {import('../lib/configUtils').AdapterError} */
                const err = new Error(`HTTP 500 for /json/event/get`);
                err.status = 500;
                throw err;
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);

            const errors = [];
            dss.on('eventError', (name, count, message) => errors.push({ name, count, message }));

            dss.pollChannel(42);
            for (let i = 0; i < 20; i++) {
                await clock.tickAsync(70000);
            }

            expect(errors.length, 'eventError must be reported exactly once').to.equal(1);
            expect(errors[0].name).to.equal('testEvent');
            expect(attempts.subscribe, 're-subscribing must not loop forever').to.be.below(10);
            expect(attempts.get, 'polling must stop after the limit').to.be.below(10);
            expect(dss.getChannel(42)?.retryTimer, 'no retry timer left').to.equal(null);
            dss.stop();
        });

        it('keeps the error counter across a successful re-subscribe', async () => {
            const dss = createDss();
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe') {
                    return { ok: true };
                }
                throw new Error('event/get down');
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100).errorCount = 3;
            // Isolates the subscribe: the poll it starts is tested separately
            dss.pollChannel = () => {};

            await new Promise(resolve => dss.subscribeEvent('testEvent', 42, 100, resolve));
            expect(dss.getChannel(42)?.errorCount, 'a subscribe alone proves nothing').to.equal(3);
            dss.stop();
        });

        it('clears the error counter after a successful event/get', async () => {
            const dss = createDss();
            dss.requestAsync = async () => ({ ok: true, result: { events: [] } });
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100).errorCount = 4;

            dss.pollChannel(42);
            await clock.tickAsync(1);
            expect(dss.getChannel(42)?.errorCount, 'a real poll resets the counter').to.equal(0);
            dss.stop();
        });

        it('backs off exponentially instead of hammering the DSS', async () => {
            const dss = createDss();
            const times = [];
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe') {
                    return { ok: true };
                }
                times.push(Date.now());
                /** @type {import('../lib/configUtils').AdapterError} */
                const err = new Error('HTTP 500');
                err.status = 500;
                throw err;
            };
            dss.subscriptions.testEvent = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            dss.on('eventError', () => {});

            dss.pollChannel(42);
            for (let i = 0; i < 20; i++) {
                await clock.tickAsync(70000);
            }

            const gaps = times.slice(1).map((t, idx) => t - times[idx]);
            gaps.forEach(gap => expect(gap, 'never a tight loop').to.be.at.least(2000));
            for (let i = 1; i < gaps.length; i++) {
                expect(gaps[i], 'the delay must grow').to.be.at.least(gaps[i - 1]);
            }
            dss.stop();
        });
    });

    describe('stop barrier', () => {
        it('opens no socket after stop()', async () => {
            const dss = createDss();
            let opened = 0;
            dss.transport = /** @type {any} */ ({
                get: () => {
                    opened++;
                    throw new Error('must not be called');
                },
            });
            dss.stop();
            await expect(dss.httpRequest('/json/system/version')).to.be.rejectedWith(/stopped/);
            expect(opened, 'no socket after stop()').to.equal(0);
        });

        it('marks a request rejected by the stop barrier as a shutdown', async () => {
            const dss = createDss();
            dss.stop();
            /** @type {any} */
            let caught = null;
            try {
                await dss.httpRequest('/json/system/version');
            } catch (err) {
                caught = err;
            }
            expect(caught.shutdown, 'consumers must be able to recognize the shutdown').to.equal(true);
        });
    });
});
