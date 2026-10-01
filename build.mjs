import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { REPO } from './repo.config.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const gh = REPO.github.user, gt = REPO.gitee.user;
const cdn = gh ? 'https://cdn.jsdelivr.net/gh/' + gh + '/' + REPO.github.repo + '@main/code.user.js' : '';
// raw.githubusercontent is the update channel: jsDelivr keeps serving a stale
// @main alias for hours even after a purge, and a static @updateURL cannot point
// at a version tag. jsDelivr stays documented as a fallback for blocked networks.
const raw = gh ? 'https://raw.githubusercontent.com/' + gh + '/' + REPO.github.repo + '/main/code.user.js' : '';
const gitee = gt ? 'https://gitee.com/' + gt + '/' + REPO.gitee.repo + '/raw/master/code.user.js' : '';
const home = gh ? 'https://github.com/' + gh + '/' + REPO.github.repo
                : (gt ? 'https://gitee.com/' + gt + '/' + REPO.gitee.repo : '');

const header = [
  '// ==UserScript==',
  '// @name         Moodle Workspace · CodeMirror 6',
  '// @name:zh-CN   Moodle 编程工作区',
  '// @namespace    ' + (home || 'https://github.com/'),
  '// @version      ' + pkg.version,
  '// @description  CodeMirror 6 工作区、AI 逐行辅导、本地 WASM 编译运行、结构化判题与流畅动画',
  '// @author       ' + REPO.author,
  '// @license      MIT',
  home ? '// @homepageURL  ' + home : '',
  home ? '// @supportURL   ' + home + '/issues' : '',
  (raw || cdn || gitee) ? '// @updateURL    ' + (raw || cdn || gitee) : '',
  (raw || cdn || gitee) ? '// @downloadURL  ' + (raw || cdn || gitee) : '',
  cdn ? '// @cdnFallback  ' + cdn : '',
  // @match anchors the path from the start, so it misses a path-prefix proxy
  // such as WebVPN (/http/<40-hex>/moodle/mod/programming/...). @include treats
  // "*" as any characters including "/", which covers both direct and proxied.
  '// @match        *://*/moodle/mod/programming/*',
  '// @match        *://*/mod/programming/*',
  '// @match        *://*/*/mod/programming/*',
  '// @include      *moodle/mod/programming*',
  '// @include      *mod/programming*',
  '// @grant        none',
  '// @run-at       document-idle',
  '// ==/UserScript=='
].filter(Boolean).join('\n');

await build({
  entryPoints: ['workspace.mjs'],
  outfile: 'code.user.js',
  bundle: true,
  loader: { '.css': 'text' },
  format: 'iife',
  target: ['chrome100', 'firefox100'],
  minify: true,
  legalComments: 'inline',
  banner: { js: header }
});
console.log('built code.user.js @ ' + pkg.version);
