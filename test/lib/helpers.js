// Small typed helpers for the tests.
//
// They exist mainly so the callback style of this adapter can be awaited without every
// `new Promise()` needing its own type hint - a declared return type gives TypeScript the
// Promise type parameter it needs for a `resolve()` without arguments.

/**
 * Resolves after the given time.
 *
 * @param {number} ms milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps a function that reports completion through a callback into a promise.
 *
 * @param {(done: () => void) => void} run receives the callback that resolves the promise
 * @returns {Promise<void>}
 */
function callbackPromise(run) {
    return new Promise(resolve => run(() => resolve()));
}

/**
 * Wraps a callback that reports an error as its first argument into a promise.
 *
 * @param {(done: (err?: unknown) => void) => void} run receives the node style callback
 * @returns {Promise<void>}
 */
function nodeCallbackPromise(run) {
    return new Promise((resolve, reject) =>
        run(err => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())),
    );
}

/**
 * Waits until a condition holds instead of until a clock says it should.
 *
 * A fixed timeout is a bet on how fast the runner is, and this repository has lost that
 * bet before: a timing test that passed everywhere failed on windows-latest, where the
 * event loop can stall far longer than a local machine ever does.
 *
 * @param {() => boolean} condition checked repeatedly until it holds
 * @param {number} [timeout] milliseconds before giving up
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeout = 5000) {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) {
            throw new Error('waitFor: condition not reached in time');
        }
        await delay(10);
    }
}

module.exports = { delay, callbackPromise, nodeCallbackPromise, waitFor };
