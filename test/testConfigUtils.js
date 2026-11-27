const assert = require('node:assert');
const { normalizeBoolean, isInterpretableBoolean } = require('../build/lib/configUtils');

describe('configUtils.normalizeBoolean', () => {
    // [input, result with default false, result with default true]
    const cases = [
        ['boolean true', true, true, true],
        ['boolean false', false, false, false],
        ['string "true"', 'true', true, true],
        ['string "false"', 'false', false, false],
        ['string "TRUE"', 'TRUE', true, true],
        ['string " False "', ' False ', false, false],
        ['number 1', 1, true, true],
        ['number 0', 0, false, false],
        ['string "1"', '1', true, true],
        ['string "0"', '0', false, false],
        ['string "yes"', 'yes', true, true],
        ['string "no"', 'no', false, false],
        ['string "on"', 'on', true, true],
        ['string "off"', 'off', false, false],
        ['empty string', '', false, true],
        ['whitespace', '   ', false, true],
        ['null', null, false, true],
        ['undefined', undefined, false, true],
        ['invalid string', 'vielleicht', false, true],
        ['object', {}, false, true],
        ['array', [], false, true],
        ['number 2', 2, false, true],
        ['NaN', NaN, false, true],
    ];

    cases.forEach(([label, input, withFalseDefault, withTrueDefault]) => {
        it(`${label} -> ${withFalseDefault} / ${withTrueDefault}`, () => {
            assert.strictEqual(normalizeBoolean(input, false), withFalseDefault, 'default false');
            assert.strictEqual(normalizeBoolean(input, true), withTrueDefault, 'default true');
        });
    });

    it('defaults to false when no default is given', () => {
        assert.strictEqual(normalizeBoolean(undefined), false);
        assert.strictEqual(normalizeBoolean('nonsense'), false);
    });

    it('never turns an uninterpretable value into true when the default is false', () => {
        // This is the safety rule for destructive options like deleteUnknownObjects
        ['false', '0', 'no', 'off', '', '   ', 'vielleicht', null, undefined, {}, [], 2, NaN].forEach(value => {
            assert.strictEqual(
                normalizeBoolean(value, false),
                false,
                `${JSON.stringify(value)} must not enable anything`,
            );
        });
    });

    it('marks values that cannot be interpreted', () => {
        [true, false, 'true', 'false', 'YES', ' off ', 0, 1].forEach(value =>
            assert.strictEqual(isInterpretableBoolean(value), true, `${JSON.stringify(value)}`),
        );
        ['', '  ', 'vielleicht', null, undefined, {}, [], 2, NaN].forEach(value =>
            assert.strictEqual(isInterpretableBoolean(value), false, `${JSON.stringify(value)}`),
        );
    });
});
