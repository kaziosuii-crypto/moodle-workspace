/**
 * The built-in C compiler, stored as ordinary files instead of in the browser cache.
 *
 * Why not the cache: the toolchain is loaded with import(), and the module loader never
 * calls window.fetch, so a Cache API copy could not be handed to it. The compiler then
 * refused to start offline even with a complete cache - it silently fell back to the
 * online playground. Files have no such problem: they are read, turned into blob module
 * URLs, and imported directly.
 *
 * Two places those files can live, both real directories:
 *   "picked" - a folder the user chooses with the File System Access API. Visible on
 *              disk, survives everything, needs a permission click per session.
 *   "opfs"   - the browser's own origin-private file system. No permission prompt at
 *              all, works in every modern browser, invisible to the user.
 */

import { makeCompiler } from './cc.mjs';

/** Where the two packages come from, and which files of each are kept. */
const PACKAGES = [
  {
    dir: 'browsercc',
    label: '编译器本体',
    cdn: 'https://cdn.jsdelivr.net/npm/browsercc@0.1.1/dist/',
    // The mirror first: it is the same package and far quicker from a Chinese
    // network, which is where the 110 MB download actually has to happen.
    sources: [
      'https://registry.npmmirror.com/browsercc/-/browsercc-0.1.1.tgz',
      'https://registry.npmjs.org/browsercc/-/browsercc-0.1.1.tgz',
    ],
    prefix: 'package/dist/',
    keep: ['index.js', 'clang.js', 'lld.js', 'clang.wasm', 'lld.wasm', 'sysroot.tar', 'stdc++.h.pch'],
  },
  {
    dir: 'wasi',
    label: '运行库',
    cdn: 'https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/',
    sources: [
      'https://registry.npmmirror.com/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
      'https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
    ],
    prefix: 'package/dist/',
    keep: ['index.js', 'wasi.js', 'fd.js', 'fs_mem.js', 'fs_opfs.js', 'strace.js', 'wasi_defs.js', 'debug.js'],
  },
];
export const TOOLCHAIN_FOLDER = 'moodle-workspace-toolchain';
export const TOOLCHAIN_VERSION = 'browsercc@0.1.1+browser_wasi_shim@0.4.2';
/** Roughly what the folder ends up holding, for the dialog copy. */
export const TOOLCHAIN_SIZE = '约 110 MB';
export const ENTRY = 'browsercc/index.js';

/** A URL that never leaves the machine: every request to it is answered from disk. */
const VIRTUAL = 'https://moodle-workspace.local/';
const MANIFEST = 'manifest.json';
const MIME = name => /\.wasm$/.test(name) ? 'application/wasm'
  : /\.js$/.test(name) ? 'text/javascript'
  : 'application/octet-stream';

/** Every way this feature can fail, named so the UI can answer each one properly. */
export class ToolchainError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolchainError'; this.code = code; }
}

export const canPick = () => typeof self !== 'undefined' && typeof self.showDirectoryPicker === 'function';
const canUseStorage = () => typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory);
/** IndexedDB is the one store every environment has, https or plain http. */
const canUseIndexedDB = () => { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; } };
export const supported = () => canUseIndexedDB();
/** The store that needs nothing from the user: OPFS where it exists, else IndexedDB. */
export const hiddenMode = () => canUseStorage() ? 'opfs' : 'idb';

/* --------------------------------------------------------------- the stores */

/**
 * Where the compiler files live.
 *
 * A picked folder and OPFS are both directory handles and share one implementation.
 * Both need a secure context, though, and the intranet copy of Moodle is served over
 * plain http:// where neither exists - so IndexedDB, which has no such restriction,
 * holds the same files as a third home.
 */
