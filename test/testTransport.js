const http = require('node:http');
const assert = require('node:assert');
const { DSS } = require('../build/lib/dss');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal DSS stand-in. /event/get never answers - exactly like a real long-poll
 * that is waiting for events.
 */
function createFakeDss() {
    const openPolls = [];
    const server = http.createServer((req, res) => {
        const url = req.url || '';
        if (url.includes('loginApplication')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, result: { token: 'session' } }));
        }
        if (url.includes('/event/get')) {
            openPolls.push(res); // keep it open forever
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { done: true } }));
    });
    return { server, openPolls };
}

describe('DSS transport', () => {
    let fake;
    let dss;

    beforeEach(done => {
        fake = createFakeDss();
        fake.server.listen(0, '127.0.0.1', done);
    });

    afterEach(done => {
        dss && dss.stop();
        fake.openPolls.forEach(res => res.destroy());
        fake.server.close(() => done());
    });

    it('does not let event long-polls block a normal API command', async function () {
        this.timeout(20000);
        const port = fake.server.address().port;
        dss = new DSS({ host: `http://127.0.0.1:${port}`, appToken: 'tok', logger: silentLogger });

        // Several long-polls at once. The adapter itself only opens one (all events share
        // a subscription id), but the agent separation must hold for more than one as well.
        const eventCount = 9;
        for (let i = 0; i < eventCount; i++) {
            dss.subscriptions[`event${i}`] = { subscriptionId: 40 + i, timeout: 40000 };
            dss.ensureChannel(40 + i, 40000);
            dss.pollChannel(40 + i);
        }
        // Give the polls time to actually occupy their sockets
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(fake.openPolls.length, eventCount, 'all event polls must be in flight');

        // A normal command must not wait for any long-poll
        const started = Date.now();
        const res = await Promise.race([
            dss.requestAsync('device', 'callScene', { dsuid: 'dev1', sceneNumber: 14 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('API request was blocked')), 5000)),
        ]);
        assert.strictEqual(res.ok, true);
        assert.ok(Date.now() - started < 3000, 'API request must be answered immediately');
    });

    it('uses separate agents for API calls and event polls', () => {
        dss = new DSS({ host: 'http://127.0.0.1:1', appToken: 'tok', logger: silentLogger });
        assert.notStrictEqual(dss.apiAgent, dss.eventAgent);
        // Long-poll plus a re-subscribe running next to it must both fit
        assert.ok(dss.eventAgent.maxSockets >= 2);
    });

    describe('request timeouts', () => {
        // Regression: the self-made timeout error carried no structured marker, so the retry
        // classifier could not recognize it and a safe read was never repeated.
        it('marks a real request timeout as a retryable connection error', async function () {
            this.timeout(20000);
            const port = fake.server.address().port;
            dss = new DSS({
                host: `http://127.0.0.1:${port}`,
                appToken: 'tok',
                logger: silentLogger,
                requestTimeout: 150,
            });

            /** @type {any} */
            let caught = null;
            try {
                // /event/get is never answered by the fake DSS -> real socket timeout
                await dss.httpRequest('/json/event/get', { subscriptionID: 42 }, 150);
            } catch (err) {
                caught = err;
            }
            assert.notStrictEqual(caught, null, 'the request must time out');
            assert.ok(caught.message.includes('Timeout after'));
            assert.strictEqual(caught.code, 'ETIMEDOUT', 'structured code instead of message parsing');
            assert.strictEqual(caught.timeout, true);
            assert.strictEqual(DSS.isRetryableConnectionError(caught), true, 'a timeout is retryable');
        });

        it('repeats a safe read once after a timeout, a write never', async function () {
            this.timeout(20000);
            const port = fake.server.address().port;
            const timeouts = [];
            dss = new DSS({
                host: `http://127.0.0.1:${port}`,
                appToken: 'tok',
                logger: silentLogger,
                requestTimeout: 150,
            });
            const originalRequest = dss.httpRequest.bind(dss);
            dss.httpRequest = (path, query, timeout, isEventPoll) => {
                if (path.includes('loginApplication')) {
                    return originalRequest(path, query, timeout, isEventPoll);
                }
                timeouts.push(path);
                // Always route to the endpoint that never answers
                return originalRequest('/json/event/get', query, 150, isEventPoll);
            };

            await assert.rejects(dss.requestAsync('apartment', 'getStructure'), /Timeout after/);
            assert.strictEqual(timeouts.length, 2, 'a safe read is repeated exactly once');

            timeouts.length = 0;
            await assert.rejects(dss.requestAsync('device', 'callScene', { dsuid: 'x' }), /Timeout after/);
            assert.strictEqual(timeouts.length, 1, 'a write must never be repeated');
        });
    });

    it('stops cleanly while long-polls are running and starts no new poll', async function () {
        this.timeout(20000);
        const port = fake.server.address().port;
        dss = new DSS({ host: `http://127.0.0.1:${port}`, appToken: 'tok', logger: silentLogger });
        dss.subscriptions.eventA = { subscriptionId: 42, timeout: 40000 };
        dss.ensureChannel(42, 40000);
        dss.pollChannel(42);
        await new Promise(resolve => setTimeout(resolve, 200));

        let pollsAfterStop = 0;
        const originalPoll = dss.pollChannel.bind(dss);
        dss.pollChannel = subscriptionId => {
            pollsAfterStop++;
            return originalPoll(subscriptionId);
        };

        dss.stop();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(pollsAfterStop, 0, 'no new poll after stop');
        assert.strictEqual(dss.activeRequests.size, 0, 'no request left over');
    });
});
