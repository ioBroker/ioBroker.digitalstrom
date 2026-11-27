// Central normalization of adapter configuration values and of thrown error values.
//
// The admin UI delivers real booleans, but the instance object can also be written by
// hand, by a script or by a restored backup. A plain truthiness check would then turn
// the string "false" into true - which for deleteUnknownObjects would silently enable a
// destructive function. All boolean options therefore go through normalizeBoolean().

const TRUE_WORDS = ['true', '1', 'yes', 'on', 'ja'];
const FALSE_WORDS = ['false', '0', 'no', 'off', 'nein'];

/**
 * An error as it travels through this adapter.
 *
 * Besides the message the adapter attaches structured markers so that consumers do not
 * have to parse message texts:
 * - `code`/`status`/`status_code`: transport and DSS answer details
 * - `timeout`: request timeout produced by our own client
 * - `shutdown`: the request was cancelled because the adapter is stopping
 * - `superseded`: a queued value was replaced by a newer one before it was sent
 */
export type AdapterError = Error & {
    code?: string;
    status?: number;
    status_code?: number;
    timeout?: boolean;
    shutdown?: boolean;
    superseded?: boolean;
    cause?: unknown;
};

/**
 * Answer of the DSS JSON API. Every endpoint returns at least `ok`, plus `result` on
 * success and `message` on failure.
 *
 * The DSS JSON API is untyped by nature: `result` carries a different shape for every
 * endpoint, so it is modelled as `any` deliberately.
 */
export type DssResponse = { ok?: boolean; message?: string; status_code?: number; result?: any } & Record<string, any>;

/**
 * Readable text of a value that was thrown or handed over as an error.
 *
 * A `catch` binding is `unknown`, and the DSS layer also passes plain strings around.
 * This keeps the previously used `(err && err.message) || err` output but works for
 * every input type.
 *
 * @param err thrown value, error object, string or nothing at all
 * @returns message of the error, or the value itself as text
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message || String(err);
    }
    if (err && typeof err === 'object' && 'message' in err && err.message) {
        // Whatever the message is, it is turned into text - that is the point of this function
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        return String(err.message);
    }
    return String(err);
}

/**
 * Narrows a thrown value to the error shape used in this adapter.
 *
 * Everything that is not an Error (strings, DSS answer objects) returns null, so the
 * caller has to handle that case explicitly instead of accessing properties blindly.
 *
 * @param err thrown value
 * @returns the same object, typed, or null
 */
export function asError(err: unknown): AdapterError | null {
    return err instanceof Error ? err : null;
}

/**
 * Marks an error as caused by the adapter stop and returns it unchanged.
 * Values that are not errors are passed through untouched.
 *
 * @param err thrown value
 * @returns the same value
 */
export function markShutdown(err: unknown): unknown {
    const error = asError(err);
    if (error) {
        error.shutdown = true;
    }
    return err;
}

/**
 * Converts a configuration value into a boolean.
 *
 * Anything that cannot be interpreted unambiguously falls back to defaultValue - an
 * invalid value must never enable a function on its own.
 *
 * @param value raw value from the instance configuration
 * @param [defaultValue] value used for empty or uninterpretable input
 * @returns normalized value
 */
export function normalizeBoolean(value: unknown, defaultValue = false): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === null || value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'number') {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
        return defaultValue;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
            return defaultValue;
        }
        if (TRUE_WORDS.includes(normalized)) {
            return true;
        }
        if (FALSE_WORDS.includes(normalized)) {
            return false;
        }
        return defaultValue;
    }
    // objects, arrays, functions, symbols - never a valid configuration value
    return defaultValue;
}

/**
 * True when the value can be interpreted as a boolean at all. Used to warn about
 * configuration values that silently fall back to their default.
 *
 * @param value raw value from the instance configuration
 * @returns true if normalizeBoolean() derives the result from the value itself
 */
export function isInterpretableBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return value === 0 || value === 1;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return TRUE_WORDS.includes(normalized) || FALSE_WORDS.includes(normalized);
    }
    return false;
}
