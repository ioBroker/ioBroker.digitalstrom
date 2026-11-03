#!/usr/bin/env node
/**
 * Read-only Probe fuer die neue digitalSTROM "Smart Home API" (/api/v1) eines dSS.
 *
 * Das Skript beantwortet die Frage, ob und wie vollstaendig der Adapter auf die neue
 * REST-API plus Notification-Websocket umgebaut werden kann. Es schreibt alle Antworten
 * als JSON in ein Ausgabeverzeichnis, damit das Mapping danach offline entworfen werden kann.
 *
 * Ausser dem optionalen Anlegen eines Application Tokens (--create-token) veraendert
 * das Skript nichts auf dem dSS - es liest nur.
 *
 * Benutzung:
 *   DSS_PASSWORD=xxx node scripts/probe-smarthome-api.js --host 192.168.1.10 --create-token
 *   node scripts/probe-smarthome-api.js --host 192.168.1.10 --token <apiKey> --seconds 120
 *
 * Optionen:
 *   --host <ip|name>     dSS Adresse (Pflicht)
 *   --port <n>           HTTPS Port der REST-API (Default 8080)
 *   --ws-port <n>        Port des Notification-Websockets (Default 8090)
 *   --token <apiKey>     bereits vorhandener API-Key (Bearer)
 *   --create-token       legt per Login einen neuen Application Token an und nutzt ihn
 *   --user <name>        Login-Benutzer fuer --create-token (Default dssadmin)
 *   --seconds <n>        Dauer des Websocket-Mitschnitts (Default 60, 0 = ueberspringen)
 *   --out <dir>          Ausgabeverzeichnis (Default ./ds-probe)
 *   --old-api            zusaetzlich system/version und apartment/getStructure der alten API
 *   --discover           zweiter Durchgang: sucht nach weiteren Endpunkten und Werten
 *                        (Gerätesensoren, Binäreingänge, OpenAPI auf dem Gerät) und fragt
 *                        per OPTIONS ab, welche Methoden erlaubt sind. Nur lesend.
 *   --probe-write <id>   prüft zusätzlich, ob ein benutzerdefinierter Zustand schreibbar
 *                        ist. Setzt dazu den AKTUELLEN Wert erneut, ändert also nichts.
 *                        Bitte trotzdem eine harmlose ID wählen.
 *
 * Das Passwort wird ausschliesslich ueber die Umgebungsvariable DSS_PASSWORD gelesen und
 * niemals geloggt oder gespeichert.
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * The command line as parseArgs() leaves it. Everything the caller may omit is optional
 * here, so a missing --host or --token shows up as a type error instead of as a request
 * against "undefined".
 *
 * @typedef {object} ProbeArgs
 * @property {number} port HTTPS port of the REST API
 * @property {number} wsPort port of the notification websocket
 * @property {number} seconds duration of the websocket recording, 0 skips it
 * @property {string} out directory the raw answers are written to
 * @property {string} user login user for --create-token
 * @property {boolean} createToken create an application token before probing
 * @property {boolean} oldApi additionally query the old JSON API for comparison
 * @property {string} [host] dSS address, without it only the help is printed
 * @property {string} [token] API key sent as bearer, may be created on the fly
 * @property {boolean} [discover] run the second, searching sweep instead of the first
 * @property {string} [probeWrite] id of the user defined state the write test uses
 * @property {boolean} [help] print the header comment and exit
 *
 * One answer of request(). The raw text is always there, json only when the dSS answered
 * with JSON - which endpoints do and which do not is exactly what this script measures.
 * @typedef {object} HttpAnswer
 * @property {number|undefined} status HTTP status code
 * @property {import('node:http').IncomingHttpHeaders} headers response headers
 * @property {string} text body as text, empty when there was none
 * @property {any} json parsed body, null when the answer was not JSON
 */

/**
 * @param {unknown} err
 * @returns {string} lesbare Fehlermeldung
 */
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ args */

/**
 * @param {string[]} argv process.argv
 * @returns {ProbeArgs} the parsed command line
 */
