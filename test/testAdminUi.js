const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

// The admin interface is a built React app since 2.4.10. A stale or missing bundle
// would leave the configuration dialog empty, and admin reports nothing about it,
// so the parts that have to fit together are checked here.
describe('Admin interface', () => {
    it('io-package.json announces the html configuration', () => {
        const ioPackage = readJson('io-package.json');
        expect(ioPackage.common.adminUI).to.deep.equal({ config: 'html' });
    });

    it('the built entry point exists and is loaded by index.html', () => {
        const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
        expect(html, 'index.html has to load the bundle').to.contain('./assets/index.js');
        expect(html).to.contain('id="root"');

        const bundle = path.join(root, 'admin', 'assets', 'index.js');
        expect(fs.existsSync(bundle), 'run "npm run build:admin"').to.be.true;
        expect(fs.statSync(bundle).size, 'the bundle looks truncated').to.be.greaterThan(100000);
    });

    // Comparing the built bundle byte by byte turned out to be unreliable: the same
    // commit produced a matching bundle on one runner and a differing one on another,
    // which failed the release of 2.4.10. The fingerprint of the sources is stable
    // everywhere, so it is what gets compared.
    it('the bundle was built from the current sources', () => {
        const { hashSources, target } = require('../scripts/adminSourcesHash.cjs');
        expect(fs.existsSync(target), 'run "npm run build:admin"').to.be.true;
        const stored = fs.readFileSync(target, 'utf8').trim();
        expect(stored, 'src-admin changed without a rebuild - run "npm run build:admin"').to.equal(hashSources());
    });

    // 2.4.10 shipped a dialog that could not connect at all: @iobroker/socket-client
    // does not bring socket.io along, it expects the page to have loaded it. Without the
    // tag below the dialog only says "Socket library could not be loaded!".
    it('the page loads the socket library of the admin', () => {
        const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
        expect(html, 'the admin serves socket.io at /lib/js/socket.io.js').to.contain('lib/js/socket.io.js');
        expect(html, 'socket-client uses this hook instead of polling').to.contain('registerSocketOnLoad');
    });

    // GenericApp.onPrepareLoad decrypts the fields of its own encryptedFields option and
    // additionally those of encryptedNative. A field named in both is decrypted twice,
    // which yields the ciphertext again - and saving from there stores a token the adapter
    // cannot use. encryptedNative alone is what counts.
    it('the app token is declared for decryption exactly once', () => {
        const ioPackage = readJson('io-package.json');
        expect(ioPackage.encryptedNative, 'belongs at the root, not into common').to.include('appToken');

        const app = fs.readFileSync(path.join(root, 'src-admin', 'src', 'App.jsx'), 'utf8');
        const active = app.split('\n').filter(line => !line.trim().startsWith('//'));
        expect(active.join('\n'), 'encryptedNative already covers it').to.not.contain('encryptedFields:');
    });

    it('the icon referred to by io-package.json is next to the bundle', () => {
        const ioPackage = readJson('io-package.json');
        expect(fs.existsSync(path.join(root, 'admin', ioPackage.common.icon))).to.be.true;
    });

    describe('translations', () => {
        const dir = path.join(root, 'src-admin', 'src', 'i18n');
        const languages = fs
            .readdirSync(dir)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace('.json', ''));

        it('covers the languages of io-package.json', () => {
            expect(languages).to.include.members(['en', 'de']);
            expect(languages.length, 'a language went missing').to.be.at.least(11);
        });

        it('every language has the same keys as english', () => {
            const reference = Object.keys(readJson(`src-admin/src/i18n/en.json`)).sort();
            languages.forEach(lang => {
                const keys = Object.keys(readJson(`src-admin/src/i18n/${lang}.json`)).sort();
                expect(keys, `${lang}.json differs from en.json`).to.deep.equal(reference);
            });
        });

        it('every text asked for by the dialog exists', () => {
            const source = fs.readFileSync(path.join(root, 'src-admin', 'src', 'Settings.jsx'), 'utf8');
            // t('key') and th('key'), the second one is the variant for optional texts
            const used = [...source.matchAll(/\bth?\('([a-zA-Z0-9_]+)'\)/g)].map(match => match[1]);
            expect(used.length, 'no texts found - did the call pattern change?').to.be.greaterThan(15);

            const german = readJson('src-admin/src/i18n/de.json');
            const optional = [...source.matchAll(/\bth\('([a-zA-Z0-9_]+)'\)/g)].map(match => match[1]);
            used.forEach(key => {
                if (optional.includes(key)) {
                    return; // th() renders nothing when the text is missing
                }
                expect(german, `de.json has no text for "${key}"`).to.have.property(key);
            });
        });
    });
});
