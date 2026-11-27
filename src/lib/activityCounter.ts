/**
 * Zaehlt Ereignisse je Kennung ueber ein gleitendes Fenster - die Datenbasis fuer
 * "x empfangen / y gesendet in den letzten 10 Minuten" im Status-Tab.
 *
 * Minutengenaue Eimer statt Zeitstempel-Listen: die Groesse ist damit unabhaengig
 * davon, wie viel Verkehr laeuft, und das Fenster rundet auf ganze Eimer.
 */

const DEFAULT_WINDOW = 10 * 60 * 1000;
const DEFAULT_BUCKET = 60 * 1000;

class ActivityCounter {
    /**
     * @param {object} [options]
     * @param {number} [options.windowMs] Fensterbreite, Standard 10 Minuten
     * @param {number} [options.bucketMs] Eimerbreite, Standard 1 Minute
     * @param {() => number} [options.now] fuer Tests
     */
    constructor(options) {
        const opts = options || {};
        this.windowMs = opts.windowMs || DEFAULT_WINDOW;
        this.bucketMs = opts.bucketMs || DEFAULT_BUCKET;
        this.now = opts.now || Date.now;
        /** @type {Map<string, Map<number, number>>} Kennung -> (Eimerstart -> Anzahl) */
        this.buckets = new Map();
    }

    /**
     * @param {string} metric z.B. "classic.events"
     * @param {number} [amount]
     */
    count(metric, amount = 1) {
        const bucketStart = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
        let perMetric = this.buckets.get(metric);
        if (!perMetric) {
            perMetric = new Map();
            this.buckets.set(metric, perMetric);
        }
        perMetric.set(bucketStart, (perMetric.get(bucketStart) || 0) + amount);
        // Alte Eimer gleich hier wegwerfen, damit nichts unbegrenzt waechst. EIN Eimer
        // mehr als das Fenster breit ist, weil der aelteste ueber den Fensteranfang
        // hinausragt und in snapshot() anteilig zaehlt.
        const oldest = bucketStart - this.windowMs - this.bucketMs;
        for (const start of perMetric.keys()) {
            if (start < oldest) {
                perMetric.delete(start);
            }
        }
    }

    /**
     * Summe je Kennung ueber GENAU windowMs bis jetzt.
     *
     * Frueher lief das Fenster von Eimergrenze zu Eimergrenze: gezaehlt wurden neun
     * volle Minuten plus den schon verstrichenen Teil der laufenden - im Mittel 9,5
     * statt 10. Ausgewiesen wurden trotzdem 10 Minuten, gemessen an einer echten
     * Anlage also rund 5 % zu wenig, und zwar immer in dieselbe Richtung. Der
     * ueberlappende aelteste Eimer geht deshalb anteilig ein. Das unterstellt eine
     * Gleichverteilung innerhalb dieser einen Minute - viel weniger falsch als ein
     * systematischer Fehlbetrag, und die Anzeige bleibt live.
     *
     * @returns {Record<string, number>} Summe je Kennung innerhalb des Fensters
     */
    snapshot() {
        const windowStart = this.now() - this.windowMs;
        /** @type {Record<string, number>} */
        const result = {};
        for (const [metric, perMetric] of this.buckets) {
            let sum = 0;
            for (const [start, amount] of perMetric) {
                const end = start + this.bucketMs;
                if (end <= windowStart) {
                    continue;
                }
                if (start >= windowStart) {
                    sum += amount;
                    continue;
                }
                sum += (amount * (end - windowStart)) / this.bucketMs;
            }
            result[metric] = Math.round(sum);
        }
        return result;
    }
}

module.exports = ActivityCounter;