function parseArgs(argv) {
    /** @type {ProbeArgs} */
    const args = {
        port: 8080,
        wsPort: 8090,
        seconds: 60,
        out: path.join(process.cwd(), 'ds-probe'),
        user: 'dssadmin',
        createToken: false,
        oldApi: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const next = () => argv[++i];
        switch (key) {
            case '--host':
                args.host = next();
                break;
            case '--port':
                args.port = Number(next());
                break;
            case '--ws-port':
                args.wsPort = Number(next());
                break;
            case '--token':
                args.token = next();
                break;
            case '--create-token':
                args.createToken = true;
                break;
            case '--user':
                args.user = next();
                break;
            case '--seconds':
                args.seconds = Number(next());
                break;
            case '--out':
                args.out = next();
                break;
            case '--old-api':
                args.oldApi = true;
                break;
            case '--discover':
                args.discover = true;
                break;
            case '--probe-write':
                args.probeWrite = next();
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                console.error(`Unbekannte Option: ${key}`);
                process.exit(1);
        }
    }
    return args;
}

/* ------------------------------------------------------------------ http */

/**
 * @param {import('node:https').RequestOptions & {protocol?: string}} options request options, protocol picks http or https
 * @param {string|Buffer} [body] request body, omitted for GET
 * @returns {Promise<HttpAnswer>} status, headers and body of the answer
 */
function request(options, body) {
    return new Promise((resolve, reject) => {
        const transport = options.protocol === 'http:' ? http : https;
        const req = transport.request({ ...options, rejectUnauthorized: false, timeout: 30000 }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                if (text) {
                    try {
                        json = JSON.parse(text);
                    } catch {
                        /* keine JSON Antwort, text bleibt erhalten */
                    }
                }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
        if (body !== undefined) {
            req.end(body);
        } else {
            req.end();
        }
    });
}

/**
 * @param {ProbeArgs} args parsed command line
 * @param {string} apiPath path below the host, e.g. /api/v1/apartment
 * @param {Record<string, string>} [params] query parameters
 * @returns {URL} the assembled URL
 */
function apiUrl(args, apiPath, params) {
    const url = new URL(`https://${args.host}:${args.port}${apiPath}`);
    for (const [key, value] of Object.entries(params || {})) {
        url.searchParams.set(key, value);
    }
    return url;
}

/**
 * @param {ProbeArgs} args parsed command line
 * @param {string} apiPath path below the host
 * @param {Record<string, string>} [params] query parameters
 * @returns {Promise<HttpAnswer>} the answer of request()
 */
async function get(args, apiPath, params) {
    const url = apiUrl(args, apiPath, params);
    return request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: args.token ? { Authorization: `Bearer ${args.token}` } : {},
    });
}

/* ------------------------------------------------------------ websocket */

// Der Websocket-Client liegt in lib/, weil der Adapter ihn ebenfalls braucht
const MiniWebsocket = require('../lib/websocket');

/* ----------------------------------------------------------------- probe */

function save(outDir, name, data) {
    const file = path.join(outDir, `${name}.json`);
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return file;
}

function countDeep(value) {
    return Array.isArray(value) ? value.length : 0;
}

async function createApplicationToken(args) {
    const password = process.env.DSS_PASSWORD;
    if (!password) {
        throw new Error('DSS_PASSWORD ist nicht gesetzt - fuer --create-token noetig');
    }
    const loginUrl = apiUrl(args, '/json/system/login', { user: args.user, password });
    const login = await request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${loginUrl.pathname}${loginUrl.search}`,
        method: 'GET',
    });
    if (!login.json || !login.json.ok || !login.json.result || !login.json.result.token) {
        throw new Error(`Login fehlgeschlagen (HTTP ${login.status}): ${login.json ? login.json.message : login.text}`);
    }
    const sessionToken = login.json.result.token;
    const body = JSON.stringify({
        data: { type: 'applicationToken', attributes: { name: 'ioBroker.digitalstrom probe' } },
    });
    const tokenUrl = apiUrl(args, '/api/v1/apartment/applicationTokens', { token: sessionToken });
    const created = await request(
        {
            protocol: 'https:',
            host: args.host,
            port: args.port,
            path: `${tokenUrl.pathname}${tokenUrl.search}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        body,
    );
    if (created.status !== 201) {
        throw new Error(`Application Token nicht angelegt (HTTP ${created.status}): ${created.text || '-'}`);
    }
    const location = created.headers.location || '';
    const apiKey = location.split('/').filter(Boolean).pop();
    if (!apiKey) {
        throw new Error(`Antwort ohne Location-Header: ${JSON.stringify(created.headers)}`);
    }
    return apiKey;
}

