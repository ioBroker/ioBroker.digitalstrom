const http = require('node:http');
const { expect } = require('chai');
const DSS = require('../lib/dss');

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
        expect(fake.openPolls.length, 'all event polls must be in flight').to.equal(eventCount);

        // A normal command must not wait for any long-poll
        const started = Date.now();
        const res = await Promise.race([
            dss.requestAsync('device', 'callScene', { dsuid: 'dev1', sceneNumber: 14 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('API request was blocked')), 5000)),
        ]);
        expect(res.ok).to.equal(true);
        expect(Date.now() - started, 'API request must be answered immediately').to.be.below(3000);
    });

    it('uses separate agents for API calls and event polls', () => {
        dss = new DSS({ host: 'http://127.0.0.1:1', appToken: 'tok', logger: silentLogger });
        expect(dss.apiAgent).to.not.equal(dss.eventAgent);
        // Long-poll plus a re-subscribe running next to it must both fit
        expect(dss.eventAgent.maxSockets).to.be.at.least(2);
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
            expect(caught, 'the request must time out').to.not.equal(null);
            expect(caught.message).to.contain('Timeout after');
            expect(caught.code, 'structured code instead of message parsing').to.equal('ETIMEDOUT');
            expect(caught.timeout).to.equal(true);
            expect(DSS.isRetryableConnectionError(caught), 'a timeout is retryable').to.equal(true);
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

            await expect(dss.requestAsync('apartment', 'getStructure')).to.be.rejectedWith(/Timeout after/);
            expect(timeouts.length, 'a safe read is repeated exactly once').to.equal(2);

            timeouts.length = 0;
            await expect(dss.requestAsync('device', 'callScene', { dsuid: 'x' })).to.be.rejectedWith(/Timeout after/);
            expect(timeouts.length, 'a write must never be repeated').to.equal(1);
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
        expect(pollsAfterStop, 'no new poll after stop').to.equal(0);
        expect(dss.activeRequests.size, 'no request left over').to.equal(0);
    });
});