function directoryStore(dir) {
  const cut = path => [path.slice(0, path.indexOf('/')), path.slice(path.indexOf('/') + 1)];
  const folder = () => dir.getDirectoryHandle(TOOLCHAIN_FOLDER, { create: true });
  return {
    async write(path, bytes) {
      const [name, file] = cut(path);
      const sub = await (await folder()).getDirectoryHandle(name, { create: true });
      const handle = await sub.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    async read(path) {
      const [name, file] = cut(path);
      const sub = await (await folder()).getDirectoryHandle(name);
      return (await sub.getFileHandle(file)).getFile();
    },
    async readManifest() {
      const file = await (await folder()).getFileHandle(MANIFEST);
      return JSON.parse(await (await file.getFile()).text());
    },
    async writeManifest(info) {
      const handle = await (await folder()).getFileHandle(MANIFEST, { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(info, null, 2));
      await writable.close();
    },
  };
}
const FILE_DB = 'moodle-workspace-toolchain', FILE_STORE = 'files';
let filePromise = null;
function fileDB() {
  if (filePromise) return filePromise;
  filePromise = new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(FILE_DB, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地数据库打不开'));
  }).catch(error => { filePromise = null; throw error; });
  return filePromise;
}
function fileRun(mode, work) {
  return fileDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, mode);
    const request = work(tx.objectStore(FILE_STORE));
    tx.oncomplete = () => resolve(request && request.result);
    tx.onerror = () => reject(tx.error || new Error('本地数据库读写失败'));
    tx.onabort = () => reject(tx.error || new Error('本地数据库读写被中断'));
  }));
}
function idbStore() {
  return {
    async write(path, bytes) { await fileRun('readwrite', store => store.put(bytes, path)); },
    async read(path) {
      const bytes = await fileRun('readonly', store => store.get(path));
      if (!bytes) throw new Error('内置编译器缺少文件：' + path);
      return new Blob([bytes]);
    },
    async readManifest() {
      const bytes = await fileRun('readonly', store => store.get(MANIFEST));
      if (!bytes) throw new Error('还没有 manifest.json');
      return JSON.parse(await new Blob([bytes]).text());
    },
    async writeManifest(info) { await fileRun('readwrite', store => store.put(new TextEncoder().encode(JSON.stringify(info, null, 2)), MANIFEST)); },
  };
}

/* ---------------------------------------------------------- remembering it */

const DB_NAME = 'moodle-workspace-fs', STORE = 'handles', KEY = 'toolchain';
function idb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function idbGet() {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
async function idbSave(value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch { /* a lost handle only costs one more pick */ }
}

/**
 * The store in use right now, or null.
 *
 * A picked folder is remembered by handle and needs its permission renewed; OPFS and
 * IndexedDB are always reachable, so they are looked at directly instead of being
 * remembered - losing the record then costs nothing.
 */
async function currentStore() {
  const saved = await idbGet();
  if (saved && saved.kind === 'picked') {
    const permission = saved.dir.queryPermission ? await saved.dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied') : 'granted';
    return { kind: 'picked', dir: saved.dir, permission, store: directoryStore(saved.dir) };
  }
  if (canUseStorage()) {
    const dir = await navigator.storage.getDirectory();
    const store = directoryStore(dir);
    if ((saved && saved.kind === 'opfs') || await hasFiles(store)) return { kind: 'opfs', dir, store };
  }
  const store = idbStore();
  if (canUseIndexedDB() && await hasFiles(store)) return { kind: 'idb', store };
  return null;
}

export async function savedKind() {
  const saved = await currentStore();
  return saved ? saved.kind : null;
}

/**
 * What the caller has to do next.
 *
 * "ready" means the files are there and readable right now; everything else is a
 * prompt, and each one needs a different sentence in front of the user.
 */
export async function toolchainStatus() {
  if (!supported()) return 'unsupported';
  const saved = await currentStore();
  if (!saved) return 'absent';
  if (saved.kind === 'picked' && saved.permission !== 'granted') return saved.permission === 'denied' ? 'denied' : 'needs-permission';
  // Always verify: a remembered store can be half-written by an interrupted download,
  // and reporting "ready" then fails later with a bare NotFoundError from the filesystem.
  return await hasFiles(saved.store) ? 'ready' : 'incomplete';
}

/**
 * What is missing, or an empty string when the install is complete.
 *
 * "不完整" on its own is what made this loop unreadable: the learner sees the same dialog
 * again, and nothing says whether it is the manifest, one file, or the whole folder.
 */
let incompleteReason = '';
export const lastIncompleteReason = () => incompleteReason;
async function checkFiles(store) {
  // The manifest only records what was written; the files themselves are what matter, so
  // a missing or unreadable manifest is reported and then ignored.
  let note = '';
  try {
    const info = await store.readManifest();
    if (info && info.version !== TOOLCHAIN_VERSION) note = '版本不符（' + info.version + '）';
  } catch (error) { note = 'manifest 读不到：' + String((error && error.name) || '') + ' ' + String((error && error.message) || error).slice(0, 60); }
  for (const pkg of PACKAGES) for (const name of pkg.keep) {
    try { await store.read(pkg.dir + '/' + name); }
    catch { return (note ? note + '；' : '') + '缺少 ' + pkg.dir + '/' + name; }
  }
  return '';
}
async function hasFiles(store) {
  incompleteReason = await checkFiles(store);
  return !incompleteReason;
}

/* ------------------------------------------------------------- installing */

/** One gzipped npm tarball, unpacked into { "package/dist/x": Uint8Array }. */
async function pullTarball(url, label, onProgress, from, span) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(label + ' 返回 ' + response.status);
  const total = Number(response.headers.get('content-length')) || 1;
  const reader = response.body && response.body.getReader();
  if (!reader) return untarGz(await response.arrayBuffer());
  const chunks = [];
  let received = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    received += step.value.length;
    onProgress(from + Math.min(1, received / total) * span, '正在下载' + label + '…');
  }
  return untarGz(await new Blob(chunks).arrayBuffer());
}