async function probeEndpoints(args, outDir) {
    const endpoints = [
        {
            name: 'apartment',
            path: '/api/v1/apartment',
            params: {
                include:
                    'installation,dsDevices,submodules,functionBlocks,zones,clusters,applications,dsServer,controllers,apiRevision,meterings',
            },
        },
        { name: 'apartment-status', path: '/api/v1/apartment/status', params: { include: 'dsDevices,zones' } },
        { name: 'zones', path: '/api/v1/apartment/zones' },
        { name: 'zones-status', path: '/api/v1/apartment/zones/status' },
        { name: 'dsDevices', path: '/api/v1/apartment/dsDevices' },
        { name: 'dsDevices-status', path: '/api/v1/apartment/dsDevices/status' },
        { name: 'submodules', path: '/api/v1/apartment/submodules' },
        { name: 'functionBlocks', path: '/api/v1/apartment/functionBlocks' },
        { name: 'scenarios', path: '/api/v1/apartment/scenarios' },
        { name: 'meterings', path: '/api/v1/apartment/meterings' },
        { name: 'meterings-values', path: '/api/v1/apartment/meterings/values' },
        { name: 'controllers', path: '/api/v1/apartment/controllers' },
        { name: 'clusters', path: '/api/v1/apartment/clusters' },
        { name: 'userDefinedStates', path: '/api/v1/apartment/userDefinedStates' },
    ];

    const results = [];
    for (const endpoint of endpoints) {
        const started = Date.now();
        let res;
        try {
            res = await get(args, endpoint.path, endpoint.params);
        } catch (err) {
            const message = errorText(err);
            results.push({ name: endpoint.name, path: endpoint.path, status: 'ERROR', error: message });
            console.log(`  ${endpoint.name.padEnd(20)} FEHLER  ${message}`);
            continue;
        }
        const ms = Date.now() - started;
        const bytes = Buffer.byteLength(res.text || '');
        if (res.status === 200 && res.json) {
            save(outDir, endpoint.name, res.json);
        }
        results.push({ name: endpoint.name, path: endpoint.path, status: res.status, ms, bytes });
        console.log(
            `  ${endpoint.name.padEnd(20)} HTTP ${res.status}  ${String(ms).padStart(5)} ms  ${String(bytes).padStart(8)} Bytes`,
        );
    }
    return results;
}

