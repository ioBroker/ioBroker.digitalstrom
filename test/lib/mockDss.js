const http = require('node:http');
const { URL } = require('node:url');

const APP_TOKEN = 'test-app-token';
const SESSION_TOKEN = 'test-session-token';

/**
 * One request the mock server received.
 *
 * @typedef {object} MockDssRequest
 * @property {string} path json function without the /json/ prefix, e.g. "apartment/getName"
 * @property {Record<string, string>} query query parameters as they arrived on the wire
 */

/**
 * Handle of a running mock DSS.
 *
 * Everything a test needs to drive the mock and to assert what the adapter sent. The
 * recorded writes carry whatever the endpoint delivers - device/setValue only knows a
 * value, setOutputValue an offset and setConfig an index - so they stay records.
 *
 * @typedef {object} MockDssHandle
 * @property {import('node:http').Server} server the http server answering the adapter
 * @property {MockDssRequest[]} requests every request the adapter sent, in order
 * @property {Record<string, any>[]} writtenOutputValues device output writes that arrived
 * @property {Record<string, any>[]} writtenStates user state writes that arrived
 * @property {Record<string, any>[]} calledScenes scene calls that arrived
 * @property {string} appToken the app token this mock accepts
 * @property {() => Promise<string>} start starts listening, resolves with the base url
 * @property {() => string} host base url of the listening server
 * @property {(eventName: string, event: Record<string, any>) => void} emitEvent delivers an event to the adapter
 * @property {() => string[]} subscribedEvents all event names the adapter subscribed to
 * @property {() => string[]} subscriptionIds the subscription ids the adapter uses
 * @property {(path: string) => MockDssRequest[]} pathsCalled every request for that json function
 * @property {() => Promise<void>} stop drops open long-polls and closes the server
 */

/**
 * Minimal but realistic digitalSTROM server for the integration tests.
 *
 * It answers the whole startup sequence of the adapter, keeps a real event subscription
 * with long-polling and records every request, so a test can assert what the adapter
 * really sent. No test ever talks to a real DSS.
 *
 * @param {object} [options]
 * @param {boolean} [options.requireAuth] reject requests without a valid session token
 * @returns {MockDssHandle} mock server handle
 */
