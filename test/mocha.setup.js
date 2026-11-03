// Don't silently swallow unhandled rejections
process.on('unhandledRejection', e => {
    throw e;
});

// enable the should interface with sinon
// and load chai-as-promised and sinon-chai by default
// chai and its two plugins are ESM from version 5 on. Node loads them through require()
// since 22.12, but what comes back is the module namespace, which carries the plugin under
// .default - use() would be handed an object and fail with "fn is not a function". The
// unwrapping passes a plain function through unchanged, so it also works the other way.
const sinonChai = require('sinon-chai');
const chaiAsPromised = require('chai-as-promised');
const { should, use } = require('chai');

/**
 * @param {any} mod what require() returned for a chai plugin
 * @returns {any} the plugin function itself
 */
const plugin = mod => (mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod);

should();
use(plugin(sinonChai));
use(plugin(chaiAsPromised));
