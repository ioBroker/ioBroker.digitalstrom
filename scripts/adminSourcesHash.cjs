// The admin interface is a built bundle that is committed, because the adapter is
// installed straight from this repository. Editing a source without rebuilding would
// ship the previous dialog unnoticed.
//
// Comparing the built bundle byte by byte does not work: two runs on different machines
// produce different output, which made the check fail on one runner and pass on another.
// The fingerprint is therefore taken from the SOURCES, which are identical everywhere,
// and written next to the bundle. The test compares the current sources against it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'src-admin');

/**
 * Collects the files that end up in the bundle. preview.* is a development aid and is not built.
 *
 * @param dir directory to walk through
 * @param collected files found so far, used by the recursion
 */
function collectSources(dir, collected = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules' || entry.name.startsWith('preview.')) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSources(full, collected);
        } else if (/\.(jsx?|json|html)$/.test(entry.name)) {
            collected.push(full);
        }
    }
    return collected;
}

function hashSources() {
    const hash = crypto.createHash('sha256');
    for (const file of collectSources(sourceDir)) {
        // The path is part of the fingerprint, so a renamed file is noticed as well.
        hash.update(path.relative(root, file).split(path.sep).join('/'));
        hash.update('\0');
        // Normalise line endings, a checkout on Windows must not change the result.
        hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
        hash.update('\0');
    }
    return hash.digest('hex');
}

const target = path.join(root, 'admin', 'assets', 'sources.sha256');

if (require.main === module) {
    fs.writeFileSync(target, `${hashSources()}\n`);
    console.log(`admin sources fingerprint written: ${hashSources().slice(0, 16)}...`);
}

module.exports = { hashSources, target };