function summarize(outDir) {
    const read = name => {
        const file = path.join(outDir, `${name}.json`);
        if (!fs.existsSync(file)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    };

    const apartment = read('apartment');
    const status = read('apartment-status');
    const scenarios = read('scenarios');
    const meterings = read('meterings');

    console.log('\n--- Inhalt ---');
    if (apartment && apartment.data && apartment.data.included) {
        const included = apartment.data.included;
        console.log(`  Zonen            : ${countDeep(included.zones)}`);
        console.log(`  dS-Geraete       : ${countDeep(included.dsDevices)}`);
        console.log(`  Submodule        : ${countDeep(included.submodules)}`);
        console.log(`  FunctionBlocks   : ${countDeep(included.functionBlocks)}`);
        console.log(`  Controller/dSM   : ${countDeep(included.controllers)}`);
        console.log(`  Meterings        : ${countDeep(included.meterings)}`);
        const functionBlocks = included.functionBlocks || [];
        const outputs = functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.outputs) || []);
        const outputTypes = [...new Set(outputs.map(o => o.attributes && o.attributes.type).filter(Boolean))];
        console.log(`  Outputs gesamt   : ${outputs.length}`);
        console.log(`  Output-Typen     : ${outputTypes.join(', ') || '-'}`);
        console.log(
            `  SensorInputs     : ${functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.sensorInputs) || []).length}`,
        );
        console.log(
            `  ButtonInputs     : ${functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.buttonInputs) || []).length}`,
        );
        const applications = new Set();
        for (const zone of included.zones || []) {
            const attributes = zone.attributes || {};
            for (const app of attributes.applicationTypes || []) {
                applications.add(app);
            }
            for (const app of attributes.applications || []) {
                applications.add(typeof app === 'string' ? app : app && app.id);
            }
        }
        console.log(`  Applications     : ${[...applications].filter(Boolean).join(', ') || '-'}`);
    } else {
        console.log('  Kein verwertbares apartment.json - neue API vermutlich nicht verfuegbar.');
    }

    if (status && status.data) {
        console.log(`  Apartment-Status : ${Object.keys(status.data.attributes || {}).join(', ') || '-'}`);
        const zones = (status.data.included && status.data.included.zones) || [];
        const zoneWithTemperature = zones.find(zone => JSON.stringify(zone).includes('temperature'));
        console.log(`  Heizung im Status: ${zoneWithTemperature ? 'ja' : 'nicht gefunden'}`);
        const devices = (status.data.included && status.data.included.dsDevices) || [];
        const withStates = devices.filter(device => {
            const states = device.attributes && device.attributes.states;
            return Array.isArray(states) && states.length;
        });
        console.log(`  Geraete m. States: ${withStates.length} von ${devices.length}`);
    }

    if (scenarios && scenarios.data) {
        const list = Array.isArray(scenarios.data) ? scenarios.data : scenarios.data.scenarios || [];
        console.log(`  Szenarien        : ${countDeep(list)}`);
    }
    if (meterings && meterings.data) {
        const list = meterings.data.meterings || meterings.data;
        console.log(`  Metering-Punkte  : ${Array.isArray(list) ? list.length : '-'}`);
    }
}

async function probeWebsocket(args, outDir) {
    if (!args.seconds) {
        console.log('\n--- Websocket uebersprungen (--seconds 0) ---');
        return;
    }
    console.log(`\n--- Notification-Websocket (${args.seconds}s Mitschnitt) ---`);
    console.log('  Bitte waehrenddessen etwas schalten: Taster druecken, Licht dimmen, Rollo fahren.');

    const attempts = [
        { port: args.wsPort, secure: false, label: `ws://${args.host}:${args.wsPort}` },
        { port: args.wsPort, secure: true, label: `wss://${args.host}:${args.wsPort}` },
        { port: args.port, secure: true, label: `wss://${args.host}:${args.port}` },
    ];

    for (const attempt of attempts) {
        const ws = new MiniWebsocket({
            host: args.host,
            port: attempt.port,
            path: '/api/v1/apartment/notifications',
            headers: { Authorization: `Bearer ${args.token}` },
            secure: attempt.secure,
        });
        const messages = [];
        ws.on('message', text => {
            const stamp = new Date().toISOString();
            messages.push({ stamp, text });
            console.log(`  [${stamp}] ${text.slice(0, 500)}`);
        });
        ws.on('error', () => {
            /* Fehler nach dem Handshake beenden den Mitschnitt nicht */
        });
        try {
            await ws.connect();
        } catch (err) {
            console.log(`  ${attempt.label} nicht erreichbar: ${errorText(err)}`);
            ws.close();
            continue;
        }
        console.log(`  verbunden ueber ${attempt.label}`);
        const handshake = JSON.stringify({ protocol: 'json', version: 1 });
        ws.send(handshake);
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!messages.length) {
            // Variante mit SignalR-Record-Separator, falls der dSS das Framing erwartet
            console.log('  keine Antwort, versuche Handshake mit Record-Separator');
            ws.send(handshake + RECORD_SEPARATOR);
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, args.seconds - 5) * 1000));
        ws.close();
        save(outDir, 'notifications', messages);
        console.log(`  ${messages.length} Nachricht(en) empfangen -> notifications.json`);
        return;
    }
    console.log('  Kein Websocket erreichbar.');
}

