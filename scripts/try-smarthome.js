#!/usr/bin/env node
/**
 * Live-Test des neuen API-Clients gegen einen echten dSS.
 *
 * Zeigt drei Dinge, die vor dem eigentlichen Umbau feststehen müssen:
 *   1. Struktur und Status kommen in je EINEM Request und wie lange das dauert
 *   2. Der Notification-Websocket meldet Änderungen und die Entprellung greift
 *   3. Nach jeder Meldung wird der Status neu gelesen und die Abweichung angezeigt -
 *      damit sieht man unmittelbar, ob Schalten im Haus hier ankommt
 *
 * Nur lesend, solange --set nicht angegeben wird.
 *
 * Benutzung:
 *   node scripts/try-smarthome.js --host 192.168.1.10 --token <apiKey> --seconds 120
 *   node scripts/try-smarthome.js --host 192.168.1.10 --token-file ds-probe/apikey.txt
 *
 * Optionen:
 *   --host <ip|name>       dSS Adresse (Pflicht)
 *   --token <apiKey>       Bearer-Key der neuen API
 *   --token-file <datei>   Key aus einer Datei lesen
 *   --seconds <n>          Dauer des Mitschnitts (Default 120, 0 = nur lesen)
 *   --debounce <ms>        Entprellung (Default 400)
 *   --meters <n>           Zaehler alle n Sekunden lesen (Default 30, 0 = aus)
 *   --set <spec>           EIN Schreibtest, Form geraet:ausgang=wert
 *                          z.B. --set 06a440901a4e5c14c0193dc4e96e8cd100:brightness=30
 */

const fs = require('node:fs');

const DSSSmartHome = require('../lib/dssSmartHome');

function parseArgs(argv) {
    const args = { seconds: 120, debounce: 400, meters: 30 };
    for (let i = 2; i < argv.length; i++) {
        const next = () => argv[++i];
        switch (argv[i]) {
            case '--host':
                args.host = next();
                break;
            case '--token':
                args.token = next();
                break;
            case '--token-file':
                args.token = fs.readFileSync(next(), 'utf8').trim();
                break;
            case '--seconds':
                args.seconds = Number(next());
                break;
            case '--debounce':
                args.debounce = Number(next());
                break;
            case '--set':
                args.set = next();
                break;
            case '--meters':
                args.meters = Number(next());
                break;
            default:
                console.error(`Unbekannte Option: ${argv[i]}`);
                process.exit(1);
        }
    }
    return args;
}

/**
 * Reduziert den Status auf ein flaches Bild aus Pfad -> Wert, damit sich zwei
 * Abfragen vergleichen lassen.
 *
 * @param {any} status Antwort von getApartmentStatus()
 * @returns {Map<string, string>}
 */
function flatten(status) {
    const flat = new Map();
    const included = (status && status.included) || {};
    for (const device of included.dsDevices || []) {
        for (const block of (device.attributes && device.attributes.functionBlocks) || []) {
            for (const output of block.outputs || []) {
                flat.set(`${device.id}/${output.id}`, String(output.value));
            }
        }
        for (const state of (device.attributes && device.attributes.states) || []) {
            flat.set(`${device.id}/state/${state.id}`, String(state.value));
        }
    }
    for (const zone of included.zones || []) {
        const attributes = zone.attributes || {};
        for (const [key, value] of Object.entries(attributes.measurements || {})) {
            flat.set(`zone ${zone.id}/${key}`, String(value));
        }
        for (const application of attributes.applications || []) {
            for (const [key, value] of Object.entries(application)) {
                if (key !== 'id') {
                    flat.set(`zone ${zone.id}/${application.id}/${key}`, String(value));
                }
            }
        }
    }
    for (const state of included.userDefinedStates || []) {
        flat.set(`state ${state.id}`, String(state.attributes && state.attributes.status));
    }
    return flat;
}

/**
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]} lesbare Zeilen der Unterschiede
 */
function diff(before, after) {
    const lines = [];
    for (const [key, value] of after) {
        const old = before.get(key);
        if (old !== value) {
            lines.push(`${key}: ${old === undefined ? '(neu)' : old} -> ${value}`);
        }
    }
    for (const key of before.keys()) {
        if (!after.has(key)) {
            lines.push(`${key}: entfallen`);
        }
    }
    return lines;
}

/**
 * @param {any} values Antwort von getMeteringValues()
 * @returns {Map<string, number>} Zaehler-ID -> Wert
 */
