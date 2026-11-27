const { expect } = require('chai');

const SmartHomeOutputSync = require('../lib/dssSmartHomeSync');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { waitFor } = require('./lib/helpers');

/**
 * Wartet auf eine Bedingung statt einer festen Zeit - feste Wartefenster in
 * Kombination mit exakten Zaehl-Erwartungen kippen auf langsamen CI-Runnern
 * (beobachtet auf windows-latest).
 *
 * @param {() => boolean} condition
 * @param {number} [timeout]
 */
/**
 * The sync needs very little of the structure - exactly this surface.
 *
 * @returns {any}
 */
function createFakeStructure() {
    const written = [];
    const classicReads = [];
    const warnings = [];
    return {
        written,
        classicReads,
        warnings,
        initialObjectValues: {},
        isAdapterStopping: () => false,
        setClearableTimeout: (func, ms) => setTimeout(func, ms),
        setStateSafe(id, value) {
            written.push({ id, value });
        },
        queueClassicOutputRead(dev, outputType, prio, options) {
            classicReads.push({
                dSUID: dev.dSUID,
                outputType,
                prio,
                report: !options || options.report !== false,
            });
        },
        adapterLog: {
            silly: () => {},
            debug: () => {},
            info: () => {},
            warn: message => warnings.push(message),
            error: () => {},
        },
    };
}

/**
 * @param {any} structure
 * @param {any} smartHome
 * @param {object} [options]
 * @returns {SmartHomeOutputSync}
 */
function createSync(structure, smartHome, options) {
    return new SmartHomeOutputSync({
        structure,
        smartHome,
        adapter: { log: structure.adapterLog },
        debounce: 30,
        followUpDelay: 40,
        maxFollowUps: 2,
        failureBackoff: 60 * 1000,
        ...options,
    });
}

/**
 * @param {string} dSUID
 * @param {Record<string, number|undefined>} outputs output id to value; undefined = no value field
 * @returns {any} one dsDeviceStatus entry
 */
function statusDevice(dSUID, outputs) {
    return {
        id: dSUID,
        type: 'dsDeviceStatus',
        attributes: {
            functionBlocks: [
                {
                    id: dSUID,
                    outputs: Object.entries(outputs).map(([id, value]) =>
                        value === undefined ? { id, status: 'moving' } : { id, value, status: 'ok' },
                    ),
                },
            ],
        },
    };
}

const SHADE = () => ({
    dSUID: 'shade1',
    outputChannelList: {
        shadePositionOutside: 'devices.m1.shade1.shadePositionOutside',
        shadeOpeningAngleOutside: 'devices.m1.shade1.shadeOpeningAngleOutside',
    },
});

