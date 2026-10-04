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

/**
 * Commit code.user.js through the contents API.
 *
 * On a locked-down network "git push" to github.com can be reset while api.github.com is
 * untouched - the releases then sit in the local repository and the userscript never
 * updates, which looks exactly like "版本没发上去". The API writes the same commit.
 */
async function commitThroughApi(u, r, token) {
  const head = { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' };
  const path = 'code.user.js';
  const content = await readFile(path);
  const current = await api('https://api.github.com/repos/' + u + '/' + r + '/contents/' + path, { headers: head });
  const body = { message: 'release ' + pkg.version, content: content.toString('base64'), branch: 'main' };
  if (current.ok && current.body && current.body.sha) body.sha = current.body.sha;
  const put = await api('https://api.github.com/repos/' + u + '/' + r + '/contents/' + path, { method: 'PUT', headers: head, body: JSON.stringify(body) });
  if (put.ok) { console.log('github commit: ok ' + String(put.body && put.body.commit && put.body.commit.sha || '').slice(0, 7)); return true; }
  console.log('github commit: FAILED ' + put.status + ' ' + JSON.stringify(put.body).slice(0, 200));
  return false;
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
  // Never let one platform abort the other, and never echo the token in an error.
  let pushed = false;
  try { git(['push', '--quiet', '--force', 'https://' + u + ':' + ghToken + '@github.com/' + u + '/' + r + '.git', 'HEAD:main']); pushed = true; }
  catch { console.log('github push通过 git 失败（网络重置？），改用 REST API 提交…'); }
  if (!pushed) pushed = await commitThroughApi(u, r, ghToken);
  if (!pushed) console.log('github FAILED — git 和 API 都没成功，油猴脚本不会更新。');
  // Tag every release so version-pinned jsDelivr URLs also resolve.
  try { git(['tag', '-f', 'v' + pkg.version]); git(['push', '--quiet', '--force', 'https://' + u + ':' + ghToken + '@github.com/' + u + '/' + r + '.git', 'refs/tags/v' + pkg.version]); } catch { console.log('tag push skipped'); }
  await api('https://purge.jsdelivr.net/gh/' + u + '/' + r + '@main/code.user.js', { method: 'GET' }).catch(() => {});
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
  // Gitee rejects "<user>:<token>"; the token must be paired with the literal
  // username "oauth2".
  try { git(['push', '--quiet', '--force', 'https://oauth2:' + gtToken + '@gitee.com/' + u + '/' + r + '.git', 'HEAD:master']); }
  catch { console.log('gitee push FAILED — create the repo at https://gitee.com/projects/new first (name: ' + r + ', 开源), then run publish.mjs again.'); }
  console.log('gitee: https://gitee.com/' + u + '/' + r);
} else console.log('gitee: skipped (need REPO.gitee.user and GITEE_TOKEN)');

console.log('current branch: ' + gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']));
console.log('done');