function meterMap(values) {
    const map = new Map();
    for (const entry of (values && values.values) || []) {
        map.set(entry.id, entry.attributes && entry.attributes.value);
    }
    return map;
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.host || !args.token) {
        console.error('Aufruf: node scripts/try-smarthome.js --host <dss> --token <apiKey> [--seconds 120]');
        process.exit(1);
    }

    const client = new DSSSmartHome({
        host: args.host,
        apiKey: args.token,
        notificationDebounce: args.debounce,
        logger: { debug: message => console.log(`  [debug] ${message}`) },
    });

    const stop = () => {
        client.stop();
        process.exit(0);
    };
    process.on('SIGINT', stop);

    console.log(`dSS ${args.host}\n`);

    console.log('--- Struktur und Status ---');
    let started = Date.now();
    const apartment = await client.getApartment();
    const structureMs = Date.now() - started;
    const included = apartment.included || {};
    console.log(
        `  Struktur   ${String(structureMs).padStart(5)} ms   ` +
            `${(included.dsDevices || []).length} Geräte, ${(included.zones || []).length} Zonen, ` +
            `${(included.scenarios || []).length} Szenarien, ${(included.meterings || []).length} Zähler`,
    );

    started = Date.now();
    let status = await client.getApartmentStatus();
    console.log(`  Status     ${String(Date.now() - started).padStart(5)} ms`);

    started = Date.now();
    const meters = await client.getMeteringValues();
    console.log(
        `  Zähler     ${String(Date.now() - started).padStart(5)} ms   ` +
            `${((meters && meters.values) || []).length} Werte in einem Request`,
    );

    let snapshot = flatten(status);
    console.log(`  ${snapshot.size} beobachtbare Werte im Status\n`);

    if (args.set) {
        const match = /^([^:]+):([^=]+)=(.+)$/.exec(args.set);
        if (!match) {
            console.error('--set erwartet die Form geraet:ausgang=wert');
            process.exit(1);
        }
        const [, device, output, value] = match;
        console.log(`--- Schreibtest: ${device} ${output} = ${value} ---`);
        await client.setOutputValue(device, device, output, Number(value));
        console.log('  gesendet\n');
    }

    if (!args.seconds) {
        client.stop();
        return;
    }

    console.log(`--- Notifications (${args.seconds}s, Entprellung ${args.debounce} ms) ---`);
    console.log('  Jetzt im Haus schalten: Taster drücken, Licht dimmen, Rollo fahren.\n');

    let events = 0;
    let reads = 0;
    let rawNotifications = 0;
    client.on('statusChanged', async () => {
        events++;
        const readStarted = Date.now();
        try {
            const fresh = await client.getApartmentStatus();
            reads++;
            const next = flatten(fresh);
            const changes = diff(snapshot, next);
            snapshot = next;
            const stamp = new Date().toISOString().slice(11, 23);
            console.log(`  [${stamp}] Änderung, Status in ${Date.now() - readStarted} ms:`);
            if (!changes.length) {
                console.log('    (keine Abweichung sichtbar - vermutlich ein Wert, den die neue API nicht führt)');
            }
            for (const line of changes.slice(0, 12)) {
                console.log(`    ${line}`);
            }
            if (changes.length > 12) {
                console.log(`    ... und ${changes.length - 12} weitere`);
            }
        } catch (err) {
            console.log(`  Status konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    client.on('notification', type => {
        rawNotifications++;
        // Sofortige Rueckmeldung: so sieht man beim Tasterdruck direkt, ob der dSS ueberhaupt meldet
        const stamp = new Date().toISOString().slice(11, 23);
        console.log(`  [${stamp}] Rohmeldung ${rawNotifications}: ${type}`);
    });
    client.on('structureChanged', () => console.log('  Strukturänderung gemeldet'));
    client.on('notificationConnected', () => console.log('  Websocket verbunden'));
    client.on('notificationClosed', () => console.log('  Websocket getrennt, verbinde neu'));

    await client.startNotifications();

    // Zaehler kommen nicht ueber Notifications, die muessen abgefragt werden
    /** @type {NodeJS.Timeout|null} */
    let meterTimer = null;
    let meterReads = 0;
    let meterSnapshot = meterMap(meters);
    if (args.meters) {
        meterTimer = setInterval(async () => {
            try {
                const values = meterMap(await client.getMeteringValues());
                meterReads++;
                const changes = [];
                for (const [id, value] of values) {
                    const old = meterSnapshot.get(id);
                    if (old !== value) {
                        changes.push(`${id}: ${old} -> ${value}`);
                    }
                }
                meterSnapshot = values;
                const stamp = new Date().toISOString().slice(11, 19);
                const power = [...values].filter(([id]) => id.endsWith('-power'));
                console.log(
                    `  [${stamp}] Zähler: ${power
                        .map(([id, value]) => `${id.replace(/^dsm-|-power$/g, '').slice(-6)}=${value}W`)
                        .join(' ')}`,
                );
                if (changes.length) {
                    console.log(`            ${changes.length} Werte geändert`);
                }
            } catch (err) {
                console.log(`  Zähler nicht lesbar: ${err instanceof Error ? err.message : String(err)}`);
            }
        }, args.meters * 1000);
    }

    await new Promise(resolve => setTimeout(resolve, args.seconds * 1000));
    if (meterTimer) {
        clearInterval(meterTimer);
    }

    console.log(`\n--- Bilanz ---`);
    console.log(
        `  ${rawNotifications} Rohmeldungen -> ${events} entprellte Ereignisse, ` +
            `${reads} Statusabfragen, ${meterReads} Zählerabfragen in ${args.seconds}s`,
    );
    client.stop();
}

main().catch(err => {
    console.error(`\nAbbruch: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