describe('Smart Home output sync', function () {
    this.timeout(10000);

    it('collects several devices into one status request and writes rounded values', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return {
                    included: {
                        dsDevices: [
                            statusDevice('shade1', { shadePositionOutside: 32.004272526131075 }),
                            statusDevice('light1', { brightness: 79.2156862745098 }),
                        ],
                    },
                };
            },
        });

        const lightValues = [];
        const light = {
            dSUID: 'light1',
            outputChannelList: { brightness: 'devices.m1.light1.brightness' },
            applyNativeLightValue: value => lightValues.push(value),
        };
        const shade = SHADE();
        expect(sync.requestDeviceSync(shade, ['shadePositionOutside'])).to.equal(true);
        expect(sync.requestDeviceSync(light, ['brightness'])).to.equal(true);
        await delay(100);

        expect(statusCalls, 'both devices share one request').to.equal(1);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 32 }]);
        expect(structure.initialObjectValues['devices.m1.shade1.shadePositionOutside']).to.equal(32);
        // 79.2156862745098 % are exactly 202 in the native 0..255 scale of the light
        // helper, which also maintains the boolean .state of the light
        expect(lightValues).to.deep.equal([202]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    // Waehrend ein Rollladen faehrt, fehlt das value-Feld im Status. Fehlend heisst
    // "unveraendert lassen" - niemals null schreiben, und spaeter noch einmal nachsehen.
    it('leaves a moving output untouched and picks it up with a follow-up', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return {
                    included: {
                        dsDevices: [
                            statusDevice('shade1', {
                                shadePositionOutside: statusCalls === 1 ? undefined : 64.5,
                            }),
                        ],
                    },
                };
            },
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(35);
        expect(structure.written, 'no value while the blind moves').to.have.lengthOf(0);

        await delay(60);
        expect(statusCalls, 'a follow-up asked again').to.equal(2);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 65 }]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    it('falls back to the classic read once the follow-ups are exhausted', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            // The output never carries a value
            getApartmentStatus: async () => ({
                included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: undefined })] },
            }),
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(250);

        // report: false - a single undeliverable channel does not put the classic
        // path in charge, so info.outputApi stays untouched
        expect(structure.classicReads).to.deep.equal([
            { dSUID: 'shade1', outputType: 'shadePositionOutside', prio: 'medium', report: false },
        ]);
        expect(structure.written).to.have.lengthOf(0);
    });

    it('falls back immediately and pauses itself when the status request fails', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                throw new Error('connection refused');
            },
        });

        const shade = SHADE();
        sync.requestDeviceSync(shade, ['shadePositionOutside', 'shadeOpeningAngleOutside']);
        await delay(60);

        expect(structure.classicReads.map(read => read.outputType).sort()).to.deep.equal([
            'shadeOpeningAngleOutside',
            'shadePositionOutside',
        ]);
        // Here the classic path really takes over - these reads DO report
        expect(structure.classicReads.every(read => read.report)).to.equal(true);
        expect(structure.warnings, 'the fallback is said once').to.have.lengthOf(1);
        expect(structure.warnings[0]).to.contain('classic API');
        // During the backoff every new trigger goes classic right away
        expect(sync.isAvailable()).to.equal(false);
        expect(sync.requestDeviceSync(shade, ['shadePositionOutside'])).to.equal(false);
    });

    // Boolean-Kanaele (airLouverAuto & Co) sind gegen die neue API nicht verifiziert.
    // Der Sync reicht sie an queueClassicOutputRead durch - ob dort wirklich ein Request
    // entsteht, entscheidet der channelIndex des Kanals (heute: nein, debug-Skip). Wichtig
    // ist, dass NIE ein geratener Wert geschrieben wird.
    it('hands boolean channels to the classic read instead of guessing', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: { dsDevices: [statusDevice('vent1', { airLouverAuto: 1 })] },
            }),
        });

        sync.requestDeviceSync(
            { dSUID: 'vent1', outputChannelList: { airLouverAuto: 'devices.m1.vent1.airLouverAuto' } },
            ['airLouverAuto'],
        );
        await delay(60);

        expect(structure.written).to.have.lengthOf(0);
        expect(structure.classicReads).to.deep.equal([
            { dSUID: 'vent1', outputType: 'airLouverAuto', prio: 'medium', report: false },
        ]);
    });

    it('treats a device the status does not know like a moving output', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({ included: { dsDevices: [] } }),
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(250);

        // Never applied, so after the follow-ups the classic read has the last word
        expect(structure.classicReads).to.deep.equal([
            { dSUID: 'shade1', outputType: 'shadePositionOutside', prio: 'medium', report: false },
        ]);
    });

    // Ein Trigger, der eintrifft, waehrend die Statusabfrage schon unterwegs ist, darf
    // nicht mit deren Antwort bedient werden - die zeigt den Stand von DAVOR
    it('does not satisfy a trigger with an answer that was already on its way', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        /** @type {(value: any) => void} */
        let resolveFirst = () => {};
        const sync = createSync(structure, {
            getApartmentStatus: () => {
                statusCalls++;
                if (statusCalls === 1) {
                    return new Promise(resolve => (resolveFirst = resolve));
                }
                return Promise.resolve({
                    included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 55 })] },
                });
            },
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(40);
        expect(statusCalls, 'the first read is on its way').to.equal(1);
        // The blind starts moving AGAIN while the answer is in flight
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        // ... and the in-flight answer carries the position from before that move
        resolveFirst({ included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 10 })] } });
        await delay(80);

        expect(statusCalls, 'a second read serves the second trigger').to.equal(2);
        expect(
            structure.written.map(write => write.value),
            'the stale 10 must never be written',
        ).to.deep.equal([55]);
    });

    it('pulls a far follow-up timer forward for a fresh trigger', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(
            structure,
            {
                getApartmentStatus: async () => {
                    statusCalls++;
                    return {
                        included: {
                            dsDevices: [
                                // The blind never answers, the light always does
                                statusDevice('shade1', { shadePositionOutside: undefined }),
                                statusDevice('light1', { brightness: 50 }),
                            ],
                        },
                    };
                },
            },
            { followUpDelay: 5000 },
        );

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(40);
        expect(statusCalls).to.equal(1);
        // The follow-up timer is armed for 5 s - the light must not wait for it
        const lightValues = [];
        sync.requestDeviceSync(
            {
                dSUID: 'light1',
                outputChannelList: { brightness: 'devices.m1.light1.brightness' },
                applyNativeLightValue: value => lightValues.push(value),
            },
            ['brightness'],
        );
        await delay(60);
        expect(statusCalls, 'the fresh trigger pulled the read forward').to.equal(2);
        expect(lightValues).to.deep.equal([Math.round(50 * 2.55)]);
    });

    // Manche Kanaele beantwortet der Status STRUKTURELL nie (gemessen: die Outputs von
    // Audio-Geraeten fehlen komplett). Nach zwei verbrauchten Follow-up-Budgets wird
    // das gelernt - ab dann sofort klassisch, ohne 60 s Warten und ohne Status-Requests.
    it('learns a channel the status never answers and serves it classically right away', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return { included: { dsDevices: [] } };
            },
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        // Budget verbraucht = der Fallback-Read ist da; die Zahl der Statusreads bis
        // dahin ist deterministisch (initial + 2 Follow-ups), nur ihr Zeitpunkt nicht
        await waitFor(() => structure.classicReads.length === 1);
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await waitFor(() => structure.classicReads.length === 2);
        expect(statusCalls, 'two full follow-up budgets were burned').to.equal(6);

        // The third trigger goes classic immediately - no debounce, no status request
        expect(sync.requestDeviceSync(SHADE(), ['shadePositionOutside'])).to.equal(true);
        expect(structure.classicReads).to.have.lengthOf(3);
        expect(structure.classicReads[2]).to.deep.equal({
            dSUID: 'shade1',
            outputType: 'shadePositionOutside',
            prio: 'medium',
            report: false,
        });
        await delay(150);
        expect(statusCalls, 'the learned channel costs no further status request').to.equal(6);
    });

    it('forgets a learned gap once the status answers the channel again', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: {
                    dsDevices: [
                        statusDevice('shade1', { shadePositionOutside: 40 }),
                        statusDevice('light1', { brightness: 50 }),
                    ],
                },
            }),
        });

        sync.undeliverable.set('shade1|shadePositionOutside', sync.now());
        expect(sync.requestDeviceSync(SHADE(), ['shadePositionOutside']), 'learned goes classic').to.equal(true);
        expect(structure.classicReads).to.have.lengthOf(1);

        // The next status answer (fetched for the light) carries the value - unlearned
        sync.requestDeviceSync(
            {
                dSUID: 'light1',
                outputChannelList: { brightness: 'devices.m1.light1.brightness' },
                applyNativeLightValue: () => {},
            },
            ['brightness'],
        );
        await waitFor(() => sync.undeliverable.size === 0);

        // ... so the next trigger goes through the status again
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await waitFor(() => structure.written.length === 1);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 40 }]);
        expect(structure.classicReads, 'no second classic read').to.have.lengthOf(1);
    });

    // Live gemessen (dSS20 1.19.13, 01.09.2026): ein fahrender Rollladen laesst value
    // weg, traegt aber status "moving", initialValue 100, targetValue 0 und ein
    // startedAt/terminatesAt-Fenster - hier 24,8 s. Die Dauer kommt IMMER vom dSS,
    // jede Fahrt jedes Geraets bringt ihre eigene mit.
    describe('a travelling output', () => {
        const START = Date.parse('2026-09-01T06:26:46.012Z');
        const END = Date.parse('2026-09-01T06:27:10.812Z');

        /**
         * @returns {any} eine Statusantwort mit fahrendem Rollladen, Form wie gemessen
         */
        function travellingStatus() {
            return {
                included: {
                    dsDevices: [
                        {
                            id: 'shade1',
                            type: 'dsDeviceStatus',
                            attributes: {
                                functionBlocks: [
                                    {
                                        id: 'shade1',
                                        outputs: [
                                            {
                                                id: 'shadePositionOutside',
                                                status: 'moving',
                                                initialValue: 100,
                                                targetValue: 0,
                                                startedAt: '2026-09-01T06:26:46.012Z',
                                                terminatesAt: '2026-09-01T06:27:10.812Z',
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    ],
                },
            };
        }

        it('is interpolated from the journey the status carries', () => {
            // Auf halber Strecke: 100 -> 0 in 24,8 s, nach 12,4 s also 50
            const half = SmartHomeOutputSync.travelPosition(
                travellingStatus().included.dsDevices[0].attributes.functionBlocks[0].outputs[0],
                START + (END - START) / 2,
            );
            expect(Math.round(/** @type {number} */ (half))).to.equal(50);
        });

        it('holds the start position when the clock runs before the travel', () => {
            const output = travellingStatus().included.dsDevices[0].attributes.functionBlocks[0].outputs[0];
            expect(SmartHomeOutputSync.travelPosition(output, START - 60000)).to.equal(100);
        });

        // Am Ziel klemmen hiesse behaupten, der Rollladen sei angekommen - live gesehen
        // stand dadurch 2,1 s zu frueh die 100 im State, obwohl er noch fuhr
        it('writes nothing once the announced end has passed', () => {
            const output = travellingStatus().included.dsDevices[0].attributes.functionBlocks[0].outputs[0];
            expect(SmartHomeOutputSync.travelPosition(output, END), 'genau am Ende').to.equal(undefined);
            expect(SmartHomeOutputSync.travelPosition(output, END + 60000), 'danach').to.equal(undefined);
            // Kurz davor wird noch interpoliert - und eben NICHT auf das Ziel 0 gerundet
            // (100 -> 0 in 24,8 s, eine Sekunde vor Schluss also 4)
            const nearly = SmartHomeOutputSync.travelPosition(output, END - 1000);
            expect(Math.round(/** @type {number} */ (nearly))).to.equal(4);
        });

        // Nach dem angekuendigten Ende muss die naechste Abfrage SCHNELL kommen, sonst
        // wartet der echte Endwert die volle Follow-up-Zeit
        it('asks again quickly right after the announced end', async () => {
            const structure = createFakeStructure();
            let nowValue = END + 1000;
            let statusCalls = 0;
            const sync = createSync(
                structure,
                {
                    getApartmentStatus: async () => {
                        statusCalls++;
                        // Erst beim dritten Mal liefert der dSS den echten Wert
                        return statusCalls < 3
                            ? travellingStatus()
                            : { included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 100 })] } };
                    },
                },
                { followUpDelay: 5000 },
            );
            sync.now = () => nowValue;

            sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
            await waitFor(() => structure.written.length === 1, 3000);

            expect(statusCalls, 'die Nachlese lief im Debounce-Takt, nicht im 5-s-Takt').to.equal(3);
            expect(structure.written, 'nur der echte Endwert steht im State').to.deep.equal([
                { id: 'devices.m1.shade1.shadePositionOutside', value: 100 },
            ]);
            sync.stop();
        });

        it('ignores an output that is not travelling', () => {
            expect(SmartHomeOutputSync.travelPosition({ id: 'x', value: 5, status: 'ok' }, START)).to.equal(undefined);
            expect(
                SmartHomeOutputSync.travelPosition({ id: 'x', status: 'moving', initialValue: 100 }, START),
                'without a target and a window there is nothing to compute',
            ).to.equal(undefined);
        });

        // Der ganze Zweck: der State folgt der Fahrt, bleibt aber offen, bis der
        // echte Endwert da ist
        it('writes the position during the travel and keeps the channel pending', async () => {
            const structure = createFakeStructure();
            const nowValue = START + 12400;
            let statusCalls = 0;
            const sync = createSync(
                structure,
                {
                    getApartmentStatus: async () => {
                        statusCalls++;
                        return travellingStatus();
                    },
                },
                // Die Nachlese liegt bewusst weit weg: dieser Test prueft die ERSTE
                // Antwort, und ein zweiter Durchlauf waere auf einem langsamen Runner
                // ein Rennen gegen die feste Wartezeit
                { followUpDelay: 5000 },
            );
            sync.now = () => nowValue;

            sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
            await waitFor(() => structure.written.length === 1);

            expect(statusCalls).to.equal(1);
            expect(structure.written, 'die halbe Strecke steht im State').to.deep.equal([
                { id: 'devices.m1.shade1.shadePositionOutside', value: 50 },
            ]);
            expect(sync.pending.has('shade1'), 'der Kanal bleibt offen bis zum Endwert').to.equal(true);
            expect(structure.classicReads, 'kein Fallback waehrend der Fahrt').to.have.lengthOf(0);
            sync.stop();
        });

        // Ohne diese Ausnahme wuerde eine lange Fahrt das Follow-up-Budget aufbrauchen
        // und am Ende beim klassischen Read landen
        it('does not burn the follow up budget while the travel runs', async () => {
            const structure = createFakeStructure();
            const nowValue = START + 1000;
            let statusCalls = 0;
            const sync = createSync(structure, {
                getApartmentStatus: async () => {
                    statusCalls++;
                    return travellingStatus();
                },
            });
            sync.now = () => nowValue;

            sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
            // Mehrere Runden abwarten - genau dabei wuerde ein Versuch verbraucht
            await waitFor(() => statusCalls >= 3);

            const entry = /** @type {any} */ (sync.pending.get('shade1'));
            expect(entry, 'noch offen').to.not.equal(undefined);
            expect(entry.attempts, 'kein verbrauchter Versuch').to.equal(0);
            expect(structure.classicReads).to.have.lengthOf(0);
            sync.stop();
        });
    });

    // CIE x/y kommen im Status als 0..1 (live: 0.2235/0.3921) - die States halten
    // 0..10000. Ohne die Skalierung machte Math.round seit 2.4.18 aus jeder
    // Koordinate 0 oder 1
    it('scales the CIE x/y coordinates of the status to the state range', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: { dsDevices: [statusDevice('hue1', { x: 0.2235, y: 0.3921 })] },
            }),
        });

        sync.requestDeviceSync(
            {
                dSUID: 'hue1',
                outputChannelList: { x: 'devices.m1.hue1.x', y: 'devices.m1.hue1.y' },
            },
            ['x', 'y'],
        );
        await delay(60);

        expect(structure.written.sort((a, b) => a.id.localeCompare(b.id))).to.deep.equal([
            { id: 'devices.m1.hue1.x', value: 2235 },
            { id: 'devices.m1.hue1.y', value: 3921 },
        ]);
    });

    // Wuerde die ganze Anlage gelernt (degradierte 200-Antworten ohne Werte), liefe nie
    // wieder ein Status-Request und die Heilung koennte nie greifen - deshalb wird ein
    // gelernter Kanal nach relearnInterval einmal neu ueber den Status probiert
    it('probes a learned channel through the status again after the relearn interval', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(
            structure,
            {
                getApartmentStatus: async () => {
                    statusCalls++;
                    return { included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 70 })] } };
                },
            },
            { relearnInterval: 50 },
        );

        sync.undeliverable.set('shade1|shadePositionOutside', sync.now());
        // Fresh entry: still classic, no status request
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(60);
        expect(statusCalls).to.equal(0);
        expect(structure.classicReads).to.have.lengthOf(1);

        // The entry is older than the interval now - the next trigger probes the status,
        // the answer carries a value and heals the learning for good
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await waitFor(() => structure.written.length === 1);
        expect(statusCalls, 'the probe went through the status').to.equal(1);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 70 }]);
        expect(sync.undeliverable.size).to.equal(0);
        expect(structure.classicReads, 'no second classic read').to.have.lengthOf(1);
    });

    // Die stuendliche Probe eines gelernten Kanals kostete das volle Folgebudget: vier
    // Status-Antworten je Runde, gemessen zwoelf von vierundachtzig in drei Stunden, und
    // geheilt hat sie nie. Eine Probe ist eine Frage, keine Erwartung.
    it('gives up a pure probe after one unanswered status instead of four', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(
            structure,
            {
                // Antwortet ohne den geprobten Kanal - genau der Fall, den die Probe klaert
                getApartmentStatus: async () => {
                    statusCalls++;
                    return { included: { dsDevices: [statusDevice('shade1', {})] } };
                },
            },
            { relearnInterval: 20, followUpDelay: 10 },
        );

        sync.undeliverable.set('shade1|shadePositionOutside', sync.now() - 1000);
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);

        await waitFor(() => sync.undeliverable.has('shade1|shadePositionOutside'));
        expect(statusCalls, 'one unanswered status is answer enough for a probe').to.equal(1);
        expect(sync.pending.size, 'and the entry is done, not waiting for three more').to.equal(0);
    });

    // Sobald ein echter Auslöser dazukommt, ist der Eintrag keine blosse Frage mehr
    it('gives the full budget back as soon as a real trigger joins a probe', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(
            structure,
            {
                getApartmentStatus: async () => {
                    statusCalls++;
                    return { included: { dsDevices: [statusDevice('shade1', {})] } };
                },
            },
            { relearnInterval: 20, followUpDelay: 10 },
        );

        sync.undeliverable.set('shade1|shadePositionOutside', sync.now() - 1000);
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        // Ein Kanal ohne Lernvermerk - dafuer wartet jemand wirklich auf einen Wert
        sync.requestDeviceSync(SHADE(), ['shadeOpeningAngleOutside']);

        await waitFor(() => statusCalls >= 3, 2000);
        expect(statusCalls, 'a real trigger is worth the full follow-up budget').to.be.at.least(3);
    });

    // Der dSS meldet die eine class-64-Shade-Bank nur unter den ...Outside-Ids, obwohl
    // GR-KL300-Bloecke auch die ...Indoor-Kanaele deklarieren. Der klassische Read
    // (getConfig class 64) wuerde beiden denselben Wert liefern - der Alias auch.
    it('serves the declared indoor shade channels from the outside ids of the status', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: {
                    dsDevices: [statusDevice('umr1', { shadePositionOutside: 100, shadeOpeningAngleOutside: 25.2 })],
                },
            }),
        });

        sync.requestDeviceSync(
            {
                dSUID: 'umr1',
                outputChannelList: {
                    shadePositionIndoor: 'devices.m1.umr1.shadePositionIndoor',
                    shadeOpeningAngleIndoor: 'devices.m1.umr1.shadeOpeningAngleIndoor',
                },
            },
            ['shadePositionIndoor', 'shadeOpeningAngleIndoor'],
        );
        await delay(60);

        expect(structure.written.sort((a, b) => a.id.localeCompare(b.id))).to.deep.equal([
            { id: 'devices.m1.umr1.shadeOpeningAngleIndoor', value: 25 },
            { id: 'devices.m1.umr1.shadePositionIndoor', value: 100 },
        ]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    // Eine geschaltete Steckdose (SW-KL200) deklariert powerLevel, der Status meldet
    // den Wert aber als level-Feld eines powerState-Outputs - und zwar 0..1 statt
    // 0..100 (live gemessen: 0 bei aus, 1 bei versorgtem Geraet; 2.4.19 schrieb
    // deshalb "1 %"). Der Alias skaliert auf den 0..100-State und klemmt den Wert
    it('maps the power level a socket reports as the level of its powerState output', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: {
                    dsDevices: [
                        {
                            id: 'socket1',
                            type: 'dsDeviceStatus',
                            attributes: {
                                functionBlocks: [
                                    {
                                        id: 'socket1',
                                        outputs: [
                                            { id: 'powerState', value: 2, status: 'ok', targetValue: 2, level: 1 },
                                        ],
                                    },
                                ],
                            },
                        },
                    ],
                },
            }),
        });

        sync.requestDeviceSync(
            {
                dSUID: 'socket1',
                outputChannelList: {
                    powerLevel: 'devices.m1.socket1.powerLevel',
                    powerState: 'devices.m1.socket1.powerState',
                },
            },
            ['powerLevel', 'powerState'],
        );
        await delay(60);

        expect(structure.written.sort((a, b) => a.id.localeCompare(b.id))).to.deep.equal([
            { id: 'devices.m1.socket1.powerLevel', value: 100 },
            { id: 'devices.m1.socket1.powerState', value: 2 },
        ]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    // Nicht nur das Fake: die ECHTE DSSStructure muss den Sync anlegen und ihre
    // Szenen-/Initial-Pfade wirklich hindurch routen
    it('is wired into the real structure', async () => {
        const { EventEmitter } = require('node:events');
        const DSSStructure = require('../lib/dssStructure');
        const classicReads = [];
        const infoStates = [];
        let statusCalls = 0;
        const struct = /** @type {any} */ (
            new DSSStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueUpdateOutputValue: (dev, index, length, prio, callback) => {
                        classicReads.push({ index, length, prio });
                        setImmediate(() => callback && callback(null, 0));
                    },
                    queueSetOutputValue: () => {},
                    pushQueryQueue: (channel, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
                    config: { initializeOutputValues: true, usePresetValues: false },
                    setState: (id, value, ack) => infoStates.push({ id, value, ack }),
                    isStopping: () => false,
                },
                smartHome: {
                    getApartmentStatus: async () => {
                        statusCalls++;
                        return {
                            included: {
                                dsDevices: [
                                    statusDevice('dev1', {
                                        shadePositionOutside: 32.004272526131075,
                                        shadeOpeningAngleOutside: 50,
                                    }),
                                ],
                            },
                        };
                    },
                },
                smartHomeSyncOptions: { debounce: 20, followUpDelay: 30, maxFollowUps: 1 },
            })
        );
        const written = [];
        struct.setStateSafe = (id, value) => written.push({ id, value });
        const positionId = 'devices.m1.dev1.shadePositionOutside';
        const angleId = 'devices.m1.dev1.shadeOpeningAngleOutside';
        struct.dssObjects[positionId] = { type: 'state', common: {}, native: {} };
        struct.dssObjects[angleId] = { type: 'state', common: {}, native: {} };

        struct.createShaderDevice(
            {
                dSUID: 'dev1',
                meterDSUID: 'm1',
                name: 'Rollladen',
                outputChannelList: { shadePositionOutside: positionId, shadeOpeningAngleOutside: angleId },
            },
            'devices.m1.dev1',
            () => {},
        );
        await delay(80);

        expect(statusCalls, 'the initial reads went through ONE status request').to.equal(1);
        expect(classicReads, 'no classic read was queued').to.have.lengthOf(0);
        // Die Arbeitsteilung ist sichtbar: info.outputApi zeigt den liefernden Weg
        expect(infoStates).to.deep.equal([{ id: 'info.outputApi', value: 'smarthome', ack: true }]);
        expect(written.sort((a, b) => a.id.localeCompare(b.id))).to.deep.equal([
            { id: angleId, value: 50 },
            { id: positionId, value: 32 },
        ]);
        struct.clearTimeouts();
    });

    // Der Minimalfix gegen das Hin- und Herspringen von info.outputApi: vom Sync
    // uebergebene Einzel-Reads (report: false) melden nicht, direkte klassische
    // Reads melden weiterhin
    it('keeps info.outputApi untouched for a classic read without report', async () => {
        const DSSStructure = require('../lib/dssStructure');
        const infoStates = [];
        const struct = /** @type {any} */ (
            new DSSStructure({
                dss: {},
                dssQueue: {
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 128)),
                },
                adapter: {
                    log: { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
                    config: {},
                    setState: (id, value, ack) => infoStates.push({ id, value, ack }),
                    isStopping: () => false,
                },
            })
        );
        struct.setStateSafe = () => {};
        const dev = { dSUID: 'd1', outputChannelList: { shadePositionOutside: 'devices.m1.d1.shadePositionOutside' } };

        struct.queueClassicOutputRead(dev, 'shadePositionOutside', 'medium', { report: false });
        await delay(20);
        expect(infoStates, 'no report without the flag').to.have.lengthOf(0);

        struct.queueClassicOutputRead(dev, 'shadePositionOutside', 'medium');
        await delay(20);
        expect(infoStates).to.deep.equal([{ id: 'info.outputApi', value: 'classic', ack: true }]);
    });

    it('does nothing after stop()', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return { included: { dsDevices: [] } };
            },
        });
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        sync.stop();
        await delay(80);
        expect(statusCalls).to.equal(0);
        expect(structure.classicReads).to.have.lengthOf(0);
    });
});

