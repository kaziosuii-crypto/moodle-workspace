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

/** Where the two packages come from, and which files of each are kept. */
const PACKAGES = [
  {
    dir: 'browsercc',
    label: '编译器本体',
    sources: [
      'https://registry.npmjs.org/browsercc/-/browsercc-0.1.1.tgz',
      'https://registry.npmmirror.com/browsercc/-/browsercc-0.1.1.tgz',
    ],
    prefix: 'package/dist/',
    keep: ['index.js', 'clang.js', 'lld.js', 'clang.wasm', 'lld.wasm', 'sysroot.tar', 'stdc++.h.pch'],
  },
  {
    dir: 'wasi',
    label: '运行库',
    sources: [
      'https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
      'https://registry.npmmirror.com/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
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
export const supported = () => canPick() || canUseStorage();

/* --------------------------------------------------------------- the folder */

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

/** The directory that holds (or will hold) "moodle-workspace-toolchain". */
async function savedDirectory() {
  const saved = await idbGet();
  // A picked folder is remembered by handle and needs its permission renewed; the
  // browser's own storage is always reachable, so it is looked at directly instead of
  // being remembered. Losing the record then costs nothing.
  if (saved && saved.kind === 'picked') {
    const permission = saved.dir.queryPermission ? await saved.dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied') : 'granted';
    return { kind: 'picked', dir: saved.dir, permission };
  }
  if (canUseStorage()) {
    const dir = await navigator.storage.getDirectory();
    if ((saved && saved.kind === 'opfs') || await hasFiles(dir)) return { kind: 'opfs', dir };
  }
  return null;
}

export async function savedKind() {
  const saved = await savedDirectory();
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
  const saved = await savedDirectory();
  if (!saved) return 'absent';
  if (saved.kind === 'picked' && saved.permission !== 'granted') return saved.permission === 'denied' ? 'denied' : 'needs-permission';
  return await hasFiles(saved.dir) ? 'ready' : 'incomplete';
}

async function hasFiles(dir) {
  try {
    const root = await dir.getDirectoryHandle(TOOLCHAIN_FOLDER);
    const manifest = await (await root.getFileHandle(MANIFEST)).getFile();
    if (JSON.parse(await manifest.text()).version !== TOOLCHAIN_VERSION) return false;
    for (const pkg of PACKAGES) {
      const sub = await root.getDirectoryHandle(pkg.dir);
      for (const name of pkg.keep) await sub.getFileHandle(name);
    }
    return true;
  } catch { return false; }
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
async function installInto(dir, kind, onProgress) {
  const root = await dir.getDirectoryHandle(TOOLCHAIN_FOLDER, { create: true });
  let lastError;
  for (const source of [0, 1]) {
    try {
      let at = 0;
      const written = [];
      for (const [index, pkg] of PACKAGES.entries()) {
        const span = 0.94 / PACKAGES.length;
        const tarball = await pullTarball(pkg.sources[source], pkg.label, onProgress, at, span);
        at += span;
        const sub = await root.getDirectoryHandle(pkg.dir, { create: true });
        for (const name of pkg.keep) {
          const bytes = tarball[pkg.prefix + name];
          if (!bytes) throw new Error('安装包里缺少 ' + pkg.prefix + name);
          const handle = await sub.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(bytes);
          await writable.close();
          written.push({ path: pkg.dir + '/' + name, bytes: bytes.length });
        }
        onProgress(0.94 * (index + 1) / PACKAGES.length, '正在写入' + pkg.label + '…');
      }
      const manifest = await root.getFileHandle(MANIFEST, { create: true });
      const writable = await manifest.createWritable();
      await writable.write(JSON.stringify({ version: TOOLCHAIN_VERSION, kind, at: Date.now(), files: written }, null, 2));
      await writable.close();
      onProgress(1, '安装完成');
      await idbSave({ kind, dir });
      return readToolchain(root);
    } catch (error) { lastError = error; }
  }
  throw new ToolchainError('download-failed', '下载失败：' + String(lastError && lastError.message || lastError) + '。可以换个网络再试一次。');
}

/**
 * Ask for a folder and fill it, or fall back to the browser's own storage.
 *
 * "picked" needs a real click; it is the mode where the learner can see the files.
 */
export async function installToolchain(onProgress = () => {}, mode = null) {
  if (!supported()) throw new ToolchainError('unsupported', '这个浏览器既没有文件夹访问，也没有浏览器存储，装不了编译器。');
  // Re-installing where the files already live beats asking for the folder again: the
  // only thing that changed is that the last download did not finish.
  const existing = await savedDirectory();
  if (!mode && existing) {
    if (existing.kind === 'picked' && existing.permission !== 'granted' && existing.dir.requestPermission) {
      const state = await existing.dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (state !== 'granted') throw new ToolchainError('denied', '没有拿到文件夹的访问权限。');
    }
    return installInto(existing.dir, existing.kind, onProgress);
  }
  const wanted = mode || (canPick() ? 'picked' : 'opfs');
  if (wanted === 'opfs') {
    if (!canUseStorage()) throw new ToolchainError('unsupported', '这个浏览器没有可用的本地存储。');
    onProgress(0, '正在准备浏览器存储…');
    return installInto(await navigator.storage.getDirectory(), 'opfs', onProgress);
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
  return installInto(picked, 'picked', onProgress);
}

/** Re-grant access to a folder that was already chosen. Needs a click as well. */
export async function grantToolchain() {
  const saved = await idbGet();
  if (!saved) throw new ToolchainError('absent', '还没有选择过编译器文件夹。');
  if (saved.kind === 'opfs') return null;
  let state;
  try { state = await saved.dir.requestPermission({ mode: 'readwrite' }); }
  catch (error) { throw new ToolchainError('denied', String(error && error.message || error)); }
  if (state !== 'granted') throw new ToolchainError('denied', '没有拿到文件夹的访问权限。');
  return null;
}

/** Everything under the toolchain folder, keyed "browsercc/clang.wasm". */
async function readToolchain(root) {
  const files = new Map();
  for (const pkg of PACKAGES) {
    const dir = await root.getDirectoryHandle(pkg.dir);
    for (const name of pkg.keep) files.set(pkg.dir + '/' + name, await (await dir.getFileHandle(name)).getFile());
  }
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
  const original = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith(VIRTUAL)) return original(input, init);
    const file = files.get(decodeURIComponent(url.slice(VIRTUAL.length)));
    if (!file) return Promise.reject(new Error('内置编译器缺少文件：' + url.slice(VIRTUAL.length)));
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
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
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
  const saved = await savedDirectory();
  const files = await readToolchain(await saved.dir.getDirectoryHandle(TOOLCHAIN_FOLDER));
  patchFetch(files);
  const urls = await buildGraph(files);
  const module = await import(urls.get(ENTRY));
  if (typeof module.compile !== 'function') throw new Error('内置编译器没有导出 compile()。');
  loaded = { compile: module.compile, wasiURL: urls.get('wasi/wasi.js'), fsURL: urls.get('wasi/fs_mem.js') };
  return loaded;
}

export const MESSAGE = {
  unsupported: '这个浏览器装不了内置编译器。',
  absent: '还没有准备好编译器文件。',
  'needs-permission': '需要重新允许访问编译器文件夹。',
  denied: '编译器文件夹的访问被拒绝了。',
  incomplete: '编译器文件不完整。',
};