/**
 * Sends any method to a path of the new API.
 *
 * @param {ProbeArgs} args parsed command line
 * @param {string} method HTTP method, e.g. OPTIONS or PATCH
 * @param {string} apiPath path below the host
 * @param {Record<string, string>} [params] query parameters
 * @param {any} [body] json body, serialised as it comes - the shape is what is being probed
 * @returns {Promise<HttpAnswer>} the answer of request()
 */
function verb(args, method, apiPath, params, body) {
    const url = apiUrl(args, apiPath, params);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    /** @type {Record<string, string|number>} */
    const headers = { Authorization: `Bearer ${args.token}` };
    if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return request(
        {
            protocol: 'https:',
            host: args.host,
            port: args.port,
            path: `${url.pathname}${url.search}`,
            method,
            headers,
        },
        payload,
    );
}

/**
 * Second sweep: looks for the values the first sweep did not find - device sensors,
 * binary inputs - and for a way to WRITE user defined states.
 *
 * The first sweep only knew the endpoints of digitalstrom-mqtt. A dSS may well deliver
 * more per single resource than in the collection, and the official documentation is
 * offline, so the only way to find out is to ask the device.
 *
 * @param {ProbeArgs} args parsed command line
 * @param {string} outDir directory the raw answers are written to
 */
