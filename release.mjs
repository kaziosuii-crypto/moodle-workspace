/** Bump the version, rebuild the userscript, then publish.
 *   node release.mjs patch    (default)
 *   node release.mjs minor
 *   node release.mjs major
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const kind = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(kind)) { console.error('usage: node release.mjs [patch|minor|major]'); process.exit(1); }

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next = kind === 'major' ? (major + 1) + '.0.0'
           : kind === 'minor' ? major + '.' + (minor + 1) + '.0'
           : major + '.' + minor + '.' + (patch + 1);

pkg.version = next;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
console.log('version -> ' + next + '\nnow run: node publish.mjs');