async function untarGz(buffer) {
  if (!self.DecompressionStream) throw new Error('浏览器不支持解压，请升级浏览器');
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const decoder = new TextDecoder(), files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = decoder.decode(tar.subarray(offset, offset + 100)).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(decoder.decode(tar.subarray(offset + 124, offset + 136)).replace(/\0.*$/, '').trim(), 8) || 0;
    const from = offset + 512;
    files[name] = tar.slice(from, from + size);
    offset = from + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Download the compiler into a directory and remember where it went. */
async function installInto(store, kind, onProgress) {
  let lastError;
  for (const source of [0, 1]) {
    try {
      let at = 0;
      const written = [];
      for (const [index, pkg] of PACKAGES.entries()) {
        const span = 0.94 / PACKAGES.length;
        const tarball = await pullTarball(pkg.sources[source], pkg.label, onProgress, at, span);
        at += span;
        for (const name of pkg.keep) {
          const bytes = tarball[pkg.prefix + name];
          if (!bytes) throw new Error('安装包里缺少 ' + pkg.prefix + name);
          await store.write(pkg.dir + '/' + name, bytes);
          written.push({ path: pkg.dir + '/' + name, bytes: bytes.length });
        }
        onProgress(0.94 * (index + 1) / PACKAGES.length, '正在写入' + pkg.label + '…');
      }
      await store.writeManifest({ version: TOOLCHAIN_VERSION, kind, at: Date.now(), files: written });
      onProgress(1, '安装完成');
      return readToolchain(store);
    } catch (error) { lastError = error; }
  }
  throw new ToolchainError('download-failed', '下载失败：' + String(lastError && lastError.message || lastError) + '。可以换个网络再试一次。');
}

/**
 * Put the compiler somewhere it will still be next time.
 *
 * "picked" is the one the learner can see on disk and needs a real click; the other two
 * are invisible but need nothing from them at all.
 */
export async function installToolchain(onProgress = () => {}, mode = null) {
  if (!supported()) throw new ToolchainError('unsupported', '这个浏览器没有可用的本地存储，装不了编译器。');
  // Re-installing where the files already live beats asking again: the only thing that
  // changed is that the last download did not finish.
  const existing = await currentStore();
  if (!mode && existing) {
    if (existing.kind === 'picked' && existing.permission !== 'granted' && existing.dir.requestPermission) {
      const state = await existing.dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (state !== 'granted') throw new ToolchainError('denied', '没有拿到文件夹的访问权限。');
    }
    return installInto(existing.store, existing.kind, onProgress);
  }
  const wanted = mode || (canPick() ? 'picked' : (canUseStorage() ? 'opfs' : 'idb'));
  if (wanted === 'opfs') {
    if (!canUseStorage()) throw new ToolchainError('unsupported', '这个浏览器没有自己的文件系统。');
    onProgress(0, '正在准备浏览器存储…');
    return installInto(directoryStore(await navigator.storage.getDirectory()), 'opfs', onProgress);
  }
  if (wanted === 'idb') {
    if (!canUseIndexedDB()) throw new ToolchainError('unsupported', '这个浏览器没有可用的本地数据库。');
    onProgress(0, '正在准备本地数据库…');
    await idbSave({ kind: 'idb' });
    return installInto(idbStore(), 'idb', onProgress);
  }
  let picked;
  try {
    picked = await self.showDirectoryPicker({ id: 'moodle-workspace-toolchain', mode: 'readwrite', startIn: 'downloads' });
  } catch (error) {
    // Cancelling the picker is a decision, not a failure; anything else has to be shown,
    // or a browser that refuses the picker looks like a silent no-op.
    if (String(error && error.name) === 'AbortError') throw new ToolchainError('cancelled', '已取消选择文件夹。');
    throw new ToolchainError('picker-failed', '打不开文件夹选择器：' + String(error && error.message || error));
  }
  await idbSave({ kind: 'picked', dir: picked });
  return installInto(directoryStore(picked), 'picked', onProgress);
}

/** Re-grant access to a folder that was already chosen. Needs a click as well. */
export async function grantToolchain() {
  const saved = await idbGet();
  if (!saved) throw new ToolchainError('absent', '还没有选择过编译器文件夹。');
  if (saved.kind !== 'picked') return null;
  let state;
  try { state = await saved.dir.requestPermission({ mode: 'readwrite' }); }
  catch (error) { throw new ToolchainError('denied', String(error && error.message || error)); }
  if (state !== 'granted') throw new ToolchainError('denied', '没有拿到文件夹的访问权限。');
  return null;
}

/** Every compiler file, keyed "browsercc/clang.wasm". */
async function readToolchain(store) {
  const files = new Map();
  for (const pkg of PACKAGES) for (const name of pkg.keep) files.set(pkg.dir + '/' + name, await store.read(pkg.dir + '/' + name));
  return files;
}

/* ------------------------------------------------------- loading the module */

let fetchPatched = false;
/**
 * The wasm and the sysroot are read with fetch(), so this is enough for them.
 *
 * A blob URL cannot be the base of new URL('./clang.wasm', import.meta.url), so the
 * module text is rewritten to ask for these virtual URLs instead.
 */
function patchFetch(files) {
  if (fetchPatched) return;
  fetchPatched = true;
  // Two shapes have to be answered from disk: the virtual URLs the rewritten module
  // text asks for, and the real CDN URLs. The second one matters when a page's
  // Content-Security-Policy allows https: but not blob:, which forces the glue to be
  // loaded from the CDN - its own wasm and sysroot requests still land here.
  const byURL = new Map();
  for (const [path, file] of files) {
    byURL.set(VIRTUAL + path, file);
    const [dir, name] = [path.slice(0, path.indexOf('/')), path.slice(path.indexOf('/') + 1)];
    const pkg = PACKAGES.find(entry => entry.dir === dir);
    if (pkg) byURL.set(pkg.cdn + name, file);
  }
  const original = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const file = byURL.get(decodeURIComponent(url));
    if (!file) return original(input, init);
    // The Content-Type is what lets WebAssembly.instantiateStreaming take the fast path.
    return Promise.resolve(new Response(file, { headers: { 'Content-Type': MIME(url) } }));
  };
}

