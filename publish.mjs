/**
 * Publish to GitHub and Gitee.
 *
 * git is used for the content (it handles the whole tree and history), and each
 * platform's REST API only for creating the repository the first time. Tokens
 * come from the environment and are passed as one-off push URLs, so they are
 * never written into .git/config.
 *
 *   $env:GITHUB_TOKEN = "ghp_..."
 *   $env:GITEE_TOKEN  = "..."
 *   node publish.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { REPO } from './repo.config.mjs';

const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe', 'git']
  .find(p => p === 'git' || existsSync(p));
if (!GIT) { console.error('git not found'); process.exit(1); }

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const AUTHOR = REPO.author || 'moodle-workspace';
const EMAIL = (REPO.github.user || REPO.gitee.user || 'noreply') + '@users.noreply.github.com';

const git = args => execFileSync(GIT, args, { stdio: 'inherit' });
const gitQuiet = args => { try { return execFileSync(GIT, args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

async function api(url, options) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'User-Agent': 'moodle-workspace', Accept: 'application/json', ...(options?.headers || {}) } });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { ok: response.ok, status: response.status, body };
}

// ------------------------------------------------------------------ local --
if (!existsSync('.git')) { console.log('git init'); git(['init', '-b', 'main']); }
git(['add', '-A']);
git(['-c', 'user.name=' + AUTHOR, '-c', 'user.email=' + EMAIL, 'commit', '-m', 'release ' + pkg.version, '--allow-empty']);

// ------------------------------------------------------------- GitHub ------
const ghToken = process.env.GITHUB_TOKEN || '';
if (REPO.github.user && ghToken) {
  const u = REPO.github.user, r = REPO.github.repo;
  const head = { Authorization: 'token ' + ghToken, Accept: 'application/vnd.github+json' };
  const made = await api('https://api.github.com/user/repos', { method: 'POST', headers: head,
    body: JSON.stringify({ name: r, description: 'Moodle 编程工作区（油猴脚本）', private: false, has_issues: true, auto_init: false }) });
  console.log('github repo: ' + (made.ok ? 'created' : made.status === 422 ? 'already exists' : 'FAILED ' + JSON.stringify(made.body).slice(0, 200)));
  git(['push', '--quiet', '--force', 'https://' + u + ':' + ghToken + '@github.com/' + u + '/' + r + '.git', 'HEAD:main']);
  console.log('github: https://github.com/' + u + '/' + r);
} else console.log('github: skipped (need REPO.github.user and GITHUB_TOKEN)');

// -------------------------------------------------------------- Gitee ------
const gtToken = process.env.GITEE_TOKEN || '';
if (REPO.gitee.user && gtToken) {
  const u = REPO.gitee.user, r = REPO.gitee.repo;
  const made = await api('https://gitee.com/api/v5/user/repos', { method: 'POST',
    body: JSON.stringify({ access_token: gtToken, name: r, description: 'Moodle 编程工作区（油猴脚本）', private: false, has_issues: true, auto_init: false }) });
  const exists = /已存在|already|has already/.test(JSON.stringify(made.body));
  console.log('gitee repo: ' + (made.ok ? 'created' : exists ? 'already exists' : 'FAILED ' + JSON.stringify(made.body).slice(0, 200)));
  git(['push', '--quiet', '--force', 'https://' + u + ':' + gtToken + '@gitee.com/' + u + '/' + r + '.git', 'HEAD:master']);
  console.log('gitee: https://gitee.com/' + u + '/' + r);
} else console.log('gitee: skipped (need REPO.gitee.user and GITEE_TOKEN)');

console.log('current branch: ' + gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']));
console.log('done');