describe('Scene names and zone temperature through the Smart Home API', function () {
    this.timeout(10000);

    const DSSStructure = require('../lib/dssStructure');
    const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    /**
     * @param {any} smartHome
     * @param {object} [options]
     * @returns {any}
     */
    function createStructure(smartHome, options) {
        return /** @type {any} */ (
            new DSSStructure({
                dss: {},
                dssQueue: {},
                adapter: { isStopping: () => false, setState: () => {}, config: {}, log: silentLog },
                smartHome,
                ...options,
            })
        );
    }

    it('loads the scenario names once and keys them by zone, group and scene', done => {
        const struct = createStructure({
            getScenarios: async () => ({
                scenarios: [
                    { id: 'applicationZone-z1-g1-s17', attributes: { name: 'Hell' } },
                    { id: 'applicationZone-z4-g48-s5', attributes: { name: 'Bad warm' } },
                    // Szenen ohne Namen und fremde Ids liefern keinen Eintrag
                    { id: 'applicationZone-z2-g2-s5', attributes: {} },
                    { id: 'somethingElse', attributes: { name: 'x' } },
                ],
            }),
        });
        struct.loadScenarioNames(() => {
            expect(struct.scenarioNames).to.deep.equal({ '1.1.17': 'Hell', '4.48.5': 'Bad warm' });
            done();
        });
    });

    it('keeps starting when the scenario request fails', done => {
        const struct = createStructure({
            getScenarios: async () => {
                throw new Error('gone');
            },
        });
        struct.loadScenarioNames(() => {
            expect(struct.scenarioNames).to.deep.equal({});
            done();
        });
    });

    it('writes setpoint and control value of a zone from the status answer', () => {
        const struct = createStructure(null);
        const written = [];
        struct.setStateSafe = (id, value) => written.push({ id, value });
        struct.zoneSensorBaseIds['4'] = 'apartment.0.4.sensors';
        struct.dssObjects['apartment.0.4.sensors.NominalValue'] = {};
        struct.dssObjects['apartment.0.4.sensors.ControlValue'] = {};

        const count = struct.applyZoneTemperatureStatus({
            included: {
                zones: [
                    {
                        id: '4',
                        attributes: {
                            applications: [
                                // Modus-Strings werden bewusst NICHT uebernommen
                                { id: 'temperature', setpoint: 21.5, controlValue: 40, mode: 'heating' },
                                { id: 'lights', status: 'on' },
                            ],
                        },
                    },
                    // Unbekannte Zone und Zone ohne Temperaturregelung sind folgenlos
                    { id: '9', attributes: { applications: [{ id: 'temperature', setpoint: 20 }] } },
                    { id: '4711', attributes: { applications: [] } },
                ],
            },
        });

        expect(count).to.equal(2);
        expect(written).to.deep.equal([
            { id: 'apartment.0.4.sensors.NominalValue', value: 21.5 },
            { id: 'apartment.0.4.sensors.ControlValue', value: 40 },
        ]);
    });

    // Die Meldungen kommen im Sekundentakt (jede Zaehleraenderung erzeugt eine) und
    // jeder Abgleich kostet einen 59-KB-Statusread - deshalb die harte Ratenbremse
    it('rate limits the notification driven reconciliation', () => {
        let nowValue = 0;
        const struct = createStructure(null, { now: () => nowValue, outputReconcileMinInterval: 1000 });
        struct.adapter.config = { initializeOutputValues: true };
        const requests = [];
        struct.smartHomeSync = {
            requestDeviceSync: dev => {
                requests.push(dev.dSUID);
                return true;
            },
        };
        struct.devicesByDsuid = {
            a: { dSUID: 'a', outputChannelList: { brightness: 'devices.m.a.brightness' } },
            b: { dSUID: 'b', outputChannelList: {} },
            c: { dSUID: 'c' },
        };

        expect(struct.reconcileOutputValues(), 'the first notification reconciles').to.equal(true);
        expect(requests, 'only devices with output channels').to.deep.equal(['a']);
        nowValue = 500;
        expect(struct.reconcileOutputValues(), 'inside the interval nothing happens').to.equal(false);
        nowValue = 1500;
        expect(struct.reconcileOutputValues(), 'after the interval it reconciles again').to.equal(true);
        expect(requests).to.deep.equal(['a', 'a']);
    });
});