const ASSET = /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const SPEC = /\b(from|import)\s*(['"])(\.\/[^'"]+)\2/g;

/** A tree of blob URLs, so the module loader never needs the network. */
async function buildGraph(files) {
  const urls = new Map(), building = new Set();
  const build = async path => {
    if (urls.has(path)) return urls.get(path);
    if (building.has(path)) throw new Error('内置编译器的模块互相引用：' + path);
    const file = files.get(path);
    if (!file) throw new Error('内置编译器缺少文件：' + path);
    building.add(path);
    let text = await file.text();
    text = text.replace(ASSET, (whole, quote, name) => 'new URL(' + quote + VIRTUAL + path.replace(/\/[^/]+$/, '') + '/' + name + quote + ')');
    for (const spec of [...new Set([...text.matchAll(SPEC)].map(match => match[3]))]) {
      const url = await build(path.replace(/\/[^/]+$/, '/') + spec.slice(2));
      text = text.split("'" + spec + "'").join("'" + url + "'").split('"' + spec + '"').join('"' + url + '"');
    }
    building.delete(path);
    // A data: URL, not a blob: one. Moodle sends a Content-Security-Policy that allows
    // data: scripts but blocks blob:, so a blob module cannot be imported at all there -
    // and the shim is not always reachable from the CDN either. A data URL is allowed by
    // both, and keeps every byte coming from the folder on disk.
    const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(text);
    urls.set(path, url);
    return url;
  };
  for (const path of files.keys()) await build(path);
  return urls;
}

let loaded = null;
/**
 * The compiler plus the two URLs the sandbox worker imports.
 *
 * Everything is read from the chosen folder: no CDN, no cache, no network.
 */
export async function loadToolchain() {
  if (loaded) return loaded;
  const status = await toolchainStatus();
  if (status !== 'ready') throw new ToolchainError(status, MESSAGE[status] || '内置编译器还没有准备好。');
  const current = await currentStore();
  if (!current) throw new ToolchainError('absent', MESSAGE.absent);
  const files = await readToolchain(current.store);
  patchFetch(files);
  const urls = await buildGraph(files);
  const local = { compile: null, wasiURL: urls.get('wasi/wasi.js'), fsURL: urls.get('wasi/fs_mem.js'), via: 'files' };
  let module;
  try {
    module = await import(urls.get(ENTRY));
  } catch (error) {
    // Last resort for a page that refuses data: modules too: the glue from the CDN, with
    // the wasm and sysroot still answered from disk.
    try { module = await import(PACKAGES[0].cdn + 'index.js'); }
    catch { throw new ToolchainError('script-blocked', '这段页面不允许加载本地脚本（' + String(error && error.message || error).slice(0, 120) + '），从网络加载也失败了。'); }
    local.via = 'cdn-glue';
    local.wasiURL = PACKAGES[1].cdn + 'wasi.js';
    local.fsURL = PACKAGES[1].cdn + 'fs_mem.js';
  }
  if (typeof module.Clang !== 'function' || typeof module.LLD !== 'function') throw new Error('内置编译器缺少 Clang 或 LLD。');
  // browsercc's own compile() drives clang++, which compiles the learner's C as C++.
  // The driver in cc.mjs runs the same wasm as "clang", so the language - and therefore
  // whether 运行 agrees with 提交 - is the judge's.
  const sysroot = await files.get('browsercc/sysroot.tar').arrayBuffer();
  loaded = { compile: makeCompiler(module, sysroot), wasiURL: local.wasiURL, fsURL: local.fsURL, via: local.via };
  return loaded;
}

/**
 * True when the page's Content-Security-Policy refuses to compile WebAssembly.
 *
 * There is no way around this one from inside the page: without 'wasm-unsafe-eval' no
 * compiler written in wasm can run here at all. Naming it beats showing a raw
 * CompileError, and the honest advice is the online compiler.
 */
export function wasmRefused(error) {
  const text = String(error && error.message || error);
  return /WebAssembly/i.test(text) && /Content Security policy|unsafe-eval/i.test(text);
}
export const MESSAGE = {
  'script-blocked': '页面的安全策略不允许加载本地脚本。',
  'wasm-blocked': '这个页面不允许在本机编译 WebAssembly。',
  unsupported: '这个浏览器装不了内置编译器。',
  absent: '还没有准备好编译器文件。',
  'needs-permission': '需要重新允许访问编译器文件夹。',
  denied: '编译器文件夹的访问被拒绝了。',
  incomplete: '编译器文件不完整。',
};