async function discover(args, outDir) {
    console.log('\n--- Suche nach weiteren Werten und Endpunkten ---');

    // Beispiel-IDs aus der Struktur, damit die Einzelabrufe echte Objekte treffen
    const apartment = await get(args, '/api/v1/apartment', {
        include: 'dsDevices,submodules,functionBlocks,zones,userDefinedStates',
    });
    const included = (apartment.json && apartment.json.data && apartment.json.data.included) || {};
    const functionBlocks = included.functionBlocks || [];
    const withSensors = functionBlocks.find(fb => ((fb.attributes && fb.attributes.sensorInputs) || []).length);
    const withButtons = functionBlocks.find(fb => ((fb.attributes && fb.attributes.buttonInputs) || []).length);
    const sample = {
        device: (withSensors && withSensors.id) || ((included.dsDevices || [])[0] || {}).id,
        button: (withButtons && withButtons.id) || '',
        submodule: ((included.submodules || [])[0] || {}).id,
        zone: ((included.zones || [])[0] || {}).id,
        state: ((included.userDefinedStates || [])[0] || {}).id,
    };
    console.log(`  Beispiel-Gerät ${sample.device}, Zone ${sample.zone}, Zustand ${sample.state}`);

    const paths = [
        { path: '/api/v1' },
        { path: `/api/v1/apartment/dsDevices/${sample.device}` },
        { path: `/api/v1/apartment/dsDevices/${sample.device}/status` },
        {
            path: `/api/v1/apartment/dsDevices/${sample.device}/status`,
            params: { include: 'sensorInputs,binaryInputs,buttonInputs' },
        },
        { path: `/api/v1/apartment/dsDevices/${sample.device}/sensorInputs` },
        { path: `/api/v1/apartment/dsDevices/${sample.device}/binaryInputs` },
        { path: `/api/v1/apartment/dsDevices/${sample.device}/functionBlocks` },
        { path: `/api/v1/apartment/functionBlocks/${sample.device}` },
        { path: `/api/v1/apartment/functionBlocks/${sample.device}/status` },
        { path: '/api/v1/apartment/functionBlocks/status' },
        { path: '/api/v1/apartment/submodules/status' },
        { path: `/api/v1/apartment/submodules/${sample.submodule}/status` },
        { path: `/api/v1/apartment/zones/${sample.zone}` },
        { path: `/api/v1/apartment/zones/${sample.zone}/status` },
        { path: '/api/v1/apartment/sensors' },
        { path: '/api/v1/apartment/sensorInputs' },
        { path: '/api/v1/apartment/binaryInputs' },
        { path: '/api/v1/apartment/buttonInputs' },
        { path: '/api/v1/apartment/measurements' },
        { path: '/api/v1/apartment/events' },
        { path: `/api/v1/apartment/userDefinedStates/${sample.state}` },
        { path: '/api/v1/apartment/userDefinedStates/status' },
        { path: '/api/v1/apartment/floors' },
        { path: '/api/v1/apartment/installation' },
        // Alles, was der Server an include kennt, auf einmal - unbekannte Namen zeigen sich
        // entweder als Fehler oder werden stillschweigend ignoriert
        {
            path: '/api/v1/apartment/status',
            params: {
                include:
                    'dsDevices,zones,clusters,userDefinedStates,submodules,functionBlocks,sensorInputs,binaryInputs,buttonInputs,scenarios,controllers,meterings,floors,applications,installation,dsServer,apiRevision',
            },
        },
        // Vielleicht liegt die Spezifikation auf dem Geraet selbst
        { path: '/api/v1/openapi.json' },
        { path: '/api/v1/swagger.json' },
        { path: '/api/openapi.json' },
        { path: '/api/v1/spec' },
        { path: '/api/v1/docs' },
    ];

    const findings = [];
    for (const { path: apiPath, params } of paths) {
        let res;
        try {
            res = await get(args, apiPath, params);
        } catch (err) {
            console.log(`  GET ${apiPath.padEnd(58)} FEHLER ${errorText(err)}`);
            findings.push({ method: 'GET', path: apiPath, params, error: errorText(err) });
            continue;
        }
        const bytes = Buffer.byteLength(res.text || '');
        const lower = (res.text || '').toLowerCase();
        const marks = [
            lower.includes('sensor') ? 'sensor' : '',
            lower.includes('binaryinput') ? 'binaryInput' : '',
            lower.includes('buttoninput') ? 'buttonInput' : '',
        ]
            .filter(Boolean)
            .join(' ');
        const query = params ? `${`?${new URLSearchParams(params).toString()}`.slice(0, 30)}…` : '';
        console.log(`  GET ${(apiPath + query).padEnd(58)} ${res.status}  ${String(bytes).padStart(7)} B  ${marks}`);
        findings.push({ method: 'GET', path: apiPath, params, status: res.status, bytes, marks });
        if (res.status === 200 && res.json) {
            save(outDir, `discover-${apiPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`, res.json);
        }
    }

    // Welche Methoden erlaubt der Server? Das beantwortet die Schreibfrage ohne zu schreiben.
    console.log('\n  Erlaubte Methoden (OPTIONS):');
    for (const apiPath of [
        `/api/v1/apartment/userDefinedStates/${sample.state}`,
        `/api/v1/apartment/userDefinedStates/${sample.state}/status`,
        `/api/v1/apartment/dsDevices/${sample.device}/status`,
        `/api/v1/apartment/zones/${sample.zone}/status`,
    ]) {
        try {
            const res = await verb(args, 'OPTIONS', apiPath);
            const allow = res.headers.allow || res.headers['access-control-allow-methods'] || '-';
            console.log(`    ${apiPath.padEnd(60)} ${res.status}  ${allow}`);
            findings.push({ method: 'OPTIONS', path: apiPath, status: res.status, allow });
        } catch (err) {
            console.log(`    ${apiPath.padEnd(60)} FEHLER ${errorText(err)}`);
        }
    }

    if (args.probeWrite) {
        console.log(`\n  Schreibtest auf Zustand ${args.probeWrite}`);
        console.log('  Es wird der AKTUELLE Wert erneut gesetzt, der Zustand ändert sich also nicht.');
        const status = await get(args, '/api/v1/apartment/status', { include: 'userDefinedStates' });
        const states =
            (status.json &&
                status.json.data &&
                status.json.data.included &&
                status.json.data.included.userDefinedStates) ||
            [];
        const current = states.find(s => s.id === args.probeWrite);
        const value = current && current.attributes && current.attributes.status;
        if (!value) {
            console.log(`    Zustand ${args.probeWrite} nicht gefunden - Schreibtest übersprungen`);
        } else {
            console.log(`    aktueller Wert: ${value}`);
            const patch = [{ op: 'replace', path: '/status', value }];
            const attempts = [
                { method: 'PATCH', path: `/api/v1/apartment/userDefinedStates/${args.probeWrite}/status`, body: patch },
                { method: 'PATCH', path: `/api/v1/apartment/userDefinedStates/${args.probeWrite}`, body: patch },
                {
                    method: 'POST',
                    path: `/api/v1/apartment/userDefinedStates/${args.probeWrite}/invoke`,
                    body: { status: value },
                },
            ];
            for (const { method, path: apiPath, body } of attempts) {
                try {
                    const res = await verb(args, method, apiPath, undefined, body);
                    console.log(`    ${method} ${apiPath.padEnd(62)} ${res.status} ${(res.text || '').slice(0, 80)}`);
                    findings.push({ method, path: apiPath, status: res.status, body: (res.text || '').slice(0, 200) });
                } catch (err) {
                    console.log(`    ${method} ${apiPath.padEnd(62)} FEHLER ${errorText(err)}`);
                }
            }
        }
    }

    save(outDir, '_summary-discover', findings);
    const ok = findings.filter(f => f.status === 200 && f.method === 'GET');
    console.log(`\n  ${ok.length} von ${paths.length} Pfaden antworten mit 200.`);
}

