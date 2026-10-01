
// Unit tests for the environment-adaptive URL resolution in workspace.mjs.
// The function body is extracted from the real source, so this cannot drift.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./workspace.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function proxyURL(url) {');
assert.ok(start > 0, 'proxyURL not found in workspace.mjs');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnBody = src.slice(start, end);
const make = (location, base) =>
  new Function('location', 'base', fnBody + '\nreturn proxyURL;')(location, base);

const cases = [
  {
    name: 'direct intranet: same-origin absolute URL passes through untouched',
    location: { origin: 'http://10.140.103.120', pathname: '/moodle/mod/programming/submit.php', href: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=117' },
    base: 'http://10.140.103.120/moodle/mod/programming/',
    url: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=117',
    want: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=117',
  },
  {
    name: 'direct intranet: relative URL resolves against the page directory',
    location: { origin: 'http://10.140.103.120', pathname: '/moodle/mod/programming/submit.php', href: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=117' },
    base: 'http://10.140.103.120/moodle/mod/programming/',
    url: 'view.php?a=117',
    want: 'http://10.140.103.120/moodle/mod/programming/view.php?a=117',
  },
  {
    name: 'WebVPN: internal absolute submit URL is re-pointed through the proxy prefix',
    location: { origin: 'https://vpn.btbu.edu.cn', pathname: '/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/submit.php', href: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/submit.php?a=117' },
    base: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/',
    url: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=117',
    want: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/submit.php?a=117',
  },
  {
    name: 'WebVPN: internal view.php URL for another activity maps too',
    location: { origin: 'https://vpn.btbu.edu.cn', pathname: '/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/submit.php', href: 'x' },
    base: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/',
    url: 'http://10.140.103.120/moodle/mod/programming/view.php?a=118',
    want: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/view.php?a=118',
  },
  {
    name: 'WebVPN: https-scheme proxy prefix is handled as well',
    location: { origin: 'https://vpn.btbu.edu.cn', pathname: '/https/abcdef0123456789abcdef0123456789abcdef01/moodle/mod/programming/view.php', href: 'x' },
    base: 'https://vpn.btbu.edu.cn/https/abcdef0123456789abcdef0123456789abcdef01/moodle/mod/programming/',
    url: 'http://10.140.103.120/moodle/mod/programming/submit.php?a=9',
    want: 'https://vpn.btbu.edu.cn/https/abcdef0123456789abcdef0123456789abcdef01/moodle/mod/programming/submit.php?a=9',
  },
  {
    name: 'unrelated external URL is still rejected (no silent proxying)',
    location: { origin: 'https://vpn.btbu.edu.cn', pathname: '/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/submit.php', href: 'x' },
    base: 'https://vpn.btbu.edu.cn/http/77726476706e69737468656265737421a1a70fcd736026012e5bc7fdca05/moodle/mod/programming/',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    throws: true,
  },
  {
    name: 'direct intranet: unrelated external URL is rejected too',
    location: { origin: 'http://10.140.103.120', pathname: '/moodle/mod/programming/submit.php', href: 'x' },
    base: 'http://10.140.103.120/moodle/mod/programming/',
    url: 'https://example.com/other',
    throws: true,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const fn = make(c.location, c.base);
  try {
    const got = fn(c.url).href;
    if (c.throws) { console.log('FAIL  ' + c.name + ' -> expected throw, got ' + got); fail++; }
    else if (got === c.want) { console.log('ok    ' + c.name); pass++; }
    else { console.log('FAIL  ' + c.name + '\n        want ' + c.want + '\n        got  ' + got); fail++; }
  } catch (e) {
    if (c.throws) { console.log('ok    ' + c.name + '  (threw: ' + e.message + ')'); pass++; }
    else { console.log('FAIL  ' + c.name + ' -> threw ' + e.message); fail++; }
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