function createMockDss(options = {}) {
    const requireAuth = options.requireAuth !== false;

    /** @type {MockDssRequest[]} every request the adapter sent */
    const requests = [];
    /** events waiting for the next event/get, per subscription id */
    const pendingEvents = new Map();
    /** open long-polls, per subscription id */
    const openPolls = new Map();
    /** subscription id -> set of event names (the DSS allows many names per id) */
    const subscriptions = new Map();
    /** last value written per device output, for the superseded tests */
    const writtenOutputValues = [];
    /** last value written per user state */
    const writtenStates = [];
    /** scenes that were called */
    const calledScenes = [];

    const outputValues = { dev1: { 0: 128, 2: 32768, 4: 128 } };

    const apartment = {
        name: 'Test Apartment',
        clusters: [],
        floors: [{ id: 0, name: 'Ground floor', zones: [5] }],
        zones: [
            {
                id: 0,
                name: 'Apartment',
                isPresent: true,
                isValid: true,
                devices: [
                    {
                        dSUID: 'dev1',
                        id: 'dev1',
                        name: 'Living room light',
                        meterDSUID: 'meter1',
                        zoneID: 5,
                        isPresent: true,
                        isValid: true,
                        hwInfo: 'GE-KM200',
                        outputMode: 22,
                        buttonActiveGroup: -1,
                        sensorInputCount: 0,
                        binaryInputCount: 0,
                        groups: [1],
                        outputChannels: [{ channelId: 'brightness', channelType: 'brightness', channelIndex: 0 }],
                    },
                ],
                groups: [{ id: 1, name: 'Light', isPresent: true, isValid: true, devices: ['dev1'] }],
            },
            {
                id: 5,
                name: 'Living room',
                isPresent: true,
                isValid: true,
                devices: [],
                groups: [{ id: 1, name: 'Light', isPresent: true, isValid: true, devices: ['dev1'] }],
            },
        ],
    };

    const answers = {
        'system/loginApplication': query => {
            if (query.loginToken !== APP_TOKEN) {
                return { ok: false, message: 'Application Authentication failed' };
            }
            return { ok: true, result: { token: SESSION_TOKEN } };
        },
        'apartment/getName': () => ({ ok: true, result: { name: apartment.name } }),
        'system/version': () => ({ ok: true, result: { version: '1.19.4' } }),
        'apartment/getStructure': () => ({ ok: true, result: { apartment } }),
        'apartment/getCircuits': () => ({
            ok: true,
            result: { circuits: [{ dSUID: 'meter1', name: 'dSM1', hasMetering: true, isPresent: true }] },
        }),
        'apartment/getSensorValues': () => ({ ok: true, result: { outdoor: {}, zones: [] } }),
        'apartment/getTemperatureControlStatus': () => ({ ok: true, result: { zones: [] } }),
        'apartment/getReachableGroups': () => ({ ok: true, result: { zones: [{ zoneID: 5, groups: [1] }] } }),
        'property/query': query => {
            if (String(query.query).includes('user-defined-states')) {
                return {
                    ok: true,
                    result: {
                        'system-addon-user-defined-states': [
                            { name: 'testUserState', displayName: 'Test User State', state: 'inactive' },
                        ],
                    },
                };
            }
            if (String(query.query).includes('/usr/states')) {
                return { ok: true, result: { states: [] } };
            }
            return { ok: true, result: { events: [] } };
        },
        // The sensor states of the dSS apps, keyed by app and state name like the real
        // query2 answer. The user-defined states appear here as well; the adapter
        // already builds them from property/query above.
        'property/query2': query => {
            if (!String(query.query).startsWith('/usr/addon-states/')) {
                return { ok: true, result: {} };
            }
            return {
                ok: true,
                result: {
                    'system-addon-user-defined-states': {
                        testUserState: { name: 'testUserState', value: 2, state: 'inactive' },
                    },
                    // A dSS20 1.19.13 lists its climate control under both app ids, with the
                    // same states (measured with probe-states.js)
                    'system-addon-heating-controller': {
                        'zone.zone5.group0.type9.passiveCooling': {
                            name: 'zone.zone5.group0.type9.passiveCooling',
                            value: 1,
                            state: 'active',
                            callOrigin: 9,
                        },
                    },
                    'heating-controller': {
                        'zone.zone5.group0.type9.passiveCooling': {
                            name: 'zone.zone5.group0.type9.passiveCooling',
                            value: 1,
                            state: 'active',
                            callOrigin: 9,
                        },
                    },
                },
            };
        },
        'zone/getReachableScenes': () => ({ ok: true, result: { reachableScenes: [0, 5], userSceneNames: [] } }),
        'zone/getLastCalledScene': () => ({ ok: true, result: { scene: 0 } }),
        'circuit/getConsumption': () => ({ ok: true, result: { consumption: 42 } }),
        'circuit/getEnergyMeterValue': () => ({ ok: true, result: { meterValue: 1234 } }),
        'device/getOutputValue': query => {
            const dev = outputValues[query.dsuid] || {};
            const value = dev[query.offset];
            if (value === undefined) {
                return { ok: false, message: 'Device does not deliver this value' };
            }
            return { ok: true, result: { value } };
        },
        'device/getConfig': query => {
            const dev = outputValues[query.dsuid] || {};
            const value = dev[query.index];
            if (value === undefined) {
                return { ok: false, message: 'Device does not deliver this value' };
            }
            return { ok: true, result: { value } };
        },
        'device/getConfigWord': query => answers['device/getConfig'](query),
        'device/setValue': query => {
            writtenOutputValues.push({ dsuid: query.dsuid, value: Number(query.value) });
            return { ok: true };
        },
        'device/setOutputValue': query => {
            writtenOutputValues.push({ dsuid: query.dsuid, offset: Number(query.offset), value: Number(query.value) });
            return { ok: true };
        },
        'device/setConfig': query => {
            writtenOutputValues.push({ dsuid: query.dsuid, index: Number(query.index), value: Number(query.value) });
            return { ok: true };
        },
        'device/callScene': query => {
            calledScenes.push({ dsuid: query.dsuid, scene: Number(query.sceneNumber) });
            return { ok: true };
        },
        'device/undoScene': query => answers['device/callScene'](query),
        'zone/callScene': query => {
            calledScenes.push({
                zone: Number(query.id),
                group: Number(query.groupID),
                scene: Number(query.sceneNumber),
            });
            return { ok: true };
        },
        'zone/undoScene': query => answers['zone/callScene'](query),
        'zone/pushSensorValue': () => ({ ok: true }),
        'state/set': query => {
            writtenStates.push({ name: query.name, value: query.value });
            return { ok: true };
        },
        'event/subscribe': query => {
            const id = String(query.subscriptionID);
            const names = subscriptions.get(id) || new Set();
            names.add(query.name);
            subscriptions.set(id, names);
            return { ok: true };
        },
        // Like the real DSS: unsubscribing one name drops the whole subscription id
        'event/unsubscribe': query => {
            subscriptions.delete(String(query.subscriptionID));
            return { ok: true };
        },
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());
        const path = url.pathname.replace(/^\/json\//, '');
        requests.push({ path, query });

        const send = body => {
            if (res.writableEnded) {
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (requireAuth && path !== 'system/loginApplication' && query.token !== SESSION_TOKEN) {
            return send({ ok: false, message: 'Not logged in' });
        }

        // event/get is a long-poll: it only answers when an event is available
        if (path === 'event/get') {
            const id = String(query.subscriptionID);
            const queued = pendingEvents.get(id);
            if (queued && queued.length) {
                pendingEvents.set(id, []);
                return send({ ok: true, result: { events: queued } });
            }
            openPolls.set(id, res);
            res.on('close', () => {
                if (openPolls.get(id) === res) {
                    openPolls.delete(id);
                }
            });
            return;
        }

        const answer = answers[path];
        if (!answer) {
            return send({ ok: false, message: `Unknown function ${path}` });
        }
        send(answer(query));
    });

    return {
        server,
        requests,
        writtenOutputValues,
        writtenStates,
        calledScenes,
        appToken: APP_TOKEN,

        start() {
            return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(this.host())));
        },

        host() {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('The mock DSS is not listening on a TCP port');
            }
            return `http://127.0.0.1:${address.port}`;
        },

        /**
         * Delivers an event to the adapter, either to a waiting long-poll or to the
         * next event/get of that subscription.
         *
         * @param {string} eventName
         * @param {Record<string, any>} event the raw event as the DSS would deliver it
         */
        emitEvent(eventName, event) {
            const entry = [...subscriptions.entries()].find(([, names]) => names.has(eventName));
            if (!entry) {
                throw new Error(`Not subscribed to ${eventName}`);
            }
            const subscriptionId = entry[0];
            const open = openPolls.get(subscriptionId);
            if (open) {
                openPolls.delete(subscriptionId);
                open.writeHead(200, { 'Content-Type': 'application/json' });
                open.end(JSON.stringify({ ok: true, result: { events: [event] } }));
                return;
            }
            const queued = pendingEvents.get(subscriptionId) || [];
            queued.push(event);
            pendingEvents.set(subscriptionId, queued);
        },

        subscribedEvents() {
            return [...subscriptions.values()].flatMap(names => [...names]);
        },

        /**
         * @returns {string[]} the subscription ids the adapter uses
         */
        subscriptionIds() {
            return [...subscriptions.keys()];
        },

        pathsCalled(path) {
            return requests.filter(entry => entry.path === path);
        },

        /**
         * @returns {Promise<void>}
         */
        stop() {
            openPolls.forEach(res => res.destroy());
            openPolls.clear();
            return new Promise(resolve => server.close(() => resolve()));
        },
    };
}

module.exports = { createMockDss, APP_TOKEN, SESSION_TOKEN };
