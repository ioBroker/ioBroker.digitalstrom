#!/usr/bin/env node
/**
 * Stellt die Zählerstände beider APIs nebeneinander.
 *
 * Die Einheit ist geklärt (Wattsekunden, die Angabe "Wh" der neuen API ist falsch, siehe
 * docs). Offen bleibt, ob beide APIs denselben Zähler meinen - wenn nicht, würde der
 * kWh-State beim Umstellen springen und die History verfälschen.
 *
 * Das Skript liest beide Quellen und rechnet sie in kWh um, genau wie der Adapter es tut:
 *     meterValue / 3600 / 1000
 *
 * Nur lesend. Das Passwort wird ausschliesslich aus DSS_PASSWORD gelesen, nie geloggt.
 *
 * Benutzung:
 *   DSS_PASSWORD='...' node scripts/compare-meterings.js \
 *       --host 192.168.1.10 --token-file ds-probe/apikey.txt
 *
 * Optionen:
 *   --host <ip|name>       dSS Adresse (Pflicht)
 *   --token <apiKey>       Bearer-Key der neuen API
 *   --token-file <datei>   Key aus einer Datei lesen
 *   --user <name>          Login-Benutzer der alten API (Default dssadmin)
 */

const fs = require('node:fs');

const DSS = require('../lib/dss');
const DSSSmartHome = require('../lib/dssSmartHome');

function parseArgs(argv) {
    const args = { user: 'dssadmin' };
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
            case '--user':
                args.user = next();
                break;
            default:
                console.error(`Unbekannte Option: ${argv[i]}`);
                process.exit(1);
        }
    }
    return args;
}

/**
 * @param {number} meterValue Zählerstand in Wattsekunden
 * @returns {number} Kilowattstunden, gerundet wie im Adapter
 */
function toKwh(meterValue) {
    return meterValue / 3600 / 1000;
}

async function main() {
    const args = parseArgs(process.argv);
    const password = process.env.DSS_PASSWORD;
    if (!args.host || !args.token) {
        console.error('Aufruf: DSS_PASSWORD=... node scripts/compare-meterings.js --host <dss> --token <apiKey>');
        process.exit(1);
    }
    if (!password) {
        console.error('DSS_PASSWORD ist nicht gesetzt - ohne Login der alten API kein Vergleich.');
        process.exit(1);
    }

    const dss = new DSS({ host: args.host, appToken: '', logger: null });
    const smart = new DSSSmartHome({ host: args.host, apiKey: args.token });

    try {
        const login = await dss.httpRequest('/json/system/login', { user: args.user, password });
        if (!login || login.ok !== true || !login.result || !login.result.token) {
            throw new Error(`Login fehlgeschlagen: ${(login && login.message) || 'unbekannt'}`);
        }
        const token = login.result.token;

        // Alte API: erst die Klemmen, dann je Klemme zwei Requests - genau das, was der
        // Adapter heute alle 100 Sekunden tut
        const circuits = await dss.httpRequest('/json/apartment/getCircuits', { token });
        const metering = ((circuits.result && circuits.result.circuits) || []).filter(c => c.hasMetering);
        console.log(`Klemmen mit Zähler: ${metering.length}\n`);

        const oldStarted = Date.now();
        const oldValues = new Map();
        for (const circuit of metering) {
            const energy = await dss.httpRequest('/json/circuit/getEnergyMeterValue', {
                token,
                dsuid: circuit.dSUID,
            });
            const power = await dss.httpRequest('/json/circuit/getConsumption', {
                token,
                dsuid: circuit.dSUID,
            });
            oldValues.set(circuit.dSUID, {
                name: circuit.name,
                meterValue: energy.result && energy.result.meterValue,
                consumption: power.result && power.result.consumption,
            });
        }
        const oldMs = Date.now() - oldStarted;
        const oldRequests = metering.length * 2;

        // Neue API: ein Request fuer alles
        const newStarted = Date.now();
        const values = await smart.getMeteringValues();
        const newMs = Date.now() - newStarted;
        const newValues = new Map();
        for (const entry of values.values) {
            newValues.set(entry.id, entry.attributes && entry.attributes.value);
        }

        console.log('--- Zählerstände (Wattsekunden) ---');
        console.log(
            `  ${'Klemme'.padEnd(22)} ${'alt'.padStart(14)} ${'neu'.padStart(14)} ${'Differenz'.padStart(12)}  ${'alt kWh'.padStart(10)} ${'neu kWh'.padStart(10)}`,
        );
        let worst = 0;
        for (const [dsuid, old] of oldValues) {
            const fresh = newValues.get(`dsm-${dsuid}-energy`);
            const diff = fresh === undefined ? NaN : fresh - old.meterValue;
            if (Number.isFinite(diff)) {
                worst = Math.max(worst, Math.abs(diff));
            }
            console.log(
                `  ${String(old.name).slice(0, 22).padEnd(22)} ${String(old.meterValue).padStart(14)} ` +
                    `${String(fresh === undefined ? '(fehlt)' : fresh).padStart(14)} ${String(Number.isFinite(diff) ? diff : '-').padStart(12)}  ` +
                    `${toKwh(old.meterValue).toFixed(3).padStart(10)} ${(fresh === undefined ? NaN : toKwh(fresh)).toFixed(3).padStart(10)}`,
            );
        }

        console.log('\n--- Leistung (W) ---');
        for (const [dsuid, old] of oldValues) {
            const fresh = newValues.get(`dsm-${dsuid}-power`);
            console.log(
                `  ${String(old.name).slice(0, 22).padEnd(22)} alt ${String(old.consumption).padStart(6)} W   ` +
                    `neu ${String(fresh === undefined ? '(fehlt)' : fresh).padStart(6)} W`,
            );
        }

        console.log('\n--- Aufwand ---');
        console.log(`  alte API: ${oldRequests} Requests in ${oldMs} ms`);
        console.log(`  neue API:  1 Request in ${newMs} ms`);

        console.log('\n--- Urteil ---');
        // Zwischen den beiden Abfragen vergeht Zeit, der Zähler läuft weiter. Bei ein paar
        // hundert Watt sind das einige tausend Wattsekunden - alles darunter ist derselbe
        // Zähler, ein Sprung wäre um Größenordnungen größer.
        const seconds = (oldMs + newMs) / 1000;
        const tolerance = Math.max(20000, seconds * 2000);
        if (!Number.isFinite(worst)) {
            console.log('  Nicht vergleichbar - eine Klemme fehlt in der neuen API.');
        } else if (worst < tolerance) {
            console.log(
                `  Größte Abweichung ${Math.round(worst)} Ws = ${toKwh(worst).toFixed(5)} kWh, ` +
                    `unter der Toleranz von ${Math.round(tolerance)} Ws.`,
            );
            console.log('  Beide APIs führen denselben Zähler. Ein Umstellen lässt die States stehen.');
        } else {
            console.log(`  ACHTUNG: größte Abweichung ${Math.round(worst)} Ws = ${toKwh(worst).toFixed(3)} kWh.`);
            console.log('  Das ist mehr als der Zeitversatz erklärt - die Zähler sind NICHT identisch.');
        }
    } finally {
        smart.stop();
        dss.stop();
    }
}

main().catch(err => {
    console.error(`\nAbbruch: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