describe('Activity counters', function () {
    // Zwei absichtlich scheiternde Verbindungsaufbauten - auf langsamen CI-Runnern
    // kann das laenger dauern als die 2 s Mocha-Standard-Timeout
    this.timeout(10000);
    const ActivityCounter = require('../lib/activityCounter');

    it('sums per metric over the rolling window and forgets the rest', () => {
        let nowValue = 0;
        const counter = new ActivityCounter({ windowMs: 10 * 60 * 1000, bucketMs: 60 * 1000, now: () => nowValue });
        counter.count('classic.events');
        counter.count('classic.events');
        counter.count('smarthome.requests');
        nowValue = 5 * 60 * 1000;
        counter.count('classic.events');
        expect(counter.snapshot()).to.deep.equal({ 'classic.events': 3, 'smarthome.requests': 1 });

        // Nach elf Minuten sind die ersten Eimer aus dem Fenster gefallen
        nowValue = 11 * 60 * 1000;
        expect(counter.snapshot()).to.deep.equal({ 'classic.events': 1, 'smarthome.requests': 0 });
        nowValue = 16 * 60 * 1000;
        expect(counter.snapshot()).to.deep.equal({ 'classic.events': 0, 'smarthome.requests': 0 });
    });

    it('covers exactly the window it announces, not a bucket less', () => {
        let nowValue = 0;
        const counter = new ActivityCounter({ windowMs: 10 * 60 * 1000, bucketMs: 60 * 1000, now: () => nowValue });
        // Sechzig Ereignisse in der ersten Minute, danach nichts mehr
        for (let i = 0; i < 60; i++) {
            counter.count('classic.requests');
        }

        // Eine halbe Minute nach Ablauf der zehn Minuten liegt die Haelfte der ersten
        // Minute noch im Fenster - frueher fiel der ganze Eimer schlagartig heraus
        nowValue = 10 * 60 * 1000 + 30 * 1000;
        expect(counter.snapshot()['classic.requests'], 'der Randeimer zaehlt anteilig').to.equal(30);

        // Und exakt nach elf Minuten ist er vollstaendig draussen
        nowValue = 11 * 60 * 1000;
        expect(counter.snapshot()['classic.requests']).to.equal(0);
    });

    it('is announced by both clients for every request', async () => {
        const DSSSmartHome = require('../lib/dssSmartHome');
        const seen = [];
        const client = new DSSSmartHome({
            host: 'http://127.0.0.1:1',
            apiKey: 'x',
            onActivity: (kind, path) => seen.push([kind, path]),
        });
        // Der Request scheitert (nichts lauscht auf Port 1) - gezaehlt wird VOR dem Senden
        await client.getMeteringValues().catch(() => {});
        client.stop();
        expect(seen).to.deep.equal([['request', '/api/v1/apartment/meterings/values']]);

        // Und der klassische Client, aus dessen Hook der Status-Tab die Ereignis- und
        // Befehls-Zaehler speist - derselbe Trick, gezaehlt wird ebenfalls VOR dem Senden
        const DSS = require('../lib/dss');
        const seenClassic = [];
        const classic = new DSS({
            host: 'http://127.0.0.1:1',
            appToken: 'x',
            onActivity: (kind, path) => seenClassic.push([kind, path]),
        });
        await classic.httpRequest('/json/apartment/getName').catch(() => {});
        classic.stop();
        expect(seenClassic).to.deep.equal([['request', '/json/apartment/getName']]);
    });
});