async function probeOldApi(args, outDir) {
    console.log('\n--- Alte JSON-API zum Vergleich ---');
    const password = process.env.DSS_PASSWORD;
    if (!password) {
        console.log('  uebersprungen (DSS_PASSWORD nicht gesetzt)');
        return;
    }
    const loginUrl = apiUrl(args, '/json/system/login', { user: args.user, password });
    const login = await request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${loginUrl.pathname}${loginUrl.search}`,
        method: 'GET',
    });
    if (!login.json || !login.json.ok) {
        console.log('  Login fehlgeschlagen');
        return;
    }
    const sessionToken = login.json.result.token;
    for (const [name, apiPath] of [
        ['old-version', '/json/system/version'],
        ['old-structure', '/json/apartment/getStructure'],
    ]) {
        const url = apiUrl(args, apiPath, { token: sessionToken });
        const started = Date.now();
        const res = await request({
            protocol: 'https:',
            host: args.host,
            port: args.port,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
        });
        const ms = Date.now() - started;
        const bytes = Buffer.byteLength(res.text || '');
        if (res.json) {
            save(outDir, name, res.json);
        }
        console.log(
            `  ${name.padEnd(20)} HTTP ${res.status}  ${String(ms).padStart(5)} ms  ${String(bytes).padStart(8)} Bytes`,
        );
        if (name === 'old-version' && res.json && res.json.result) {
            console.log(`  dSS Version: ${res.json.result.version || JSON.stringify(res.json.result)}`);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.host) {
        const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
        console.log(header.replace(/^#![^\n]*\n/, '').replace(/^\/\*\*/, ''));
        process.exit(args.host ? 0 : 1);
    }
    fs.mkdirSync(args.out, { recursive: true });

    console.log(`dSS: ${args.host}:${args.port}, Ausgabe: ${args.out}\n`);

    if (!args.token && args.createToken) {
        console.log('--- Application Token anlegen ---');
        args.token = await createApplicationToken(args);
        console.log(`  API-Key: ${args.token}`);
        console.log('  Bitte notieren. Loeschbar im dSS unter System > Zugriffsberechtigung.\n');
        fs.writeFileSync(path.join(args.out, 'apikey.txt'), `${args.token}\n`, { mode: 0o600 });
    }
    if (!args.token) {
        console.error('Kein API-Key. Entweder --token <key> oder --create-token angeben.');
        process.exit(1);
    }

    if (args.discover) {
        // Zweiter Durchgang: sucht gezielt nach dem, was der erste nicht gefunden hat
        await discover(args, args.out);
        console.log(`\nFertig. Alle Rohdaten liegen in ${args.out}`);
        return;
    }

    console.log('--- REST-Endpunkte /api/v1 ---');
    const results = await probeEndpoints(args, args.out);
    save(args.out, '_summary-endpoints', results);
    summarize(args.out);

    if (args.oldApi) {
        await probeOldApi(args, args.out);
    }

    await probeWebsocket(args, args.out);

    console.log(`\nFertig. Alle Rohdaten liegen in ${args.out}`);
}

main().catch(err => {
    console.error(`\nAbbruch: ${errorText(err)}`);
    process.exit(1);
});
