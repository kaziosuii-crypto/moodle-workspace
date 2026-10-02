import { EditorState, EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history as editorHistory, historyKeymap, indentWithTab, indentSelection } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { autocompletion, completionKeymap, completionStatus, closeBrackets, closeBracketsKeymap, completeFromList } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import css from './workspace.css';
import { esc, text, safeURL, ioDisplay, parseProblem, parseNavigation, parseResult } from './adapter.mjs';
import { parseCompileIssues, diffBlock, describeDiff } from './diagnostics.mjs';
import { SANDBOX_SOURCE } from './sandbox.mjs';
import { ToolchainError, TOOLCHAIN_SIZE, canPick, hiddenMode, wasmRefused, loadToolchain, installToolchain, grantToolchain, toolchainStatus } from './toolchain.mjs';
import { getKey, setKey, hasKey, maskKey } from './ai-key.mjs';
import dagre from 'dagre';
import cytoscape from 'cytoscape';
import klayLayout from 'cytoscape-klay';
cytoscape.use(klayLayout);
import { instrument, parseTrace, describeStep, viewIndices, changedNames, changedValues, skippedSteps } from './trace.mjs';
import { animate, stagger } from 'animejs';
import { AI_CONFIG } from './ai-config.mjs';
import { llm } from './ai.mjs';
import { suggest as aiSuggest, cleanSuggestion, copilotWorthAsking } from './copilot.mjs';
import { TUTOR_SYSTEM, parseTutorResponse, tutorNarrative, tutorPrompt } from './tutor.mjs';

// CodeMirror and every extension share one bundled state/view instance.
const icons = {
  logo:'M17 3 7 12a5 5 0 0 0 0 7l3 3M7 12l5-5 7 7M10 17h11',
  list:'M4 5h16M8 12h12M8 19h12M3 11l2 1-2 1',
  prev:'m14 5-7 7 7 7', next:'m10 5 7 7-7 7', run:'m8 4 12 8-12 8Z',
  submit:'M7 17H5a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 1 10h-2M12 21V10m-4 4 4-4 4 4',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm7 9a4 4 0 1 0-8 0 4 4 0 0 0 8 0',
  doc:'M6 3h12v18H6ZM9 7h6M9 11h6M9 15h4',
  history:'M4 9a8 8 0 1 1 0 6M4 3v6h6M12 7v5l3 2',
  code:'m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18',
  check:'M4 12l5 5L20 6', box:'M4 4h16v16H4Zm4 8 3 3 5-6',
  terminal:'m4 7 5 5-5 5m8 0h8', plus:'M12 5v14M5 12h14', close:'m6 6 12 12M6 18 18 6',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  ai:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4',
  more:'M4 12h1m6 0h1m6 0h1', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  search:'M15 15l6 6M17 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0'
};
const icon = (name, cls='') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] || icons.doc}"/></svg>`;
const button = (action, label, glyph, cls='', title=label) => `<button type="button" data-action="${action}" class="${cls}" title="${esc(title)}" aria-label="${esc(title)}">${glyph ? icon(glyph) : ''}${label ? `<span class="button-label">${esc(label)}</span>` : ''}</button>`;
const base = new URL('./', location.href).href;
let host, root, editor, current, problems = [], currentIndex = -1, busy = false, navToken = 0, saveTimer, toastTimer, modalCleanup;
let testIndex = 0, resultIndex = 0, activeLeft = 'description', activeBottom = 'cases';
const prefsKey = 'moodle-workspace:v4:settings';
/**
 * Durable key/value storage for drafts.
 *
 * localStorage is capped at about 5 MB for the whole origin, and one draft carries its
 * code plus every test case. A learner with a few hundred problems fills that up and
 * then nothing saves any more. IndexedDB has room, works on plain http:// intranet
 * origins, and structured-clones the draft object directly - so drafts live there and
 * localStorage is only kept as a best-effort cache for the synchronous paths.
 */
const STORE_DB = 'moodle-workspace-store', STORE_NAME = 'records';
let storePromise = null;
function storeOpen() {
  if (storePromise) return storePromise;
  storePromise = new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(STORE_DB, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地数据库打不开'));
    request.onblocked = () => reject(new Error('本地数据库被另一个标签页占用'));
  }).catch(error => { storePromise = null; throw error; });
  return storePromise;
}
function storeRun(mode, work) {
  return storeOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = work(tx.objectStore(STORE_NAME));
    let value;
    if (request && 'onsuccess' in request) request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('本地数据库写入失败'));
    tx.onabort = () => reject(tx.error || new Error('本地数据库写入被中断'));
  }));
}
const storeSet = (key, value) => storeRun('readwrite', store => store.put(value, key));
const storeGet = key => storeRun('readonly', store => store.get(key));
const storeKeys = () => storeRun('readonly', store => store.getAllKeys());
const storeRemove = key => storeRun('readwrite', store => store.delete(key));
/** Set when the learner picks the online compiler instead of installing the built-in one. */
const ONLINE_ONLY = 'moodle-workspace:v6:online-compiler';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const storedPrefs=read(prefsKey,{});
dropStoredAnalyses();
dropStoredToolchain();
let prefs = {enabled:storedPrefs.aiV5Enabled??true,runner:storedPrefs.runner||'',copilot:storedPrefs.copilot??true};
let lastPersistFailure = '';
/** Guards the draft indicator against an out-of-order database write finishing late. */
let saveToken = 0;
function persist(key, value) {
  let text = '';
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { text = String(error && error.name) + ' ' + String(error && error.message); }
  if (!/quota|exceed|full/i.test(text)) { lastPersistFailure = 'blocked'; return false; }
  lastPersistFailure = 'quota';
  // Reclaim in order of what is cheapest to lose: the AI analyses were never worth
  // their footprint, and old drafts are already in the database by now.
  try {
    for (const stale of Object.keys(localStorage)) if (stale.includes(':tutor:')) localStorage.removeItem(stale);
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {}
  try {
    for (const other of Object.keys(localStorage)) if (other.includes(':v4:') && other !== key) localStorage.removeItem(other);
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {}
  return false;
}
/** True when this browser refuses site data outright, rather than just being full. */
function storageBlocked() {
  try { localStorage.setItem('moodle-workspace:probe','1'); localStorage.removeItem('moodle-workspace:probe'); return false; }
  catch { return true; }
}
const $ = s => root.querySelector(s);
const $$ = s => [...root.querySelectorAll(s)];
const activity = (file, id=current?.id) => new URL(`${file}?a=${encodeURIComponent(id)}`, base).href;
const draftKey = id => `moodle-workspace:v4:${location.origin}:${id}`;
// AI analyses are read once and were never worth their storage footprint: at a
// few KB each they are what filled localStorage and broke draft saving.
function dropStoredAnalyses() {
  try { for (const key of Object.keys(localStorage)) if (key.includes(':tutor:')) localStorage.removeItem(key); } catch {}
}
/**
 * The compiler used to live in the browser cache, which could never be handed to the
 * module loader. Anyone who installed it that way is holding ~113 MB of dead weight,
 * so the old bucket and its flags go away on the next load.
 */
function dropStoredToolchain() {
  try { localStorage.removeItem('moodle-workspace:v5:c-toolchain'); localStorage.removeItem('moodle-workspace:v5:c-toolchain-dismissed'); } catch {}
  try { if (self.caches) caches.delete('moodle-workspace-c-toolchain-v1'); } catch {}
}
const code = () => editor?.state.doc.toString() ?? current?.draft.code ?? '';
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const motions=new Set();
let tutorRequest, busyMotion, completionRequest;
const diagnosisEffect=StateEffect.define();
// Per-line diagnosis lives in a separate overlay layer, never in the document:
// text inside .cm-content is editable, so injecting widgets there let clicks and
// typing corrupt the code and falsely flagged it as modified.
const expandedIssues=new Set();
function toggleInlineIssue(index){
  if(expandedIssues.has(index))expandedIssues.delete(index);else expandedIssues.add(index);
  renderInlineDiagnosis();
}
/** Tutor findings and compiler diagnostics share one overlay and one decoration set. */
function activeIssues() {
  const list=[];
  const tutor=current?.tutor,issues=tutor?.answer?.issues;
  const stale=!!tutor&&tutor.sourceCode!==undefined&&tutor.sourceCode!==code();
  if(!stale&&Array.isArray(issues))for(const issue of issues)list.push({...issue,key:'tutor:'+list.length});
  if(Array.isArray(current?.compileIssues))for(const issue of current.compileIssues)list.push({...issue,key:'compile:'+list.length});
  return list;
}
function syncDiagnosis() {
  if(!editor)return;
  editor.dispatch({effects:diagnosisEffect.of(activeIssues())});
  renderInlineDiagnosis();
}
function renderInlineDiagnosis() {
  const layer=$('[data-ai-layer]');
  if(!layer||!editor)return;
  layer.replaceChildren();
  const issues=activeIssues();
  if(!issues.length){layer.classList.add('hidden');return;}
  const box=editor.dom.getBoundingClientRect(),used=[];
  issues.forEach(issue=>{
    const index=issue.key;
    if(!issue.startLine)return;
    const lineNo=Math.min(Math.max(issue.endLine||issue.startLine,1),editor.state.doc.lines);
    const coords=editor.coordsAtPos(editor.state.doc.line(lineNo).to);
    if(!coords)return;
    let top=coords.bottom-box.top+2;
    if(top<-4||top>box.height-6)return;
    while(used.some(entry=>Math.abs(entry-top)<21))top+=21;
    used.push(top);
    const chip=document.createElement('button');
    chip.type='button';
    chip.className=`ai-chip ai-chip-${issue.severity||'info'}`;
    chip.style.top=top+'px';
    chip.dataset.aiChip=String(index);
    chip.textContent=`${expandedIssues.has(index)?'▾':'▸'} ${issue.title||'诊断'}`;
    chip.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();toggleInlineIssue(index);});
    layer.append(chip);
    if(expandedIssues.has(index)){
      const card=document.createElement('div');
      card.className=`ai-card ai-card-${issue.severity||'info'}`;
      card.style.top=(top+20)+'px';
      const problem=document.createElement('p');problem.textContent=issue.problem||'';card.append(problem);
      if(issue.hint){const hint=document.createElement('p');hint.className='ai-card-hint';hint.textContent=`提示：${issue.hint}`;card.append(hint);}
      layer.append(card);
    }
  });
  layer.classList.toggle('hidden',!layer.children.length);
}
const diagnosisField=StateField.define({
  create:()=>Decoration.none,
  update(value,tr) {
    if(tr.docChanged){expandedIssues.clear();return Decoration.none;}
    for(const effect of tr.effects)if(effect.is(diagnosisEffect)){
      const lines=new Map();
      for(const issue of effect.value)if(issue.startLine)for(let n=issue.startLine;n<=issue.endLine;n++)lines.set(n,issue.severity);
      return Decoration.set([...lines].sort((a,b)=>a[0]-b[0]).map(([n,severity])=>Decoration.line({class:`ai-line ai-line-${severity}`}).range(tr.state.doc.line(Math.min(n,tr.state.doc.lines)).from)));
    }
    return value;
  },
  provide:field=>EditorView.decorations.from(field)
});
function motion(targets,options={}) {
  const nodes=Array.from(targets?.nodeType?[targets]:targets||[]).filter(Boolean);
  if(!nodes.length || reducedMotion.matches)return null;
  const entry={nodes,animation:null};
  entry.animation=animate(nodes,{duration:280,ease:'outCubic',...options,onComplete:()=>{motions.delete(entry);options.onComplete?.();}});
  motions.add(entry);return entry;
}
function stopMotion(entry) {if(entry){entry.animation.revert();motions.delete(entry);}}
function stopWithin(container) {for(const entry of [...motions])if(entry.nodes.some(n=>container.contains(n)))stopMotion(entry);}
function reveal(container) {
  motion([...container.children].slice(0,18),{opacity:[0,1],translateY:[8,0],duration:360,ease:'outExpo',delay:stagger(26)});
}
function replaceContent(container,html) {
  stopWithin(container);container.innerHTML=html;reveal(container);
}
function loadingHTML(label,detail='') {
  return `<div class="ai-loading" role="status"><div class="thinking-mark">${icon('ai')}<span></span><span></span><span></span></div><strong>${esc(label)}</strong><p>${esc(detail)}</p><div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div></div>`;
}
function animateLoading(container) {
  motion(container.querySelectorAll('.thinking-mark span'),{opacity:[.25,1],translateY:[0,-4],duration:600,delay:stagger(130),alternate:true,loop:true});
  motion(container.querySelectorAll('.skeleton'),{opacity:[.4,.9],duration:950,alternate:true,loop:true,delay:stagger(100)});
}
reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)for(const entry of [...motions])stopMotion(entry);});
function toast(message) {
  $('.toast')?.remove(); clearTimeout(toastTimer);
  const el = document.createElement('div'); el.className='toast'; el.setAttribute('role','status'); el.textContent=message;
  root.append(el);motion(el,{opacity:[0,1],translateY:[8,0],duration:220,ease:'outCubic'});
  toastTimer=setTimeout(()=>{
    if(reducedMotion.matches){stopWithin(el);el.remove();return;}
    motion(el,{opacity:[1,0],translateY:[0,6],duration:200,ease:'inCubic',onComplete:()=>el.remove()});
  },5000);
}
/**
 * Resolve a problem URL for both deployment shapes without any manual switch:
 *
 * - Direct intranet (http://10.140.103.120/moodle/...): links inside the page
 *   already share location.origin, so the URL passes through untouched.
 * - Path-prefix proxy such as WebVPN (https://vpn.btbu.edu.cn/http/<token>/moodle/...):
 *   the proxied HTML still carries the internal origin, e.g.
 *   http://10.140.103.120/moodle/mod/programming/submit.php. The proxy prefix is
 *   recovered by aligning the current page path against the target path and is
 *   then put back in front of the internal path.
 * - A URL that cannot be aligned to the current page is rejected as cross-origin,
 *   exactly as before.
 */
function proxyURL(url) {
  const target = url instanceof URL ? url : new URL(url, base);
  if (target.origin === location.origin) return target;
  const here = location.pathname.split('/').filter(Boolean);
  const there = target.pathname.split('/').filter(Boolean);
  let at = -1, best = 0;
  for (let i = 1; i < here.length; i++) {
    let n = 0;
    while (i + n < here.length && n < there.length && here[i + n] === there[n]) n++;
    if (n > best) { best = n; at = i; }
  }
  if (at < 1 || best === 0) throw new Error('题目请求必须保持同源');
  return new URL('/' + [...here.slice(0, at), ...there].join('/') + target.search + target.hash, location.origin);
}
async function requestDoc(url, options={}) {
  const target = proxyURL(url);
  const response = await fetch(target, { credentials:'same-origin', cache:'no-store', ...options, signal:AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`网站请求失败（${response.status}）`);
  const doc = new DOMParser().parseFromString(await response.text(),'text/html');
  if (/\/login\//.test(response.url) || doc.querySelector('input[type=password]')) throw new Error('登录已过期，请重新登录 Moodle');
  return doc;
}
function saveDraft() {
  if (!current) return;
  current.draft.code=code();
  // Remember the title so an exported archive stays readable on its own.
  current.draft.title=current.problem.title||current.draft.title||'';
  current.form.querySelector('textarea[name=code]').value=current.draft.code;
  const original=document.querySelector('textarea[name=code]#edit-code');
  if(original?.form?.querySelector('[name=a]')?.value===current.id)original.value=current.draft.code;
  // localStorage first: it is synchronous, so the cache is warm for anything that
  // reads it before the database round-trip finishes.
  const cached=persist(draftKey(current.id),current.draft);
  const label=$('[data-save]');
  const key=draftKey(current.id);
  if(label){label.textContent=cached?'已存储':'正在存入本地数据库…';}
  const token=++saveToken;
  storeSet(key,current.draft).then(()=>{
    if(token!==saveToken||label!==$('[data-save]'))return;
    label.textContent='已存储';
  }).catch(error=>{
    // Worth a console line: a silent failure here looks exactly like "the draft saved".
    console.warn('draft store failed:',String(error&&error.name||'')+' '+String(error&&error.message||error));
    if(token!==saveToken||label!==$('[data-save]'))return;
    if(cached){label.textContent='已缓存，本地数据库不可用';return;}
    label.textContent=lastPersistFailure==='quota'
      ?'本机存储已满，草稿没能保存'
      :(storageBlocked()?'浏览器禁止了站点数据（草稿与密钥无法保存）':'草稿未能保存（浏览器存储不可用）');
  });
}
function setBusy(value) {
  busy=value;
  stopMotion(busyMotion);busyMotion=null;
  const progress=$('.work-progress');progress.classList.toggle('hidden',!value);
  if(value)busyMotion=motion(progress,{scaleX:[.08,.96],opacity:[.5,1],duration:1800,alternate:true,loop:true,ease:'inOutSine'});
  $$('[data-action=submit],[data-action=run],[data-action=prev],[data-action=next],[data-action=problems]').forEach(b=>b.disabled=value);
  if (!value) {
    $('[data-action=prev]').disabled=currentIndex<=0;
    $('[data-action=next]').disabled=currentIndex<0 || currentIndex>=problems.length-1;
  }
}
function mount() {
  host=document.createElement('div'); host.id='moodle-workspace'; root=host.attachShadow({mode:'open'});
  const style=document.createElement('style'); style.textContent=css; root.append(style);
  const app=document.createElement('div'); app.className='app';
  app.innerHTML=`
    <header class="topbar">
      <div class="topgroup"><div class="brand" title="编程工作区">${icon('logo')}</div><span class="divider"></span>
        ${button('problems','题库','list')}${button('prev','','prev','square','上一题（Alt + 左方向键）')}
        <span class="position" data-position></span>${button('next','','next','square','下一题（Alt + 右方向键）')}
      </div>
      <div class="topgroup actions">${button('run','运行','run','run','运行自定义用例（需要执行 API）')}${button('submit','提交','submit','primary','提交至 Moodle 判题（Ctrl + Enter）')}${button('complete','','ai','purple','AI 补全（Ctrl + I）')}${button('settings','','settings','mobile-settings','设置')}</div>
      <div class="topgroup end"><span class="muted optional" title="当前脚本版本" style="font-size:11px">v${__SCRIPT_VERSION__}</span><span class="divider optional"></span>${button('settings','','settings','square','编辑器与 AI 设置')}${button('more','','more','square','更多功能')}</div>
    </header><div class="work-progress hidden" role="progressbar" aria-label="正在处理请求"></div>
    <main class="workspace">
      <section class="panel left">
        <nav class="panel-head" role="tablist">
          <button data-left="description" role="tab" class="active">${icon('doc','blue')}题目描述</button>
          <button data-left="history" role="tab">${icon('history')}提交记录</button>
          <button data-left="tutor" role="tab">${icon('ai','purple')}AI 辅导</button>
          <span class="grow"></span>${button('mobile-code','代码','code','mobile-toggle')}${button('refresh-problem','','history','','刷新题目')}
        </nav>
        <div class="scroll" data-left-body><div class="empty">正在读取题目…</div></div>
        <footer class="foot"><span data-course></span><span data-sample-count></span></footer>
      </section>
      <div class="splitter" data-resize="x" role="separator" tabindex="0" aria-label="调整题面宽度" aria-orientation="vertical"></div>
      <div class="right">
        <section class="panel code-panel">
          <header class="panel-head">${icon('code','green')}<strong style="font-size:12px;font-weight:500">代码</strong><span class="grow"></span>${button('mobile-description','题目','doc','mobile-toggle')}${button('expand','','expand','','切换专注模式')}</header>
          <div class="editor-bar"><select data-language aria-label="编译器"></select><span class="muted optional" style="font-size:11px">CodeMirror 6</span><span class="grow"></span>${button('trace','单步','run','','逐行播放这段代码的执行过程')}${button('indent','','list','','重新缩进')}${button('file','','upload','','源文件上传')}${button('clear','','trash','','清空代码')}</div>
          <div class="attachment hidden" data-attachment><span>源文件（优先提交所选文件）</span><span data-file-slot></span>${button('unfile','取消文件','','')}</div>
          <div class="editor-host"><div class="ai-layer hidden" data-ai-layer></div></div>
          <footer class="foot"><span data-save>已存储</span><span data-copilot class="foot-ai"></span><span data-cursor>行 1，列 1</span></footer>
        </section>
        <div class="splitter horizontal" data-resize="y" role="separator" tabindex="0" aria-label="调整编辑器高度" aria-orientation="horizontal"></div>
        <section class="panel bottom">
          <nav class="panel-head" role="tablist"><button data-bottom="cases" role="tab" class="active">${icon('box','green')}测试用例</button><button data-bottom="results" role="tab">${icon('terminal')}测试结果</button><span class="grow"></span>${button('refresh-result','','history','','读取最新判题结果')}</nav>
          <div class="scroll" data-bottom-body></div>
        </section>
      </div>
    </main>`;
  // Attached to the root element, not <body>: if any ancestor establishes a
  // containing block (transform / filter / contain on a theme wrapper), then
  // position:fixed resolves against that box instead of the viewport and the
  // workspace stops tracking the window. <html> has nothing above it.
  root.append(app); document.documentElement.append(host);
  const cover=document.createElement('style');cover.id='workspace-page-cover';
  cover.textContent='html,body{overflow:hidden!important}body>*:not(#moodle-workspace){visibility:hidden!important}'+
    ':root>#moodle-workspace{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important}';
  document.head.append(cover);
  root.addEventListener('click',event=>handleClick(event).catch(e=>toast(e.message)));
  root.addEventListener('input',event=>{
    if(event.target.matches('[data-tutor-question]'))current.tutor.question=event.target.value;
    if (event.target.matches('[data-test-input],[data-test-expected]')) {
      if(current.draft.tests[testIndex]?.source==='公开样例'){toast('题目给出的用例不能修改。');return;}
      current.draft.tests[testIndex][event.target.hasAttribute('data-test-input')?'input':'expected']=event.target.value;
      const mirror=event.target.closest('.eol-wrap')?.querySelector('.eol-mirror');
      if(mirror)mirror.innerHTML=eolMark(event.target.value);
      saveDraft();
    }
  });
  root.addEventListener('toggle',event=>{
    if(event.target.matches('.tutor-reveal[open]'))reveal(event.target);
  },true);
  $('[data-language]').onchange=event=>{
    current.form.querySelector('select[name=language]').value=event.target.value;
    current.draft.compiler=event.target.value; saveDraft();
  };
  // Keep legacy Moodle bubble-phase keyboard handlers away from the editor.
  root.addEventListener('keydown',e=>{
    if (e.key==='Escape') closeModal();
    if (e.altKey && ['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); navigateOffset(e.key==='ArrowLeft'?-1:1).catch(err=>toast(err.message)); }
    e.stopPropagation();
  });
  setupResize();
}
/* -------------------------------------------------------------- AI 内联补全 --
 * 打字停顿后请求下一小段代码，以灰色幽灵文本贴在光标处。Tab 接受、Esc 丢弃、Alt+i
 * 立即请求。补全只写进编辑器，不碰任何提交路径；没有密钥或关掉开关时它完全不发请求。
 */
const COPILOT_DELAY=520;
class GhostWidget extends WidgetType {
  constructor(text){super();this.text=text;}
  eq(other){return other.text===this.text;}
  toDOM(){
    const span=document.createElement('span');
    span.className='cm-ghost';
    span.textContent=this.text;
    span.setAttribute('aria-hidden','true');
    return span;
  }
}
const ghostEffect=StateEffect.define();
/** The pending suggestion, or null. Anchored at a document position, never at a range. */
const ghostField=StateField.define({
  create:()=>null,
  update(value,tr){
    for(const effect of tr.effects)if(effect.is(ghostEffect))return effect.value;
    // 任何编辑或光标移动都会让它错位，直接丢弃比锚在原地更安全。
    if(value&&(tr.docChanged||tr.selection))return null;
    return value;
  },
  provide:field=>EditorView.decorations.from(field,ghost=>ghost&&ghost.text
    ?Decoration.set([Decoration.widget({widget:new GhostWidget(ghost.text),side:1}).range(ghost.pos)])
    :Decoration.none)
});
const copilot={timer:null,controller:null,token:0,suppressUntil:0};
function copilotEnabled(){return prefs.enabled&&prefs.copilot&&hasKey();}
function setCopilotState(text){
  const el=$('[data-copilot]');
  if(el)el.textContent=text||'';
  const box=el&&el.closest('.foot');
  if(box)box.classList.toggle('busy',!!text);
}
function setGhost(view,pos,text){
  const current=view.state.field(ghostField,false);
  if(!text){if(current)view.dispatch({effects:ghostEffect.of(null)});return;}
  if(current&&current.pos===pos&&current.text===text)return;
  view.dispatch({effects:ghostEffect.of({pos,text})});
}
function acceptGhost(view){
  const ghost=view.state.field(ghostField,false);
  if(!ghost)return false;
  if(view.state.selection.main.head!==ghost.pos)return false;
  // 刚插入的内容会触发一次 docChanged，别让它立刻又去问一遍。
  copilot.suppressUntil=Date.now()+1200;
  clearTimeout(copilot.timer);copilot.timer=null;
  view.dispatch({
    changes:{from:ghost.pos,insert:ghost.text},
    selection:{anchor:ghost.pos+ghost.text.length},
    effects:ghostEffect.of(null)
  });
  return true;
}
function dismissGhost(view){
  if(!view.state.field(ghostField,false))return false;
  copilot.suppressUntil=Date.now()+600;
  clearTimeout(copilot.timer);copilot.timer=null;
  view.dispatch({effects:ghostEffect.of(null)});
  return true;
}
function scheduleCopilot(view){
  clearTimeout(copilot.timer);copilot.timer=null;
  if(!copilotEnabled()||!view.hasFocus)return;
  // 关键字补全弹窗开着时让位给它，两套补全不要同时糊在光标上。
  if(completionStatus(view.state)==='active')return;
  const selection=view.state.selection.main;
  if(!selection.empty)return;
  const pos=selection.head;
  // 刚按下 Tab/Esc 之后的静默期只是推迟，不是取消 —— 否则接着打字那一整段都不再补全，
  // 要停下来再敲一下才恢复。
  const wait=Math.max(COPILOT_DELAY,copilot.suppressUntil-Date.now()+40);
  copilot.timer=setTimeout(()=>{copilot.timer=null;runCopilot(view,pos).catch(()=>{});},wait);
}
async function runCopilot(view,pos){
  if(!copilotEnabled()||view.state.selection.main.head!==pos||!view.hasFocus)return;
  const doc=view.state.doc,text=doc.toString();
  const prefix=text.slice(0,pos);
  if(!prefix.trim())return;
  // 最后一个右大括号之后没有任何东西可续写，问也是在空白上糊灰字。
  if(!copilotWorthAsking(text,pos))return;
  copilot.controller?.abort();
  const controller=new AbortController();
  copilot.controller=controller;
  const token=++copilot.token;
  setCopilotState('AI 补全中…');
  // 只有文档和光标都还停在原地时，结果才允许落到编辑器里。
  const stillValid=()=>token===copilot.token&&view.state.doc===doc&&view.state.selection.main.head===pos;
  try{
    const answer=await aiSuggest({
      prefix,suffix:text.slice(pos),statement:current?.problem?.statement||'',signal:controller.signal,
      onDelta:(delta,full)=>{
        if(!stillValid())return;
        const partial=cleanSuggestion(full,prefix,text.slice(pos));
        if(partial)setGhost(view,pos,partial);
      }
    });
    if(!stillValid())return;
    setGhost(view,pos,answer);
  }finally{
    if(token===copilot.token){copilot.controller=null;setCopilotState('');}
  }
}
function editorState(value) {
  const words=['int','char','float','double','long','unsigned','void','return','if','else','for','while','break','continue','struct','typedef','sizeof','const','switch','case','printf','scanf','malloc','free','strlen','main'];
  return EditorState.create({ doc:value, extensions:[
    lineNumbers(),highlightActiveLine(),highlightActiveLineGutter(),drawSelection(),editorHistory(),cpp(),
    diagnosisField,ghostField,
    syntaxHighlighting(defaultHighlightStyle),indentOnInput(),bracketMatching(),closeBrackets(),foldGutter(),
    highlightSelectionMatches(),EditorView.lineWrapping,
    autocompletion({ override:[completeFromList(words.map(label=>({label,type:['printf','scanf','strlen','main'].includes(label)?'function':'keyword'})))] }),
    keymap.of([
      {key:'Mod-Enter',run:()=>{submit().catch(e=>toast(e.message));return true;}},
      {key:'Mod-i',run:()=>{complete().catch(e=>toast(e.message));return true;}},
      {key:'Mod-s',run:()=>{saveDraft();toast('草稿已保存');return true;}},
      // 幽灵文本要排在 completionKeymap 和 indentWithTab 前面，否则 Tab 会被它们先吃掉；
      // 补全弹窗开着时让给弹窗，两套补全才不会互相打架。
      {key:'Tab',run:view=>completionStatus(view.state)==='active'?false:acceptGhost(view)},
      {key:'Escape',run:view=>dismissGhost(view)},
      {key:'Alt-i',run:view=>{
        if(!copilotEnabled()){aiReady();return true;}
        runCopilot(view,view.state.selection.main.head).catch(error=>toast(error.message));
        return true;
      }},
      ...closeBracketsKeymap,...defaultKeymap,...historyKeymap,...completionKeymap,...searchKeymap,...foldKeymap,indentWithTab
    ]),
    // 点到别处时补全就不该还挂在编辑器里。
    EditorView.domEventHandlers({blur:(event,view)=>{dismissGhost(view);return false;}}),
    EditorView.updateListener.of(update=>{
      if (update.docChanged) {
        clearTimeout(saveTimer); saveDraft();
        if(current.tutor?.sourceCode!==undefined && current.tutor.sourceCode!==code()) {
          const warning=$('[data-tutor-stale]');if(warning)warning.classList.remove('hidden');
          $$('[data-ai-line]').forEach(b=>b.disabled=true);
        }
        scheduleCopilot(update.view);
      }
      if (update.docChanged || update.selectionSet) {
        const pos=update.state.selection.main.head,line=update.state.doc.lineAt(pos);
        $('[data-cursor]').textContent=`行 ${line.number}，列 ${pos-line.from+1}`;
      }
    })
  ]});
}
function createEditor() {
  editor=new EditorView({state:editorState(current.draft.code),parent:$('.editor-host'),root});
  editor.scrollDOM.addEventListener('scroll',()=>renderInlineDiagnosis(),{passive:true});
  if(window.ResizeObserver)new ResizeObserver(()=>renderInlineDiagnosis()).observe(editor.dom);
  window.addEventListener('resize',()=>{renderInlineDiagnosis();editor?.requestMeasure();});
}
// 最近一次从提交历史里读到的源码，供「放进代码栏」使用。
let historyCode='';
/**
 * Put a past submission into the editor.
 *
 * It goes in through a normal transaction, so Ctrl+Z still brings the old code back and
 * the draft follows the editor as usual - nothing is destroyed irreversibly.
 */
function applyHistoryCode(source){
  if(!editor)return;
  editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:source},selection:{anchor:0},scrollIntoView:true});
  saveDraft();
  editor.focus();
  toast('已放进代码栏，Ctrl+Z 可以撤销');
}
function renderDescription() {
  const p=current.problem;
  replaceContent($('[data-left-body]'),`<article class="description">
    <div class="title-row"><h1>${esc(p.title)}</h1>${current.result?.passed===current.result?.total && current.result?.total ? `<span class="solved muted">已解答 ${icon('check','green')}</span>`:''}</div>
    <div class="chips">${p.score?`<span class="chip green">满分 ${esc(p.score)}</span>`:''}${p.tests[0]?.memory?`<span class="chip">内存 ${esc(p.tests[0].memory)}</span>`:''}${p.discount?`<span class="chip">折扣系数 ${esc(p.discount)}</span>`:''}</div>
    <div class="statement">${p.html || '<p class="muted">此题没有可读取的题干。</p>'}</div>
    ${p.tests.map((t,i)=>`<section class="example"><h3>示例 ${i+1}：</h3><div class="example-data"><div class="io-line"><strong>输入：</strong><pre>${esc(t.input)}</pre></div><div class="io-line"><strong>输出：</strong><pre>${ioDisplay(t.expected)}</pre></div></div></section>`).join('')}
    <details class="schedule" open><summary>提交时间与规则</summary><dl>${p.timing.map(t=>`<dt>${esc(t.label)}</dt><dd><time>${esc(t.date)}</time><span class="muted">${esc(t.time)}</span></dd>`).join('')}${p.late?`<dt>允许迟交</dt><dd>${esc(p.late)}</dd>`:''}</dl></details>
    </article>`);
}
/** Verdict from the last custom run, so a case tab turns green (passed) or red (failed). */
function caseVerdict(index){
  const r=current?.result;
  if(!r||r.source!=='custom'||!Array.isArray(r.rows))return '';
  const row=r.rows[index];
  return row?(row.passed?'ok':'bad'):'';
}
/** Render a newline as a visible ↵ so a trailing newline is never a guess. */
const eolMark = value => esc(String(value ?? '')).replace(/\n/g, '<span class="io-eol">↵</span>\n');
function renderCases() {
  stopWithin($('[data-bottom-body]'));
  const tests=current.draft.tests;
  testIndex=Math.max(0,Math.min(testIndex,tests.length-1));
  $('[data-bottom-body]').innerHTML=`<div class="case-toolbar">${tests.map((t,i)=>`<button data-case="${i}" class="${i===testIndex?'selected':''} ${caseVerdict(i)}">Case ${i+1}</button>`).join('')}${button('add-case','','plus','','新增用例')}</div>
    ${tests.length?`<div class="case-content"><label class="field"><span class="field-head">输入</span><span class="eol-wrap"><span class="eol-mirror" aria-hidden="true">${eolMark(tests[testIndex].input)}</span><textarea data-test-input spellcheck="false" ${tests[testIndex].source==='公开样例'?'readonly':''}>${esc(tests[testIndex].input)}</textarea></span></label><label class="field"><span class="field-head">期望输出</span><span class="eol-wrap"><span class="eol-mirror" aria-hidden="true">${eolMark(tests[testIndex].expected)}</span><textarea data-test-expected spellcheck="false" ${tests[testIndex].source==='公开样例'?'readonly':''}>${esc(tests[testIndex].expected)}</textarea></span></label><div class="case-tools"><span>${esc(tests[testIndex].source||'自定义')}</span>${button('delete-case','删除用例','trash')}${button('generate','AI 生成','ai')}${button('restore-cases','恢复公开样例','history')}</div></div>`:`<div class="empty">暂无用例。点击 + 添加输入与期望输出。</div>`}
    <div class="notice">自定义用例由执行 API 运行；「提交」使用 Moodle 官方测试集。</div>`;
  reveal($('[data-bottom-body]'));
}
/** Compiler diagnostics explained in plain Chinese, each linked to its line. */
function compilePanel(message) {
  const issues=parseCompileIssues(message);
  const list=issues.length?'<div class="compile-issues">'+issues.map(issue=>
    '<article class="compile-issue '+issue.severity+'"><header><span class="severity-dot"></span><strong>'+esc(issue.title)+
    '</strong><button data-compile-line="'+issue.startLine+'">L'+issue.startLine+'</button></header><p>'+esc(issue.problem)+'</p>'+
    (issue.hint?'<div class="tutor-hint"><span>怎么改</span>'+esc(issue.hint)+'</div>':'')+'</article>').join('')+'</div>':'';
  // Nothing was recognised as a diagnostic: say so plainly instead of showing one
  // sentence with no explanation, and open up everything else the page did contain.
  const others=(current?.result?.blocks||[]).filter(block=>block.value!==message);
  return '<div class="result-detail">'+list+
    (issues.length
      ?'<p class="compile-lead">这些问题已经按行标在编辑器右侧，点 L 行号可以直接跳过去。</p>'
      :'<p class="compile-lead">Moodle 这次只回了这一句，没带编译器诊断。下面是结果页上全部的文本块，可以看看判题机到底说了什么。</p>')+
    '<details class="tutor-json tutor-reveal"><summary>编译器原始输出</summary><pre>'+esc(message)+'</pre></details>'+
    (others.length?'<details class="tutor-json tutor-reveal" open><summary>结果页上的其它文本（'+others.length+' 段）</summary>'+
      others.slice(0,8).map(block=>'<p class="compile-source">来自 '+esc(block.where)+'</p><pre>'+esc(block.value.slice(0,4000))+'</pre>').join('')+'</details>':'')+
    '<div class="result-assist">'+button('explain-error','AI 讲讲这几个错','ai','purple')+'</div></div>';
}
/**
 * Warnings from a build that still produced a module.
 *
 * A failed build already gets the full panel; a successful one used to show nothing at
 * all, which is how "scanf("%d", a)" ran to completion looking perfectly normal.
 */
function compileWarnings(){return (current?.compileIssues||[]).filter(i=>i.severity==='warning');}
/** One compiler diagnostic, as a card the editor can jump to. */
function issueCardsHTML(issues){
  return issues.map(issue=>'<article class="compile-issue '+issue.severity+'"><header><span class="severity-dot"></span><strong>'+esc(issue.title)+
    '</strong><button data-compile-line="'+issue.startLine+'">L'+issue.startLine+'</button></header><p>'+esc(issue.problem)+'</p>'+
    (issue.hint?'<div class="tutor-hint"><span>怎么改</span>'+esc(issue.hint)+'</div>':'')+'</article>').join('');
}
function compileWarnHTML(){
  const issues=compileWarnings();
  if(!issues.length)return '';
  return '<div class="compile-warnings"><div class="section-kicker">编译器警告 <span>'+issues.length+'</span><small>不影响运行，但通常正是 bug 的起点</small></div>'+
    issueCardsHTML(issues)+'</div>';
}
/**
 * The trace player has one line to spare, not a panel.
 *
 * The summary stays visible so a warning is never silently hidden behind the animation,
 * and the cards open on demand so the player is not pushed out of view.
 */
function compileWarnStrip(){
  const issues=compileWarnings();
  if(!issues.length)return '';
  return '<details class="compile-warn-strip"><summary><span class="severity-dot"></span><b>编译器警告 '+issues.length+' 条</b><small>'+
    esc(issues[0].title)+(issues.length>1?' 等':'')+'</small></summary><div class="compile-issues">'+issueCardsHTML(issues)+'</div></details>';
}
/**
 * The judge does not always compile what is on screen.
 *
 * A result can belong to an earlier submission, and a selected source file is submitted
 * instead of the editor - so a compile error can be about code the learner is no longer
 * looking at. Naming the difference is the only way to read that error correctly.
 */
function resultMismatch(r){
  const lines=value=>String(value||'').replace(/\r\n/g,'\n');
  const judged=typeof r.submittedCode==='string'?r.submittedCode:null;
  const changed=judged!==null&&lines(judged)!==lines(code());
  if(!changed&&!r.uploadedFile)return '';
  return '<div class="result-warning">'+
    (r.uploadedFile?'这次提交带的是源文件 <b>'+esc(r.uploadedFile)+'</b>，判题机编译的是它。':'')+
    (changed?'这条结果对应的代码和编辑器里现在的不一样：提交时 '+lines(judged).split('\n').length+' 行，现在 '+lines(code()).split('\n').length+' 行。':'')+
    (judged!==null?' '+button('show-submitted','看看提交的那份'):'')+
    '</div>';
}
function renderResults() {
  stopWithin($('[data-bottom-body]'));
  const r=current.result;
  if (!r) { $('[data-bottom-body]').innerHTML=`<div class="empty">${icon('terminal')}提交代码后，判题结果将在这里显示。</div>`;return; }
  const good=r.total>0 && r.total===r.passed;
  resultIndex=Math.max(0,Math.min(resultIndex,r.rows.length-1));
  const selected=r.rows[resultIndex];
  if(r.pending){
    replaceContent($('[data-bottom-body]'),loadingHTML(r.message||'正在判题','保留当前代码与用例，等待 Moodle 返回本次结果。'));
    animateLoading($('[data-bottom-body]'));return;
  }
  $('[data-bottom-body]').innerHTML=`<section class="results">
    <div class="result-title ${good?'green':r.pending?'muted':'red'}">${good?'通过':r.compile?'编译错误':r.pending?'判题中':r.total?'未通过':'暂无结果'}<small>${r.total?`${r.passed} / ${r.total} 个用例通过`:esc(r.message)}</small></div>
    ${r.source==='previous'?'<p class="result-warning">以下为此前提交的结果，不能代表当前编辑器中的代码。</p>':''}
    ${resultMismatch(r)}
    ${r.compile?'':compileWarnHTML()}
    <div class="result-assist">${button('tutor-diagnose','分析这次结果','ai','purple')}</div>
    ${r.submitId?`<div class="submission-id">提交 #${esc(r.submitId)}</div>`:''}
    ${r.rows.length?`<div class="table-wrap"><table class="results-table"><thead><tr><th>用例</th><th>状态</th><th>用时 / 秒</th><th>内存</th></tr></thead><tbody>${r.rows.map((row,i)=>`<tr tabindex="0" data-result="${i}" class="${i===resultIndex?'selected':''}"><td>${esc(row.no)}</td><td class="${row.passed?'green':'red'}">${esc(row.verdict)}</td><td>${esc(row.time)}</td><td>${esc(row.memory)}</td></tr>`).join('')}</tbody></table></div>`:''}
    ${selected?`<div class="result-detail"><div class="facts"><span>用例 ${esc(selected.no)}</span><span>权重 ${esc(selected.weight)}</span><span>时间限制 ${esc(selected.limit)}</span><span>内存限制 ${esc(selected.memoryLimit)}</span><span>返回值 ${esc(selected.exit)}</span></div>${diffBlock(selected.expected,selected.actual)}${['input','expected','actual','error'].map((key,i)=>`<div><label>${['输入','期望输出','实际输出','错误信息'][i]}</label>${selected.downloads?.[i]?.length?`<a href="${esc(selected.downloads[i][selected.downloads[i].length-1].url)}" target="_blank" rel="noopener">查看完整内容</a>`:''}<pre>${ioDisplay(selected[key] || (key==='error'?'无':'（空）'))}</pre></div>`).join('')}</div>`:''}
    ${r.compile?compilePanel(r.message):''}
    </section>`;
  reveal($('.results'));
}
function switchBottom(tab) {
  activeBottom=tab;
  $$('[data-bottom]').forEach(b=>{b.classList.toggle('active',b.dataset.bottom===tab);b.setAttribute('aria-selected',String(b.dataset.bottom===tab));});
  if (tab==='cases') renderCases(); else renderResults();
}
async function switchLeft(tab) {
  activeLeft=tab;
  $$('[data-left]').forEach(b=>{b.classList.toggle('active',b.dataset.left===tab);b.setAttribute('aria-selected',String(b.dataset.left===tab));});
  if(tab==='description') return renderDescription();
  if(tab==='tutor')return renderTutor();
  replaceContent($('[data-left-body]'),loadingHTML('正在读取提交记录'));
  animateLoading($('[data-left-body]'));
  const id=current.id;
  const doc=await requestDoc(activity('history.php'));
  if (current.id!==id || activeLeft!=='history') return;
  const entries=[...doc.querySelectorAll('#submitlist a[submitid]')];
  replaceContent($('[data-left-body]'),`<div class="history"><h3>提交记录</h3>${entries.map(a=>{const url=esc(safeURL(a.getAttribute('href'),base));return `<div class="history-row"><button class="history-item" data-history="${url}"><span>${esc(text(a).replace(/-\s+(\d)/g,'-$1'))}</span><small>#${esc(a.getAttribute('submitid'))}</small></button><button class="history-paste" data-paste-history="${esc(url)}" title="把这次提交的代码放进代码栏">${icon('code')}粘贴到代码栏</button></div>`;}).join('')||'<div class="empty">还没有提交记录</div>'}<div data-history-code></div></div>`);
}
async function loadExercise(viewURL, push=true) {
  if (busy) return;
  tutorRequest?.abort();tutorRequest=null;completionRequest?.abort();
  saveDraft();
  const token=++navToken;
  if (host) setBusy(true);
  try {
    viewURL=proxyURL(viewURL).href;
    const viewDoc=await requestDoc(viewURL);
    const problem=parseProblem(viewDoc,viewURL);
    if (!problem.submitURL) throw new Error('该活动未提供提交入口');
    problem.submitURL=proxyURL(problem.submitURL).href;
    const submitDoc=await requestDoc(problem.submitURL);
    const form=[...submitDoc.querySelectorAll('form')].find(f=>f.querySelector('textarea[name=code]'));
    if (!form) throw new Error('此题当前没有可用的提交表单');
    const id=form.querySelector('[name=a]')?.value || new URL(problem.submitURL).searchParams.get('a');
    if (!id || token!==navToken) return;
    const nav=parseNavigation(viewDoc,viewURL,problem.title);
    if (nav.length) problems=nav;
    const old=read(`moodle-ide:v3:${new URL(problem.submitURL).origin}${new URL(problem.submitURL).pathname}${new URL(problem.submitURL).search}`,{});
    saveDraft();
    // The database is authoritative; localStorage is the older copy kept in step for
    // the synchronous paths, so it is only used when there is nothing to read back.
    const cachedDraft=read(draftKey(id),null);
    const storedDraft=await storeGet(draftKey(id)).catch(()=>null);
    const fallback={code:old.code ?? form.querySelector('textarea[name=code]').value,tests:problem.tests.map(t=>({...t,source:'公开样例'}))};
    const draft=storedDraft||cachedDraft||fallback;
    // Anything found only in the cache is moved across on the spot.
    if(!storedDraft&&cachedDraft)storeSet(draftKey(id),cachedDraft).catch(()=>{});
    if (!Array.isArray(draft.tests)) draft.tests=problem.tests.map(t=>({...t,source:'公开样例'}));
    // The cases shipped with the problem are permanent: they are always restored if missing.
    problem.tests.forEach(sample=>{
      const kept=draft.tests.some(t=>t.input===sample.input&&t.expected===sample.expected);
      if(!kept)draft.tests.unshift({...sample,source:'公开样例'});
    });
    const nativeCompiler=form.querySelector('select[name=language]');
    if (draft.compiler && [...nativeCompiler.options].some(o=>o.value===draft.compiler)) nativeCompiler.value=draft.compiler;
    current={id,problem,form,viewURL,submitURL:problem.submitURL,draft,result:null,viewDoc,submitDoc,tutor:{status:'idle',mode:'guide',question:''}};
    currentIndex=problems.findIndex(p=>p.current);
    testIndex=0; resultIndex=0;
    if (!host) { mount();createEditor(); }
    else editor.setState(editorState(draft.code));
    $('[data-cursor]').textContent='行 1，列 1';
    $('[data-language]').innerHTML=[...nativeCompiler.options].map(o=>`<option value="${esc(o.value)}">${esc(text(o))}</option>`).join('');
    $('[data-language]').value=nativeCompiler.value;
    $('[data-file-slot]').replaceChildren();
    const file=form.querySelector('input[type=file]');
    if(file){
      file.setAttribute('aria-label','源文件');
      $('[data-file-slot]').append(file);
      // A selected file is submitted instead of the editor, so it must never be hidden
      // while it is still attached - that is how a compile error ends up describing code
      // the learner cannot see.
      file.onchange=()=>{
        const picked=!!(file.files&&file.files.length);
        $('[data-attachment]').classList.toggle('hidden',!picked);
        if(picked)toast('提交时会优先用这个文件，判题机编译的不是编辑器里的代码。');
      };
    }
    $('[data-attachment]').classList.toggle('hidden',!file||!file.files||!file.files.length);
    $('[data-course]').textContent=text(viewDoc.querySelector('title')).split(':')[0] || '编程练习';
    $('[data-sample-count]').textContent=`${problem.tests.length} 个公开样例`;
    $('[data-position]').textContent=currentIndex>=0?`${currentIndex+1}/${problems.length}`:'';
    await switchLeft('description'); switchBottom('cases');
  maybeOfferToolchain().catch(()=>{});
    if(push) history.pushState({workspace:true},'',problem.submitURL);
    document.title=`${problem.title} · 编程工作区`;
    saveDraft();
  } finally { if(host && token===navToken) setBusy(false); }
}
async function navigateOffset(offset) {
  if (busy || currentIndex<0) return;
  const p=problems[currentIndex+offset]; if(p) await loadExercise(p.url);
}
function closeModal(options={}) {
  modalCleanup?.();modalCleanup=null;
  const overlays=$$('.overlay');
  if(!overlays.length)return;
  const finish=overlay=>{stopWithin(overlay);overlay.remove();};
  if(options.immediate||reducedMotion.matches){overlays.forEach(finish);return;}
  overlays.forEach(overlay=>{
    if(overlay.dataset.closing)return;
    overlay.dataset.closing='1';overlay.style.pointerEvents='none';
    const panel=overlay.firstElementChild;
    motion(overlay,{opacity:[1,0],duration:150,ease:'inCubic'});
    if(panel)motion(panel,overlay.classList.contains('drawer-overlay')
      ?{translateX:[0,-18],opacity:[1,0],duration:200,ease:'inCubic'}
      :{translateY:[0,8],scale:[1,.985],opacity:[1,0],duration:200,ease:'inCubic'});
    setTimeout(()=>finish(overlay),220);
  });
}
function openModal(content,drawer=false) {
  closeModal({immediate:true});
  const previous=root.activeElement;
  const overlay=document.createElement('div');overlay.className=`overlay ${drawer?'drawer-overlay':''}`;
  overlay.innerHTML=`<section class="${drawer?'drawer':'dialog'}" role="dialog" aria-modal="true">${content}</section>`;
  root.append(overlay);
  motion(overlay,{opacity:[0,1],duration:180});
  motion(overlay.firstElementChild,drawer?{translateX:[-24,0],opacity:[0,1],duration:340}:{translateY:[14,0],scale:[.985,1],opacity:[0,1],duration:320});
  overlay.onclick=e=>{if(e.target===overlay || e.target.closest('[data-close]'))closeModal();};
  overlay.addEventListener('keydown',e=>{
    if(e.key==='Tab') {
      const nodes=[...overlay.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')];
      if(e.shiftKey && root.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}
      if(!e.shiftKey && root.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}
    }
  });
  modalCleanup=()=>previous?.focus();
  overlay.querySelector('input,button')?.focus();
  return overlay;
}
function openProblems() {
  const modal=openModal(`<header><h2>题库</h2><button data-close aria-label="关闭">${icon('close')}</button></header><input data-search placeholder="搜索题号或题目名称…" aria-label="搜索题目"><div class="problem-list"></div><div class="hint">${problems.length} 道题 · 方向键切换：Alt + ← / →</div>`,true);
  const render=()=>{
    const value=modal.querySelector('input').value.toLowerCase().trim();
    modal.querySelector('.problem-list').innerHTML=problems.map((p,i)=>({p,i})).filter(({p})=>p.title.toLowerCase().includes(value)).map(({p,i})=>`<button class="problem-item ${i===currentIndex?'active':''}" data-problem="${i}"><span>${esc(p.title)}</span><small>${i===currentIndex?'当前':''}</small></button>`).join('') || '<div class="empty">没有匹配的题目</div>';
  };
  modal.querySelector('input').oninput=render;render();
}
function openSettings(focusKey) {
  const missing=!hasKey();
  const m=openModal(`<header><h2>AI 与执行设置</h2><button data-close aria-label="关闭">${icon('close')}</button></header>
    <div class="provider-badge">${icon('ai','purple')}硅基流动 · 密钥只保存在本机</div>
    <label class="field">固定 API 端点<input data-endpoint readonly value="${esc(AI_CONFIG.endpoint)}"></label>
    <label class="field">固定模型<input data-model readonly value="${esc(AI_CONFIG.model)}"></label>
    <label class="field">API Key<input data-key type="password" placeholder="sk-…" autocomplete="off" spellcheck="false" aria-label="硅基流动 API Key"><span class="field-note" data-key-state></span></label>
    <label class="check"><input data-enabled type="checkbox">启用 AI 辅导、补全与用例生成</label>
    <label class="check"><input data-copilot type="checkbox">打字停顿后自动内联补全（灰色预览，Tab 接受 / Esc 丢弃 / Alt+i 立即补一次）</label>
    <p class="hint">在 <a href="https://cloud.siliconflow.cn/account/ak" target="_blank" rel="noopener">硅基流动控制台</a> 建一个密钥粘到这里即可。密钥只写进这台浏览器的 localStorage，<strong>脚本更新后依然保留</strong>，不会上传到任何地方。点击 AI 功能时才会把题干、代码、用例与判题详情发送给硅基流动。所有 AI 功能使用同一固定模型，不会静默切换。</p>
    <label class="field">自定义用例执行 API（留空则使用内置在线编译器）<input data-runner type="url" placeholder="留空 = 内置在线编译器；或填写 https://…/run"></label>
    <details class="hint"><summary>执行 API 数据格式</summary><p>请求：{ code, language, tests: [{input, expected}] }<br>响应：{ results: [{ stdout, stderr, time, memory }] }。端点必须支持 CORS。</p></details>
    <div class="hint" data-connection role="status"></div><footer><button data-test-connection>测试连接</button><button data-save-settings class="primary">保存设置</button></footer>`);
  m.querySelector('[data-runner]').value=prefs.runner;
  m.querySelector('[data-enabled]').checked=prefs.enabled;
  m.querySelector('[data-copilot]').checked=prefs.copilot;
  m.querySelector('[data-key]').value=getKey();
  const keyState=m.querySelector('[data-key-state]');
  const paintKeyState=()=>{
    const typed=m.querySelector('[data-key]').value.trim();
    keyState.textContent=typed?(typed===getKey()?'已缓存到本机，脚本更新后仍然有效':maskKey(typed)+'（尚未保存）'):'还没有填写，AI 功能会不可用';
  };
  paintKeyState();
  m.querySelector('[data-key]').addEventListener('input',paintKeyState);
  const values=()=>({enabled:m.querySelector('[data-enabled]').checked,copilot:m.querySelector('[data-copilot]').checked,runner:m.querySelector('[data-runner]').value.trim()});
  m.querySelector('[data-save-settings]').onclick=()=>{
    try {
      const next=values();validateSettings(next);
      setKey(m.querySelector('[data-key]').value);
      prefs=next;persist(prefsKey,{aiV5Enabled:prefs.enabled,runner:prefs.runner,copilot:prefs.copilot});closeModal();toast(hasKey()?'设置已保存，密钥已缓存到本机':'设置已保存');
    } catch(e) { m.querySelector('[data-connection]').textContent=e.message; }
  };
  if(focusKey||missing)m.querySelector('[data-key]').focus();
  m.querySelector('[data-test-connection]').onclick=async e=>{
    const b=e.currentTarget;b.disabled=true;
    try {setKey(m.querySelector('[data-key]').value);paintKeyState();await llm('只回复 OK。');m.querySelector('[data-connection]').textContent='连接成功，模型已返回响应。密钥已缓存到本机。';}
    catch(err){m.querySelector('[data-connection]').textContent=err.message;}
    finally{b.disabled=false;}
  };
}
/** Drop the trailing JSON block so partial tutor output can be shown while it streams. */
function streamNarrative(value) {
  const text=String(value||'');
  const cut=text.search(/\n\s*\x60\x60\x60|\n\s*\{\s*"/);
  return cut<0?text:text.slice(0,cut);
}
/** Paint incoming tutor text into the loading block without re-rendering the panel. */
function appendTutorStream(t,full) {
  t.stream=full;
  if(current?.tutor!==t || activeLeft!=='tutor')return;
  const body=$('[data-left-body]');if(!body)return;
  let pre=body.querySelector('[data-tutor-stream]');
  if(!pre){
    const host=body.querySelector('.ai-loading');
    if(!host)return;
    host.replaceChildren();
    pre=document.createElement('pre');
    pre.className='ai-stream';pre.setAttribute('data-tutor-stream','');
    host.append(pre);
  }
  pre.textContent=streamNarrative(full);
  pre.scrollTop=pre.scrollHeight;
}
/** Every AI entry point goes through here so a missing key opens settings instead of failing awkwardly. */
function aiReady() {
  if(!prefs.enabled){openSettings();return false;}
  if(!hasKey()){openSettings();toast('还没有填写 API Key，填好保存后就能用了。');return false;}
  return true;
}
function validateSettings(v) {
  if(v.runner && (!/^https?:\/\//i.test(v.runner) || !safeURL(v.runner,location.href)))throw new Error('请输入完整的 HTTP(S) 地址');
}
async function requestPreview(label,prompt,options={}) {
  if(completionRequest){toast('已有 AI 请求正在进行。');return null;}
  const {keepOpen=false,...llmOptions}=options;
  const controller=new AbortController();completionRequest=controller;
  const m=openModal('<header><h2>'+esc(label)+'</h2><button data-close aria-label="停止请求">'+icon('close')+'</button></header>'+
    '<div data-stream-host>'+loadingHTML('正在生成建议','你可以随时停止，不会自动修改代码或用例。')+'</div>'+
    '<footer><button data-close>停止请求</button></footer>');
  const cleanup=modalCleanup;
  modalCleanup=()=>{cleanup?.();controller.abort();};
  animateLoading(m);
  const host=m.querySelector('[data-stream-host]');
  let started=false;
  // Streaming: plain-text answers are written out as they arrive; JSON answers
  // only report progress, because half a JSON object is not worth showing.
  const onDelta=(delta,full)=>{
    if(!started){
      started=true;
      host.innerHTML=llmOptions.json?'<p class="ai-stream-note"></p>':'';
      if(!llmOptions.json){const pre=document.createElement('pre');pre.className='ai-stream';host.append(pre);}
    }
    const node=host.firstElementChild;
    if(llmOptions.json)node.textContent='正在生成用例… 已接收 '+full.length+' 个字符';
    else{node.textContent=streamNarrative(full);node.scrollTop=node.scrollHeight;}
  };
  try{
    const answer=await llm(prompt,{...llmOptions,signal:controller.signal,onDelta});
    if(keepOpen && m.isConnected){
      host.innerHTML='<section class="tutor-explanation"><div class="section-kicker">AI 的解释</div><div data-answer></div></section>';
      host.querySelector('[data-answer]').innerHTML=tutorNarrative(answer);
      m.querySelector('footer').innerHTML='<button data-close>关闭</button>';
      reveal(host);
    }
    return answer;
  }
  catch(error){if(controller.signal.aborted)return null;toast(error.message);return null;}
  finally{if(!keepOpen&&$('.overlay')===m)closeModal();if(completionRequest===controller)completionRequest=null;}
}
async function complete() {
  if(!aiReady())return;
  const doc=editor.state.doc.toString(),selection=editor.state.selection.main,id=current.id;
  const answer=await requestPreview('AI 代码补全',`只返回插入 <CURSOR> 处的代码片段，不要重复已有代码。\n题目：${current.problem.statement}\n代码：\n${doc.slice(0,selection.from)}<CURSOR>${doc.slice(selection.to)}`);
  if(answer===null)return;
  if(current.id!==id || code()!==doc){toast('代码已发生变化，本次补全已丢弃');return;}
  const m=openModal(`<header><h2>AI 补全建议</h2><button data-close aria-label="关闭">${icon('close')}</button></header><pre>${esc(answer)}</pre><footer><button data-close>取消</button><button data-apply class="primary">插入光标处</button></footer>`);
  m.querySelector('[data-apply]').onclick=()=>{if(current.id===id && code()===doc)editor.dispatch({changes:{from:selection.from,to:selection.to,insert:answer}});closeModal();editor.focus();};
}
function openGenerateDialog() {
  if(!aiReady())return;
  const m=openModal(`<header><h2>AI 生成测试用例</h2><button data-close aria-label="关闭">${icon('close')}</button></header>
    <label class="field">生成数量<input data-gen-count type="number" min="1" max="12" value="5"></label>
    <label class="field">额外要求（可选）<textarea data-gen-ask placeholder="例如：覆盖负数、零、最大值、多组空格"></textarea></label>
    <p class="hint">留空则默认生成 5 个，并尽可能覆盖边界与特殊情况。</p>
    <footer><button data-close>取消</button><button data-gen-run class="primary">生成</button></footer>`);
  m.querySelector('[data-gen-run]').onclick=()=>{
    const count=Math.min(12,Math.max(1,Number(m.querySelector('[data-gen-count]').value)||5));
    const ask=m.querySelector('[data-gen-ask]').value.trim();
    closeModal();
    generateTests(count,ask).catch(error=>toast(error.message));
  };
}
async function generateTests(count=5,extra='') {
  if(!aiReady())return;
  const id=current.id;
  const samples=current.problem.tests.map((t,i)=>`示例 ${i+1}：输入 ${JSON.stringify(t.input)} → 输出 ${JSON.stringify(t.expected)}`).join('\n');
  const prompt=[
    `请为下面的题目生成 ${count} 个测试用例。`,
    `题目要求：\n${current.problem.statement}`,
    samples?`题目自带的示例用例（格式基准，换行写法必须与之一致）：\n${samples}`:'',
    extra?`额外要求：${extra}`:'请尽可能覆盖所有特殊情况与边界（零、负数、最大/最小值、多空格或空行、极端输入等）。',
    `严格返回 JSON {"tests":[{"input":"...","expected":"..."}]}，数量为 ${count}。`,
    '判题对输出逐字节严格：input 与 expected 必须与题目格式完全一致，且都以换行符 \\n 结尾（示例用例即如此）。',
  ].filter(Boolean).join('\n\n');
  const answer=await requestPreview('生成测试用例',prompt,{json:true});
  if(answer===null)return;
  const data=JSON.parse(answer);
  if(!Array.isArray(data.tests) || !data.tests.length || data.tests.some(t=>typeof t.input!=='string'||typeof t.expected!=='string'))throw new Error('模型返回的测试用例格式无效');
  if(current.id!==id)return;
  const m=openModal(`<header><h2>检查 AI 生成的用例</h2><button data-close aria-label="关闭">${icon('close')}</button></header><p class="hint">AI 的期望输出可能有误，请检查后再添加。</p><pre>${esc(data.tests.slice(0,5).map((t,i)=>`Case ${i+1}\n输入：${t.input}\n期望：${t.expected}`).join('\n\n'))}</pre><footer><button data-close>取消</button><button data-add-generated class="primary">添加用例</button></footer>`);
  m.querySelector('[data-add-generated]').onclick=()=>{if(current.id!==id)return closeModal();current.draft.tests.push(...data.tests.slice(0,count).map(t=>({...t,source:'AI 生成，需核验'})));saveDraft();closeModal();switchBottom('cases');};
}
function renderTutor() {
  const t=current.tutor,answer=t.answer,stale=t.sourceCode!==undefined&&t.sourceCode!==code();
  const busyAI=t.status==='loading';
  replaceContent($('[data-left-body]'),`<section class="tutor">
    <header class="tutor-heading"><div class="tutor-emblem">${icon('ai')}</div><div><h2>一起找到解题思路</h2><p>先理解原因，再决定是否查看修改方法。</p></div></header>
    <details class="tutor-composer" ${answer?'':'open'}><summary>调整提问 <span>${t.mode==='guide'?'引导做题':'诊断错误'}</span></summary>
    <div class="tutor-modes" role="group" aria-label="辅导模式"><button data-tutor-mode="guide" class="${t.mode==='guide'?'selected':''}" ${busyAI?'disabled':''}>引导做题</button><button data-tutor-mode="diagnose" class="${t.mode==='diagnose'?'selected':''}" ${busyAI?'disabled':''}>诊断错误</button></div>
    <label class="field tutor-question">你卡在哪里？<textarea data-tutor-question placeholder="例如：为什么样例正确，提交却没有通过？" ${busyAI?'disabled':''}>${esc(t.question)}</textarea></label>
    </details>
    <div class="tutor-actions">${busyAI?button('cancel-tutor','停止分析','close'):button('ask-tutor',answer?'重新分析':'开始辅导','ai','tutor-primary')}<span>${esc(AI_CONFIG.model.split('/').pop())}</span></div>
    <p class="tutor-privacy">点击后发送：题干、当前代码、测试输入与期望输出、最新提交结果。建议不会自动修改代码。</p>
    <div class="tutor-response" aria-busy="${busyAI}">
    ${busyAI?(t.stream?'<pre class="ai-stream" data-tutor-stream>'+esc(streamNarrative(t.stream))+'</pre>':loadingHTML(t.phase||'正在整理题目与测试证据','分析期间可继续编写代码；过期的行号标记会自动失效。')):
      t.status==='error'?`<div class="tutor-error" role="alert"><strong>这次分析没有完成</strong><p>${esc(t.error)}</p><span>可保留当前代码重试，或在设置中测试连接。</span></div>`:''}
    ${!busyAI&&answer?`
      <div data-tutor-stale class="result-warning ${stale?'':'hidden'}">代码已修改。以下分析对应修改前的快照，行号定位已停用，请重新分析。</div>
      <div class="tutor-context"><span>${t.context.publicCases} 个公开样例</span><span>${t.context.customCases} 个工作区用例</span><span>${t.context.resultCases} 条判题结果</span></div>
      ${t.context.warning?`<p class="tutor-note">${esc(t.context.warning)}</p>`:''}
      <section class="tutor-explanation"><div class="section-kicker">思路与证据</div>${tutorNarrative(answer.explanation)}</section>
      <div class="section-kicker">逐行问题 <span>${answer.issues.length}</span></div>
      <div class="tutor-issues">${answer.issues.map((issue,i)=>{
        const {suggestion,replacement,...visible}=issue;
        return `<article class="tutor-issue ${issue.severity}">
          <header><span class="severity-dot"></span><strong>${esc(issue.title)}</strong><button data-ai-line="${i}" ${!issue.startLine||stale?'disabled':''}>${issue.startLine?`L${issue.startLine}${issue.endLine!==issue.startLine?`–${issue.endLine}`:''}`:'整体思路'}</button></header>
          <p>${esc(issue.problem)}</p>${issue.hint?`<div class="tutor-hint"><span>想一想</span>${esc(issue.hint)}</div>`:''}
          ${issue.locationWarning?'<p class="tutor-note">模型返回的行号超出代码范围，已停用定位。</p>':''}
          <details class="tutor-json tutor-reveal"><summary>问题 JSON</summary><pre>${esc(JSON.stringify(visible,null,2))}</pre></details>
          <details class="tutor-fix tutor-reveal"><summary>${icon('code')}查看修改建议 <span>默认隐藏</span></summary><div class="fix-content">${tutorNarrative(suggestion||'先根据上方提示尝试调整。')}${replacement?`<pre>${esc(replacement)}</pre>`:''}<p class="tutor-note">建议代码仅供参考，请自行理解和验证。</p></div></details>
        </article>`;
      }).join('')||'<div class="tutor-clear">未发现可确认的逐行问题。可继续检查边界输入和输出格式。</div>'}</div>
      ${answer.nextSteps.length?`<section class="tutor-next"><div class="section-kicker">接下来试一试</div><ol>${answer.nextSteps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol></section>`:''}
      <p class="tutor-disclaimer">AI 分析不等于判题结论。修改后请重新运行或提交验证。</p>
    `:!busyAI&&t.status==='idle'?'<div class="tutor-welcome"><strong>不急着给答案</strong><p>可以从读懂题意开始，也可以结合失败用例定位问题。所有修改建议都由你主动展开。</p></div>':''}
    </div></section>`);
  if(busyAI)animateLoading($('.tutor-response'));
  else if(answer)reveal($('.tutor-issues'));
}
async function askTutor() {
  if(!aiReady())return;
  if(tutorRequest)return;
  const exercise=current,t=exercise.tutor,sourceCode=code(),controller=new AbortController();
  tutorRequest=controller;
  Object.assign(t,{status:'loading',phase:'正在读取最新判题证据',error:'',answer:null,stream:'',sourceCode});
  editor.dispatch({effects:diagnosisEffect.of([])});
  renderInlineDiagnosis();
  await switchLeft('tutor');
  try {
    const publicTests=exercise.problem.tests.map(({input,expected,time,memory})=>({input,expected,time,memory}));
    const workspaceTests=exercise.draft.tests.map(({input,expected,source})=>({input,expected,source}));
    let result=exercise.result?.source==='custom'?structuredClone(exercise.result):null;
    let warning='',submittedCode;
    if(!result){
      try {
        result=parseResult(await requestDoc(activity('result.php',exercise.id)),activity('result.php',exercise.id));
        if(result.submitId){
          const historyDoc=await requestDoc(`${activity('history.php',exercise.id)}&submitid=${encodeURIComponent(result.submitId)}`);
          submittedCode=historyDoc.querySelector('#codeview textarea')?.value;
        }
      } catch {warning='未能读取最新官方结果；本次仅依据代码和已有用例分析。';}
    }else submittedCode=result.submittedCode;
    if(controller.signal.aborted || current!==exercise)return;
    const matches=typeof submittedCode==='string'?submittedCode.replace(/\r\n/g,'\n')===sourceCode.replace(/\r\n/g,'\n'):null;
    // A judging result from an earlier edit is a fact for the model (matchesEditor /
    // submittedCode below), not a banner for the learner. Only genuine read failures
    // still surface above the analysis.
    const context={
      problem:{title:exercise.problem.title,statement:exercise.problem.statement},
      editorCode:sourceCode,lineCount:sourceCode.split('\n').length,
      publicTests,workspaceTests,
      submission:result?{
        id:result.submitId||null,source:result.source==='custom'?'custom-runner':'moodle',
        matchesEditor:matches,submittedCode:submittedCode??null,
        status:result.status||'',pending:!!result.pending,compileError:!!result.compile,
        message:result.message||'',passed:result.passed,total:result.total,
        outputMayBeTruncated:result.source!=='custom',
        cases:result.rows.map(({downloads,...row})=>row)
      }:null,
      warning
    };
    const prompt=tutorPrompt(context,t.mode,t.question);
    if(prompt.length>180000)throw new Error('题目与测试数据过大，超出本次分析大小限制。请精简工作区用例后重试。');
    Object.assign(t,{phase:'正在对照代码与输入输出',context:{publicCases:publicTests.length,customCases:workspaceTests.length,resultCases:result?.total||0,warning}});
    if(activeLeft==='tutor')renderTutor();
    const answer=await llm(prompt,{system:TUTOR_SYSTEM,json:true,signal:controller.signal,onDelta:(delta,full)=>appendTutorStream(t,full)});
    if(controller.signal.aborted || current!==exercise)return;
    t.answer=parseTutorResponse(answer,context.lineCount);t.status='done';t.stream='';
    syncDiagnosis();
  }catch(error){
    if(current!==exercise || tutorRequest!==controller)return;
    t.status=controller.signal.aborted?'idle':'error';
    t.error=error.message;
  }finally{
    if(tutorRequest===controller){
      tutorRequest=null;
      if(current===exercise){if(t.status==='loading')t.status='idle';if(activeLeft==='tutor')renderTutor();}
    }
  }
}
function locateIssue(index) {
  const t=current.tutor,issue=t.answer?.issues[index];
  if(!issue?.startLine || t.sourceCode!==code()){toast('代码已变化，请重新分析后定位。');return;}
  const from=editor.state.doc.line(issue.startLine).from,to=editor.state.doc.line(issue.endLine).to;
  $('.workspace').classList.remove('show-description');
  editor.dispatch({selection:{anchor:from,head:to},effects:EditorView.scrollIntoView(from,{y:'center'})});
  editor.focus();
}
async function refreshResult(source='previous') {
  if(busy)return;
  const id=current.id,doc=await requestDoc(activity('result.php'));
  if(id!==current.id)return;
  const result=parseResult(doc,activity('result.php'));
  // A judge compile error gets the same cards and editor marks as a local build.
  current.compileIssues=result.compile?parseCompileIssues(result.message):[];
  syncDiagnosis();
  current.result={...result,source};
  switchBottom('results');
}
/** Newest submission id from the history list; the same ?submitid= shape in intranet and proxied deployments. */
async function newestSubmissionId() {
  const doc=await requestDoc(activity('history.php'));
  const attr=[...doc.querySelectorAll('a[submitid]')].map(a=>a.getAttribute('submitid')).filter(Boolean);
  if(attr.length)return attr[0];
  for(const a of doc.querySelectorAll('a[href*="submitid="]')){
    try{const id=new URL(a.getAttribute('href'),location.href).searchParams.get('submitid');if(id)return id;}catch{}
  }
  return '';
}
async function submit() {
  if(busy)return;
  if(!code().trim() && !$('[data-file-slot] input')?.files.length){toast('请先编写代码或选择源文件');return;}
  setBusy(true);saveDraft();
  current.result={rows:[],total:0,passed:0,pending:true,message:'正在提交…'};switchBottom('results');
  try {
    const before=await newestSubmissionId();
    const data=new FormData(current.form);
    data.set('code',code());data.set('action',current.form.querySelector('[name=action]')?.value||'提交');
    data.set('a',current.id);data.set('language',$('[data-language]').value);
    const file=$('[data-file-slot] input')?.files[0];
    if(file)data.set('sourcefile',file);else data.delete('sourcefile');
    const response=await requestDoc(current.submitURL,{method:'POST',body:data});
    const error=response.querySelector('.errorbox,.notifyproblem');
    if(error)throw new Error(text(error));
    // Wait for the new submission to appear in the history list, then read the result for
    // that exact id. Deterministic whether judging is instant or queued, and whether the
    // page is served directly or through a path-prefix proxy.
    let submitId='';
    for(let attempt=0;attempt<40;attempt++){
      if(attempt)await new Promise(r=>setTimeout(r,1500));
      submitId=await newestSubmissionId();
      if(submitId && submitId!==before)break;
    }
    if(!submitId || submitId===before)throw new Error('未能确认本次提交，请在提交历史中查看结果。');
    const resultURL=activity('result.php')+'&submitid='+encodeURIComponent(submitId);
    let result=parseResult(await requestDoc(resultURL),resultURL);
    for(let attempt=0;attempt<40 && !(result.finished && !result.pending);attempt++){
      await new Promise(r=>setTimeout(r,1500));
      result=parseResult(await requestDoc(resultURL),resultURL);
    }
    if(result.finished && !result.pending){
      // Same treatment as a local build: the diagnostics become cards and editor marks.
      current.compileIssues=result.compile?parseCompileIssues(result.message):[];
      syncDiagnosis();
      current.result={...result,submitId,source:'submitted',submittedCode:data.get('code'),uploadedFile:file?.name||''};
      switchBottom('results');
      return;
    }
    current.result={rows:[],total:0,pending:true,message:'尚未确认本次判题结果，请稍后刷新。'};switchBottom('results');
  } catch(e) {
    current.result={rows:[],total:0,message:e.message,compile:false};switchBottom('results');toast(e.message);
  } finally {setBusy(false);}
}
// Built-in online compiler: Wandbox is a long-running public playground with
// permissive CORS, needs no key and no download. An in-browser LLVM toolchain
// would be ~100 MB, which is not acceptable to fetch on demand.
const ONLINE_COMPILER='https://wandbox.org/api/compile.json';
/**
 * The playground's C compilers, tried in turn.
 *
 * These are the "-c" ids; the plain "gcc-head" is the C++ front end and would compile
 * the learner's C as C++, accepting code their judge rejects and rejecting code it
 * accepts. There is deliberately no C++ fallback.
 */
const ONLINE_C=['gcc-13.2.0-c','gcc-12.3.0-c','gcc-head-c'];
/** Which of them this session has settled on. */
const onlineCompiler={value:0};
/**
 * The judge's dialect, read from the language Moodle itself offers.
 *
 * gcc-3.3 is the default of a course from 2019 and its default is gnu89: a loop that
 * declares its own counter ("for (int i = 0; ...)") is an error there, and it has to be
 * an error here too, or 运行 says yes and 提交 says no.
 */
function dialectFlags(){
  const label=($('[data-language]')?.selectedOptions?.[0]?.textContent||'').toLowerCase();
  // gcc rejects "for (int i = ...)" before C99, but clang only does so under
  // -Werror=c99-extensions, so the strictness has to be asked for explicitly.
  if(/gcc-?3\b|gcc-?2\b|gcc-?4\.[0-3]/.test(label))return['-std=gnu89','-Werror=c99-extensions'];
  if(/gcc-?4\.[4-9]|gcc-?5\b|gcc-?6\b/.test(label))return['-std=gnu99'];
  if(/clang/.test(label))return['-std=gnu89','-Werror=c99-extensions'];
  // The judge could not be read. gcc-3.3 is the common case here, and being stricter
  // than the judge is the safe direction: 运行 must not promise what 提交 refuses.
  return['-std=gnu89','-Werror=c99-extensions'];
}
// A path-prefix proxy can answer a third-party host with its own HTML page instead
// of forwarding the request, so a non-JSON reply is a transport fault worth retrying;
// a compile error from the compiler itself is not.
class CompilerTransportError extends Error { constructor(message){super(message);this.name='CompilerTransportError';} }
async function runOnline(source,stdin){
  let transport;
  for(let attempt=1;attempt<=4;attempt++){
    if(attempt>1)await new Promise(r=>setTimeout(r,2000));
    try {
      let response;
      try {
        response=await fetch(ONLINE_COMPILER,{
          method:'POST',headers:{'Content-Type':'application/json'},
          // A C compiler, never the C++ one: the judge compiles C, and g++ accepting
          // what gcc rejects (or vice versa) is how 运行 and 提交 end up disagreeing.
          body:JSON.stringify({compiler:ONLINE_C[onlineCompiler.value]||ONLINE_C[0],code:source,stdin,'compiler-option-raw':dialectFlags().join('\n')}),
          signal:AbortSignal.timeout(60000),
        });
      } catch(e) { throw new CompilerTransportError('在线编译器请求失败：'+String(e?.message||e).slice(0,80)); }
      if(!response.ok)throw new CompilerTransportError(`在线编译器返回 ${response.status}`);
      const raw=await response.text();
      let data;
      try { data=JSON.parse(raw); }
      catch { throw new CompilerTransportError('在线编译器返回了非 JSON 内容（可能被网络代理拦截）。'); }
      const compileError=(data.compiler_error||'').trim();
      // The playground itself can fail to start a container; that is not the learner's code.
      if(compileError && /OCI runtime error|crun:|Resource temporarily unavailable|internal server error/i.test(compileError)){
        // Move to the next C compiler in the list before giving up on the service.
        onlineCompiler.value=(onlineCompiler.value+1)%ONLINE_C.length;
        throw new CompilerTransportError('在线编译器暂时不可用（服务端资源不足）。');
      }
      if(compileError)throw new Error(compileError.slice(0,400));
      if(data.status!=='0'&&data.program_error)throw new Error((data.program_error||'').trim().slice(0,400));
      return{stdout:data.program_output||'',stderr:data.program_error||''};
    } catch(error){
      if(!(error instanceof CompilerTransportError))throw error;
      transport=error;
    }
  }
  throw new Error(transport.message+' 已重试 4 次；网络代理可能会拦截较慢的境外请求，稍后或在更稳定的网络下重试。');
}
// In-browser C toolchain: Clang/LLVM compiled to WASM, running programs on a WASI
// shim. Nothing is sent to a server, and nothing is kept in the browser cache - the
// files live in a folder the user picks once (see toolchain.mjs for why).
let cToolchain=null;
async function loadCompiler(onProgress){
  if(cToolchain)return cToolchain;
  onProgress?.('正在启动编译器…');
  cToolchain=await loadToolchain();
  return cToolchain;
}
/* ------------------------------------------------------------ 逐行执行动画 --
 * The program is recompiled with a marker before every statement, run once,
 * and the recorded markers are replayed as an animation. Nothing here needs a
 * debugger, and it reuses the same sandbox and compiler as a normal run.
 */
let traceTimer=null;
function traceStop(){
  clearInterval(traceTimer);traceTimer=null;
  if(current?.trace)current.trace.playing=false;
  syncDiagnosis();
  renderTrace();
}
function traceHighlight(line){
  if(!editor)return;
  const n=Math.min(Math.max(line,1),editor.state.doc.lines);
  const from=editor.state.doc.line(n).from;
  editor.dispatch({effects:[
    diagnosisEffect.of([{startLine:n,endLine:n,severity:'info',title:'第 '+n+' 行',problem:'',hint:''}]),
    EditorView.scrollIntoView(from,{y:'center'})
  ]});
  renderInlineDiagnosis();
}
/** Raw steps played under the current mode. "skip" never repeats a line. */
function traceView(){
  const trace=current?.trace;
  return trace?.steps?viewIndices(trace.steps,trace.mode||'skip'):[];
}
function traceSpot(){
  const trace=current?.trace,view=traceView();
  if(!trace||!view.length)return null;
  const at=Math.min(Math.max(trace.cursor||0,0),view.length-1);
  const raw=view[at],previous=trace.steps[view[at-1]];
  return{step:trace.steps[raw],raw,index:at,total:view.length,previous};
}
/**
 * Move the play head and remember what the move passed over.
 *
 * In 跳行模式 one click can cross dozens of raw steps. Recording them here is what lets
 * the player replay the values that went past instead of silently teleporting.
 */
function traceSeekTo(trace,view,next){
  const at=Math.min(Math.max(trace.cursor||0,0),view.length-1);
  trace.cursor=Math.max(0,Math.min(next,view.length-1));
  trace.skip=skippedSteps(trace.steps,view[at],view[trace.cursor]);
}
function traceGoto(index){
  const trace=current?.trace,view=traceView();
  if(!trace||!view.length)return;
  traceSeekTo(trace,view,index);
  traceHighlight(trace.steps[view[trace.cursor]].line);
  renderTrace();
}
function tracePlay(){
  const trace=current?.trace,view=traceView();
  if(!trace||!view.length)return;
  if(trace.playing){traceStop();return;}
  trace.playing=true;
  if((trace.cursor||0)>=view.length-1)trace.cursor=0;
  traceHighlight(trace.steps[view[trace.cursor]].line);
  renderTrace();
  const period=Math.max(120,1100-(trace.speed??5)*90);
  traceTimer=setInterval(()=>{
    const state=current?.trace;
    if(!state?.playing)return traceStop();
    const list=traceView();
    if((state.cursor||0)>=list.length-1)return traceStop();
    traceSeekTo(state,list,(state.cursor||0)+1);
    traceHighlight(state.steps[list[state.cursor]].line);
    renderTrace();
  },period);
}
function traceLabel(){
  const spot=traceSpot();
  if(!spot)return '没有可播放的步骤';
  return '第 '+(spot.index+1)+' / '+spot.total+' 步 · 第 '+spot.step.line+' 行';
}
/** A few lines of source around the current one, as the studio view shows it. */
function traceCodeHTML(center,radius){
  if(!editor)return '';
  const total=editor.state.doc.lines;
  const from=Math.max(1,center-radius),to=Math.min(total,center+radius);
  let html='';
  for(let n=from;n<=to;n++){
    const line=editor.state.doc.line(n).text;
    html+='<div class="ts-line'+(n===center?' now':'')+'"><span class="ts-no">'+n+'</span><code>'+esc(line||' ')+'</code></div>';
  }
  return html;
}
/** Render a value the same way wherever it appears. */
function traceValue(v,raw){
  if(v.kind==='s')return raw||'""';
  if(v.kind==='c'){const code=Number(raw)||0;return "'"+String.fromCharCode(code)+"' "+code;}
  return String(raw);
}
/**
 * A value that changed shows the transition: the old value lifts away struck
 * through while the new one rises into place. Showing only the new number hides
 * the one thing a learner needs to see.
 */
function traceVarHTML(v,changeArg){
  // Callers may pass a boolean; only an object carries the previous value.
  const change=changeArg&&typeof changeArg==='object'?changeArg:null;
  const flag=v.wild?'wild':v.freed?'freed':'';
  const cls='trace-var'+(changeArg?' changed':'')+(flag?' '+flag:'');
  // An uninitialised pointer holds a number the program never chose, so its address is
  // noise; a freed one keeps a real address, and seeing it is what explains the crash.
  const body=v.wild
    ?'<span class="trace-flag">未初始化</span>'
    :(change
      ?'<span class="reel"><span class="reel-old">'+esc(traceValue(v,change.from))+'</span>'+
        '<span class="reel-new">'+esc(traceValue(v,v.value))+'</span></span>'
      :'<span>'+esc(traceValue(v,v.value))+'</span>')+(v.freed?'<span class="trace-flag freed">已释放</span>':'');
  return '<span class="'+cls+'"><b>'+esc(v.name)+'</b>'+body+'</span>';
}
/** Split "arr[0]=4 i=2" into scalars plus arrays keyed by name. */
function groupVars(vars){
  const scalars=[],arrays=new Map();
  for(const v of vars||[]){
    const m=/^(.+)\[(\d+)\]$/.exec(v.name);
    if(m){ if(!arrays.has(m[1]))arrays.set(m[1],[]); arrays.get(m[1]).push({index:Number(m[2]),value:v.value,kind:v.kind}); }
    else scalars.push(v);
  }
  return{scalars,arrays};
}
/** The live call stack, with any value being returned on this step. */
function stackHTML(stack,returns){
  const frames=(stack||[]).map((name,i)=>'<span class="ts-frame'+(i===stack.length-1?' active':'')+'">'+esc(name)+'</span>').join('<i class="ts-arrow">›</i>');
  const back=(returns||[]).length?'<span class="ts-return">'+esc(returns.map(r=>r.name+' 返回 '+(r.value===null?'—':r.value)).join('，'))+'</span>':'';
  return '<span class="ts-stack-label">调用栈</span>'+(frames||'<span class="trace-none">—</span>')+back;
}
/** Arrays are drawn as cells: a cell being read pulses, a cell that changed glows. */
function arrayHTML(name,cells,reads,changed){
  const read=new Set((reads||[]).filter(r=>r.name===name).map(r=>r.index));
  return '<div class="ts-array"><span class="ts-aname">'+esc(name)+'</span><div class="ts-cells">'+
    cells.slice().sort((a,b)=>a.index-b.index).map(c=>{
      const cls='ts-cell'+(read.has(c.index)?' read':'')+(changed.has(name+'['+c.index+']')?' changed':'');
      return '<span class="'+cls+'"><i>'+c.index+'</i><b>'+esc(c.value)+'</b></span>';
    }).join('')+'</div></div>';
}
/**
 * Draw the struct graph for this step.
 *
 * Nodes are laid out on a fixed grid so arrow endpoints can be computed without
 * measuring the DOM. A link is only drawn when its target address is one of the
 * nodes this step actually captured, so a garbage or dangling pointer shows as a
 * stub instead of a line to nowhere.
 */
/** Addresses and links of a step, used to tell what actually changed. */
function graphKeys(nodes){
  const addrs=new Set(),edges=new Set();
  for(const n of nodes||[]){
    addrs.add(n.addr);
    for(const f of n.fields)if(f.kind==='p')edges.add(n.addr+'|'+f.name+'|'+f.value);
  }
  return{addrs,edges};
}
/** Re-apply the saved zoom / pan to the graph. */
function applyGraphView(){
  const v=current?.trace?.view,g=$('.ts-graph'),label=$('.ts-zoom span');
  if(!g||!v)return;
  g.style.transformOrigin='0 0';
  g.style.transform='translate('+v.x+'px,'+v.y+'px) scale('+v.zoom+')';
  if(label)label.textContent=Math.round(v.zoom*100)+'%';
}
/** The pointer variables of a step, plus what the previous step held. */
function graphOptions(spot,compact){
  const pointers=(spot.step.vars||[]).filter(v=>v.kind==='p');
  const prevPointers=new Map(((spot.previous&&spot.previous.vars)||[]).filter(v=>v.kind==='p').map(v=>[v.name,v.value]));
  return {compact,pointers,prevPointers};
}
/** Wheel zoom and pointer pan. Both views call this — the canvas used to render
 *  the graph without ever attaching it, which is why dragging did nothing. */
function bindGraphNav(host){
  if(!host)return;
  const wrap=host.querySelector('.ts-graphwrap');
  if(!wrap)return;
  applyGraphView();
  let drag=null;
  wrap.addEventListener('wheel',event=>{
    event.preventDefault();
    const view=current.trace.view;
    view.zoom=Math.min(2.5,Math.max(.15,view.zoom*(event.deltaY<0?1.12:.89)));
    applyGraphView();
  },{passive:false});
  wrap.addEventListener('pointerdown',event=>{
    if(event.target.closest('button'))return;
    drag={x:event.clientX,y:event.clientY,ox:current.trace.view.x,oy:current.trace.view.y};
    try{ wrap.setPointerCapture(event.pointerId); }catch{}
    wrap.style.cursor='grabbing';
  });
  wrap.addEventListener('pointermove',event=>{
    if(!drag)return;
    event.preventDefault();
    const view=current.trace.view;
    view.x=drag.ox+(event.clientX-drag.x);view.y=drag.oy+(event.clientY-drag.y);
    applyGraphView();
  });
  const stop=()=>{drag=null;wrap.style.cursor='';};
  wrap.addEventListener('pointerup',stop);
  wrap.addEventListener('pointercancel',stop);
}
/** Scale the graph so the whole structure is visible the moment the canvas opens. */
function fitGraph(){
  const wrap=$('.ts-graphwrap'),g=$('.ts-graph'),view=current?.trace?.view;
  if(!wrap||!g||!view)return;
  const w=g.offsetWidth,h=g.offsetHeight;
  const availW=Math.max(160,wrap.clientWidth-70);
  const availH=Math.max(160,wrap.clientHeight-30||(window.innerHeight||800)-220);
  if(!w||!h)return false;
  view.zoom=Math.max(.15,Math.min(1,Math.min(availW/w,availH/h)));
  view.x=0;view.y=0;
  applyGraphView();
  return true;
}
/**
 * Data canvas, drawn by Cytoscape with the KLay layout.
 *
 * KLay routes edges around nodes instead of straight through them, and Cytoscape
 * brings pan, zoom and fit for free — the hand-written SVG layout and navigation
 * this replaces could do neither.
 */
let cyView=null,cyHost=null;
const CY_STYLE=[
  {selector:'node',style:{'background-color':'#fff','border-width':1,'border-color':'#d9dee6',
    'shape':'round-rectangle','width':142,'height':62,'label':'data(label)','font-size':11,
    'font-family':'Consolas, "Cascadia Code", monospace','color':'#3f3f46','text-wrap':'wrap',
    'text-max-width':130,'text-valign':'center','text-halign':'center','padding':6}},
  {selector:'node[kind="ptr"]',style:{'background-color':'#eef6ff','border-color':'#b9dcff','color':'#1686ef',
    'width':96,'height':30,'font-size':12,'font-weight':'bold'}},
  // Plain values live in the graph too, so the picture is the whole memory state
  // and not just the heap.
  {selector:'node[kind="var"]',style:{'background-color':'#f5f6f8','border-color':'#e2e2e4','color':'#3f3f46',
    'width':104,'height':30,'font-size':12}},
  {selector:'node[kind="ptr"][moved="1"]',style:{'background-color':'#fff4e0','border-color':'#f0d29b','color':'#9c7625'}},
  // After "moved", so the state is what the box says last: a pointer the program never
  // gave a value to, or one whose memory was handed back, is the whole point of the step.
  {selector:'node[kind="ptr"][state="wild"]',style:{'background-color':'#fff8ec','border-color':'#f0dcae','color':'#8a6a1f','height':44}},
  {selector:'node[kind="ptr"][state="freed"]',style:{'background-color':'#fdf0ee','border-color':'#f0cdc6','color':'#a4503c','height':44}},
  {selector:'edge',style:{'width':1.6,'line-color':'#1686ef','target-arrow-color':'#1686ef',
    'target-arrow-shape':'triangle','curve-style':'bezier','arrow-scale':.85,'font-size':10,
    'font-family':'Consolas, monospace','color':'#9aa0a6','text-background-color':'#fff','text-background-opacity':.85,'text-background-padding':2}},
  {selector:'edge[kind="ptr"]',style:{'line-color':'#7fb3e8','target-arrow-color':'#7fb3e8','line-style':'solid'}},
  {selector:'edge[kind="read"]',style:{'line-color':'#e0a94a','target-arrow-color':'#e0a94a','width':2}},
  {selector:'.fresh',style:{'opacity':.05}}
];
// Cell metrics for the hand-placed chain layout. They mirror the node sizes in
// CY_STYLE above, which is why they live next to it.
const CY_W=142,CY_H=62,CY_GX=56,CY_GY=80,CY_CHIP=112;
// A ring only reads as a ring while it fits the canvas. Past about a dozen boxes the
// circle has to shrink so far that fit() renders the text illegible, so bigger loops
// keep the serpentine: readable text, one long closing edge.
const CY_RING_MAX=12;
/** `%p` prints a null pointer as `0x0` or `(nil)` depending on the libc. */
const nullPtr=value=>!value||/^(?:\(nil\)|nil|0|0x0+)$/i.test(String(value));
/**
 * True when the structure is one closed loop and nothing else.
 *
 * A circular list gives every node exactly one outgoing link, so it passes the chain
 * test while actually being a cycle. As a serpentine its closing arrow has to sweep
 * back across the whole canvas, and KLay ranks it into a straight line with the same
 * long edge - so a plain ring is the one shape that actually reads as a loop. Every
 * node has to be on the loop: a structure that also branches keeps KLay, which is
 * what draws branching well.
 */
function cyRing(structs){
  const n=structs.length;
  if(n<2)return false;
  const link=new Map();
  for(const node of structs){
    const ps=node.fields.filter(f=>f.kind==='p');
    if(ps.length!==1)return false;
    link.set(node.addr,ps[0].value);
  }
  let cur=structs[0].addr;
  for(let i=0;i<n;i++){
    if(!link.has(cur))return false;
    cur=link.get(cur);
  }
  return cur===structs[0].addr;
}
/**
 * True when one link per node walks the whole structure in a line.
 *
 * A doubly linked list has two pointer fields per node, so the "at most one link"
 * test failed and it was handed to KLay - which, with an edge in both directions,
 * folds the list back on itself. Following just the first live link instead finds
 * the forward chain, and the back links become short arrows between neighbours.
 */
function cyChainOrder(structs){
  const byAddr=new Set(structs.map(n=>n.addr));
  const at=new Map(structs.map(n=>[n.addr,n]));
  const link=new Map();
  for(const n of structs){
    const f=n.fields.find(f=>f.kind==='p'&&byAddr.has(f.value));
    if(f)link.set(n.addr,f.value);
  }
  const walkFrom=start=>{
    const seq=[],taken=new Set();
    let cur=start;
    while(cur&&byAddr.has(cur)&&!taken.has(cur)){taken.add(cur);seq.push(at.get(cur));cur=link.get(cur);}
    return seq;
  };
  let best=[];
  for(const n of structs){const seq=walkFrom(n.addr);if(seq.length>best.length)best=seq;}
  const seen=new Set(best.map(n=>n.addr));
  return {order:best.concat(structs.filter(n=>!seen.has(n.addr))),covered:best.length};
}
function cyChain(structs){return structs.length>0&&cyChainOrder(structs).covered===structs.length;}
function cyElements(spot){
  const live=new Set(spot.step.nodes.map(n=>n.addr));
  const nodes=[],edges=[];
  for(const n of spot.step.nodes){
    const lines=[n.type+'  '+String(n.addr).slice(-5)];
    for(const f of n.fields){
      if(f.kind==='p'){ lines.push(f.name+' -> '+(live.has(f.value)?String(f.value).slice(-5):(nullPtr(f.value)?'NULL':'?'))); }
      else lines.push(f.name+' = '+f.value);
    }
    nodes.push({data:{id:'n:'+n.addr,kind:'node',label:lines.join('\n')}});
    for(const f of n.fields){
      if(f.kind!=='p'||!live.has(f.value))continue;
      edges.push({data:{id:'e:'+n.addr+':'+f.name,source:'n:'+n.addr,target:'n:'+f.value,label:f.name}});
    }
  }
  const prev=new Map(((spot.previous&&spot.previous.vars)||[]).map(v=>[v.name,v.value]));
  for(const v of (spot.step.vars||[])){
    if(v.kind!=='p'){
      // Array elements stay out for now; they would flood the graph cell by cell.
      if(v.name.indexOf('[')<0)nodes.push({data:{id:'v:'+v.name,kind:'var',label:v.name+' = '+v.value}});
      continue;
    }
    const id='p:'+v.name;
    const flag=v.wild?'未初始化':v.freed?'已释放':'';
    nodes.push({data:{id,kind:'ptr',label:flag?v.name+'\n'+flag:v.name,state:v.wild?'wild':v.freed?'freed':'',moved:prev.get(v.name)!==v.value?'1':'0'}});
    if(live.has(v.value))edges.push({data:{id:'e:'+id,source:id,target:'n:'+v.value,kind:'ptr'}});
  }
  return [...nodes,...edges];
}
/**
 * Places a wrapped chain as a serpentine grid and pins every pointer to its target.
 *
 * Cytoscape's grid layout fills left-to-right and never doubles back, so a chain
 * longer than one row drew a full-width diagonal from the end of each row back to
 * the start of the next. Placing the nodes by hand lets each row run the opposite
 * way to the one above it, so the chain hands over straight down instead.
 *
 * Pointer variables are stacked just above the node they name. Parked after the
 * list they aimed quarter-screen-long arrows at the far corner, which was most of
 * what made a long list unreadable. Anything not attached to the structure - plain
 * values, and pointers holding NULL or a foreign address - lines up in one rail
 * under the structure.
 *
 * A closed loop gets laid out as a ring instead, with its pointers just outside it.
 */
function cyArrange(els,spot,cols,shape){
  if(!shape)return {elements:els,positions:null};
  const nodes=els.filter(e=>!e.data.source),edges=els.filter(e=>e.data.source);
  const target=new Map();
  for(const e of edges)if(e.data.kind==='ptr')target.set(e.data.source,e.data.target);
  const positions=new Map(),at=new Map(),angle=new Map(),lane=new Map(),rail=[];
  const structs=spot.step.nodes;
  let railY;
  if(shape==='ring'){
    const n=structs.length,step=2*Math.PI/n;
    // The tightest pair sits at the top of the ring, where only the vertical radius
    // separates the two boxes, so that gap is what sets the size.
    const ry=Math.max(210,205/(2*Math.sin(Math.PI/n))),rx=ry*1.55;
    for(let i=0;i<n;i++){
      const a=i*step,p={x:rx*Math.sin(a),y:-ry*Math.cos(a)};
      at.set('n:'+structs[i].addr,p);angle.set('n:'+structs[i].addr,a);
      positions.set('n:'+structs[i].addr,p);
    }
    for(const e of nodes){
      const id=e.data.id;
      if(id.slice(0,2)==='n:')continue;
      const t=target.get(id);
      if(t&&angle.has(t)){if(!lane.has(t))lane.set(t,[]);lane.get(t).push(id);}
      else rail.push(id);
    }
    for(const [t,ids] of lane){
      const a0=angle.get(t),ring={x:rx*1.33,y:ry*1.33};
      ids.forEach((id,k)=>{
        // Just outside its own node, so several pointers to one box fan apart instead
        // of stacking on top of each other.
        const a=a0+(k-(ids.length-1)/2)*.24;
        positions.set(id,{x:ring.x*Math.sin(a),y:-ring.y*Math.cos(a)});
      });
    }
    railY=ry+120;
  }else{
    // Chain order, not walker order - see cyChainOrder.
    const seq=cyChainOrder(structs).order;
    for(let i=0;i<seq.length;i++){
      const r=Math.floor(i/cols),c=i%cols;
      const vc=(r%2)?(cols-1-c):c;
      const p={x:vc*(CY_W+CY_GX),y:r*(CY_H+CY_GY)};
      at.set('n:'+seq[i].addr,p);
      positions.set('n:'+seq[i].addr,p);
    }
    const rows=Math.max(1,Math.ceil(structs.length/cols));
    railY=(rows-1)*(CY_H+CY_GY)+CY_H/2+92;
    for(const e of nodes){
      const id=e.data.id;
      if(id.slice(0,2)==='n:')continue;
      const t=target.get(id);
      if(t&&at.has(t)){
        if(!lane.has(t))lane.set(t,[]);
        lane.get(t).push(id);
      }else{
        rail.push(id);
      }
    }
    // Chips share one lane above the row and spread sideways when several name the same
    // node, so no chip ever covers the box it points at and its arrow stays visible.
    for(const [t,ids] of lane){
      const p=at.get(t);
      ids.forEach((id,k)=>positions.set(id,{x:p.x+(k-(ids.length-1)/2)*(CY_CHIP+10),y:p.y-CY_H/2-48}));
    }
  }
  rail.forEach((id,k)=>positions.set(id,{x:k*(CY_CHIP+18),y:railY}));
  return {elements:els,positions};
}
function renderCy(host,spot){
  const box=host.querySelector('.cy-host');
  if(!box)return;
  if(cyView&&cyHost!==box){try{cyView.destroy();}catch{}cyView=null;}
  if(!cyView){
    cyView=cytoscape({container:box,elements:[],style:CY_STYLE,boxSelectionEnabled:false,
      wheelSensitivity:.3,
      // fit() would otherwise blow two lone variables up to fill the whole canvas.
      minZoom:.25,maxZoom:1.25,
      layout:{name:'klay',klay:{direction:'RIGHT',spacing:34},animate:false}});
    cyHost=box;
  }
  const before=new Set(cyView.elements().map(e=>e.id()));
  // KLay ranks a chain one node per column, which for 41 nodes is thousands of
  // pixels wide and forces fit() to shrink the text into nothing. A chain is placed
  // by hand as a serpentine shaped like the viewport instead; KLay keeps the job for
  // structures that actually branch or loop.
  const count=spot.step.nodes.length;
  const ring=spot.step.nodes.length<=CY_RING_MAX&&cyRing(spot.step.nodes);
  const chain=!ring&&cyChain(spot.step.nodes);
  const rect=box.getBoundingClientRect();
  const aspect=(rect.width||1200)/Math.max(240,rect.height||700);
  // Pick the column count whose overall shape is closest to the viewport's. The closed
  // form this replaces rounded to the wrong side on a wide canvas with few nodes,
  // which turned a five-node list into a tall narrow snake.
  let cols=1,bestShape=Infinity;
  for(let c=1;c<=16&&c<=Math.max(1,count);c++){
    const rows=Math.ceil(count/c);
    const score=Math.abs(Math.log((c*(CY_W+CY_GX))/(rows*(CY_H+CY_GY))/aspect));
    if(score<bestShape){bestShape=score;cols=c;}
  }
  const laid=cyArrange(cyElements(spot),spot,cols,ring?'ring':(chain?'grid':null));
  cyView.json({elements:laid.elements});
  if(laid.positions){
    cyView.nodes().forEach(n=>{const p=laid.positions.get(n.id());if(p)n.position(p);});
    cyView.layout({name:'preset',fit:false,animate:false}).run();
  }else{
    try{
      cyView.layout({name:'klay',klay:{direction:'RIGHT',spacing:34,edgeRouting:'ORTHOGONAL'},animate:false}).run();
    }catch{
      cyView.layout({name:'grid',cols,avoidOverlap:true,padding:26,animate:false}).run();
    }
  }
  cyView.fit(undefined,44);
  cyView.elements().filter(e=>!before.has(e.id())).forEach(e=>{
    e.addClass('fresh');
    e.animate({style:{opacity:1}},{duration:320,easing:'ease-out-cubic',complete:()=>e.removeClass('fresh')});
  });
}
function graphScreenHTML(){
  const trace=current.trace,spot=traceSpot();
  if(!spot)return '';
  const prev=graphKeys(spot.previous&&spot.previous.nodes);
  return '<header class="ts-head"><span class="ts-dot"></span><span class="ts-title">数据画板</span>'+
    '<span class="ts-step">'+esc(traceLabel())+' · '+spot.step.nodes.length+' 个节点</span><span class="grow"></span>'+
    '<button data-action="trace-play" class="ts-btn">'+(trace.playing?'暂停':'播放')+'</button>'+
    '<button data-action="trace-prev" class="ts-btn">上一步</button>'+
    '<button data-action="trace-next" class="ts-btn">下一步</button>'+
    '<button data-action="graph-close" class="ts-btn">退出</button></header>'+
    '<div class="cy-host"></div>'+
    '<p class="cy-empty'+(spot.step.nodes.length||(spot.step.vars||[]).length?' hidden':'')+'">这一步还没有可以画进内存图的数据。</p>';
}
function renderGraphScreen(){
  const host=$('[data-graph-screen]');
  if(!host)return;
  host.innerHTML='<section class="gcanvas">'+graphScreenHTML()+'</section>';
  const spot=traceSpot();
  if(spot)renderCy(host,spot);
}
function openGraphScreen(){
  const trace=current?.trace,spot=traceStop?traceSpot():null;
  if(!trace||!spot||(!spot.step.nodes.length&&!(spot.step.vars||[]).length)){toast('这一步还没有可以查看的数据。');return;}
  trace.canvas=true;
  let host=$('[data-graph-screen]');
  if(!host){host=document.createElement('div');host.className='graph-screen';host.setAttribute('data-graph-screen','');root.append(host);}
  host.tabIndex=0;
  host.onkeydown=event=>{
    const t=current?.trace;if(!t)return;
    if(event.key==='Escape'){event.preventDefault();closeGraphScreen();}
    else if(event.key==='ArrowRight'){event.preventDefault();traceGoto((t.cursor||0)+1);}
    else if(event.key==='ArrowLeft'){event.preventDefault();traceGoto((t.cursor||0)-1);}
    else if(event.key===' '){event.preventDefault();tracePlay();}
  };
  renderGraphScreen();
  motion(host,{opacity:[0,1],duration:220});
  // Cytoscape owns pan, zoom and fit on the canvas, so none of the hand-written
  // navigation is needed here.
  requestAnimationFrame(()=>{ if(cyView){try{cyView.resize();cyView.fit(undefined,44);}catch{}} });
  window.addEventListener('resize',()=>{ if($('[data-graph-screen]'))fitGraph(); },{once:true});
  setTimeout(()=>host.focus(),30);
}
function closeGraphScreen(){
  if(current?.trace)current.trace.canvas=false;
  const host=$('[data-graph-screen]');
  if(host){stopWithin(host);host.remove();}
  renderTrace();
}
function graphHTML(nodes,prev,options){
  const compact=!!(options&&options.compact);
  if(compact)nodes=nodes.slice(0,8);
  const W=134,H=60,GX=58,GY=52;
  // Columns come from the available width, not a fixed count.
  const avail=Math.max(340,(window.innerWidth||1200)-96);
  const cols=compact?nodes.length:Math.max(1,Math.min(6,Math.floor((avail+GX)/(W+GX))));
  // Follow the links to recover the shape: a cycle is drawn as a ring, a chain as
  // a snake (so neighbours are always adjacent), anything branching as a grid.
  const byAddr=new Map(nodes.map(n=>[n.addr,n]));
  const next=new Map();
  for(const n of nodes){const l=n.fields.find(f=>f.kind==='p'&&byAddr.has(f.value));if(l)next.set(n.addr,l.value);}
  // Chain order, not the order the walker happened to emit the nodes in - see
  // cyChainOrder. Getting this wrong drew real links as backwards arrows.
  const order=cyChainOrder(nodes).order;
  const cyclic=order.length>2&&next.get(order[order.length-1].addr)===order[0].addr;
  if(compact)nodes=order;
  // The preview shows a slice of the graph, so a pointer aimed outside it would
  // look dangling. Chips only appear on the full canvas.
  const pointers=compact?[]:((options&&options.pointers)||[]);
  const prevPointers=(options&&options.prevPointers)||new Map();
  const CW=88,CH=26;
  const pos=new Map();
  let width,height;
  if(compact){
    order.forEach((n,i)=>pos.set(n.addr,{x:i*(W+GX)+2,y:0}));
    width=order.length*W+(order.length-1)*GX+4; height=H+4;
  }else{
    // dagre places everything: layered left-to-right for lists and trees, cycle
    // aware, and the pointer cards become nodes too so they settle next to the
    // object they point at instead of in a fixed row.
    const graph=new dagre.graphlib.Graph();
    graph.setGraph({rankdir:'LR',nodesep:28,ranksep:70,marginx:16,marginy:16});
    graph.setDefaultEdgeLabel(()=>({}));
    for(const n of order)graph.setNode('n:'+n.addr,{width:W,height:H});
    for(const n of order){
      const link=n.fields.find(f=>f.kind==='p'&&byAddr.has(f.value));
      if(link)graph.setEdge('n:'+n.addr,'n:'+link.value);
    }
    for(const v of pointers){
      if(!byAddr.has(v.value))continue;
      graph.setNode('p:'+v.name,{width:CW,height:CH});
      graph.setEdge('p:'+v.name,'n:'+v.value);
    }
    dagre.layout(graph);
    for(const n of order){const node=graph.node('n:'+n.addr);pos.set(n.addr,{x:node.x-W/2,y:node.y-H/2});}
    for(const v of pointers){const node=graph.node('p:'+v.name);if(node)pos.set('p:'+v.name,{x:node.x-CW/2,y:node.y-CH/2});}
    width=(graph.graph().width||400)+8; height=(graph.graph().height||200)+8;
    // A chain is not laid out by dagre: it is drawn as a snake, one row forwards
    // and the next backwards. Neighbours then always touch, and a row change is a
    // short vertical hop instead of a line across the whole diagram.
    const outDegree=new Map(order.map(n=>[n.addr,0]));
    for(const n of order){
      const link=n.fields.find(f=>f.kind==='p'&&byAddr.has(f.value));
      if(link)outDegree.set(n.addr,(outDegree.get(n.addr)||0)+1);
    }
    const isChain=order.length===nodes.length&&[...outDegree.values()].every(v=>v<=1);
    if(isChain){
      const targetW=Math.max(560,Math.min(1500,(window.innerWidth||1200)-260));
      const perRow=Math.max(2,Math.floor((targetW+GX)/(W+GX)));
      order.forEach((n,i)=>{
        const row=Math.floor(i/perRow),col=i%perRow;
        pos.set(n.addr,{x:(row%2?perRow-1-col:col)*(W+GX)+2,y:row*(H+GY)+44});
      });
      const seenAt=new Map();
      for(const v of pointers){
        const target=pos.get(v.value);
        if(!target)continue;
        const k=seenAt.get(v.value)||0;seenAt.set(v.value,k+1);
        pos.set('p:'+v.name,{x:Math.max(2,target.x+W-CW-k*26),y:Math.max(0,target.y-34)});
      }
      width=perRow*W+(perRow-1)*GX+4;
      height=Math.ceil(order.length/perRow)*(H+GY)+24;
    }
  }
  let chips='',chipsEdges='',lost=0;
  pointers.forEach(v=>{
    const moved=prevPointers.get(v.name)!==v.value;
    let at=pos.get('p:'+v.name);
    if(!at&&!byAddr.has(v.value)){at={x:8+(lost++)*96,y:height-30};}
    if(!at)return;
    chips+='<div class="ts-ptr'+(moved?' moved':'')+(v.wild?' wild':'')+(v.freed?' freed':'')+'" style="left:'+at.x+'px;top:'+at.y+'px;width:'+CW+'px;height:'+CH+'px">'+esc(v.name)+'</div>';
    const target=pos.get(v.value);
    if(target){
      const ax=at.x+CW/2,ay=at.y+CH/2,bx=target.x+W/2,by=target.y+H/2,dx=bx-ax,dy=by-ay;
      const cut=(hw,hh)=>Math.min(dx?hw/Math.abs(dx):1e9,dy?hh/Math.abs(dy):1e9);
      const t1=cut(CW/2+6,CH/2+6),t2=cut(W/2+11,H/2+11);
      chipsEdges+='<path class="ts-edge ptr'+(moved?' new':'')+'" marker-end="url(#ts-head)" d="M'+(ax+dx*t1).toFixed(1)+' '+(ay+dy*t1).toFixed(1)+' L'+(bx-dx*t2).toFixed(1)+' '+(by-dy*t2).toFixed(1)+'"/>';
    }
    else{
      // No node was captured at this address: either it is not part of what this step
      // shows, or the pointer is the reason - say which when the trace knows.
      const why=v.wild?'未初始化':v.freed?'已释放':'→ ?';
      chipsEdges+='<text class="ts-null'+(v.wild?' wild':'')+(v.freed?' freed':'')+'" x="'+(at.x+CW/2)+'" y="'+(at.y+CH+14)+'">'+esc(why)+'</text>';
    }
  });
  if(lost)height+=34;
  // Which directed links exist, so a pair pointing at each other can be told apart.
  const directed=new Set();
  for(const n of nodes)for(const f of n.fields)if(f.kind==='p')directed.add(n.addr+'|'+f.value);
  const drawnPair=new Map();
  let boxes='',edges='';
  for(const n of nodes){
    const p=pos.get(n.addr);
    boxes+='<div class="ts-node'+(prev.addrs.has(n.addr)?'':' new')+'" style="left:'+p.x+'px;top:'+p.y+'px;width:'+W+'px;height:'+H+'px">'+
      '<span class="ts-ntype">'+esc(n.type)+'</span><span class="ts-naddr">'+esc(String(n.addr).slice(-5))+'</span>'+
      n.fields.filter(f=>f.kind!=='p').map(f=>'<span class="ts-nf"><i>'+esc(f.name)+'</i><b>'+esc(f.value)+'</b></span>').join('')+
      '</div>';
    for(const f of n.fields.filter(x=>x.kind==='p')){
      const to=pos.get(f.value);
      const fresh=prev.edges.has(n.addr+'|'+f.name+'|'+f.value)?'':' new';
      const sx=p.x+W, sy=p.y+H/2;
      if(!to){ edges+='<path class="ts-edge dangling'+fresh+'" d="M'+sx+' '+sy+' h20"/>'; continue; }
      // Centre to centre, trimmed to each box border, so an arrow leaves the side
      // it is actually heading towards instead of always the right edge.
      const ax=p.x+W/2, ay=p.y+H/2, bx=to.x+W/2, by=to.y+H/2;
      const dx=bx-ax, dy=by-ay;
      // How far along the centre line the box border sits, per axis.
      const fit=pad=>Math.min(dx?(W/2+pad)/Math.abs(dx):1e9, dy?(H/2+pad)/Math.abs(dy):1e9);
      const start=fit(9), end=fit(13);
      if(start>=1||end>=1)continue;
      let fx=ax+dx*start, fy=ay+dy*start, ex=bx-dx*end, ey=by-dy*end;
      // Two nodes that point at each other - or one node with two links to the same
      // place - drew the identical centre-to-centre line twice, so the two heads met
      // in the middle and read as one broken double arrow. Fanning the duplicates
      // apart perpendicular to the line keeps both directions legible.
      const pair=n.addr+'|'+f.value;
      const dup=drawnPair.get(pair)||0;
      drawnPair.set(pair,dup+1);
      const apart=(directed.has(f.value+'|'+n.addr)?1:0)+dup;
      if(apart){
        const len=Math.hypot(dx,dy)||1,off=apart*8;
        const ox=-dy/len*off, oy=dx/len*off;
        fx+=ox;fy+=oy;ex+=ox;ey+=oy;
      }
      edges+='<path class="ts-edge'+fresh+'" marker-end="url(#ts-head)" d="M'+fx.toFixed(1)+' '+fy.toFixed(1)+' L'+ex.toFixed(1)+' '+ey.toFixed(1)+'"/>';
    }
  }
  return '<div class="ts-zoom"><button data-action="graph-out">−</button><span>100%</span><button data-action="graph-in">+</button><button data-action="graph-fit">适应</button><span class="ts-zoom-hint">滚轮缩放 · 拖动平移</span></div>'+
    '<div class="ts-graph" style="width:'+width+'px;height:'+(height+30)+'px">'+
    '<svg class="ts-edges" width="'+(width+60)+'" height="'+(height+40)+'" style="overflow:visible">'+
    '<defs><marker id="ts-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">'+
    '<path d="M0 0 L10 5 L0 10 z" fill="#1686ef"/></marker></defs>'+edges+chipsEdges+'</svg>'+boxes+chips+'</div>';
}
function traceOpenScreen(){
  const trace=current?.trace;
  if(!trace||trace.status!=='ready')return;
  trace.fullscreen=true;
  let host=$('[data-trace-screen]');
  if(!host){host=document.createElement('div');host.className='trace-screen';host.setAttribute('data-trace-screen','');root.append(host);}
  host.tabIndex=0;
  host.onkeydown=event=>{
    const t=current?.trace;if(!t)return;
    if(event.key===' '||event.key==='Spacebar'){event.preventDefault();tracePlay();}
    else if(event.key==='ArrowRight'){event.preventDefault();traceGoto((t.cursor||0)+1);}
    else if(event.key==='ArrowLeft'){event.preventDefault();traceGoto((t.cursor||0)-1);}
    else if(event.key==='Escape'){event.preventDefault();traceCloseScreen();}
  };
  motion(host,{opacity:[0,1],duration:220});
  setTimeout(()=>host.focus(),30);
  renderTrace();
}
function traceCloseScreen(){
  if(current?.trace)current.trace.fullscreen=false;
  const host=$('[data-trace-screen]');
  if(host){stopWithin(host);host.remove();}
  renderTrace();
}
function renderTraceScreen(){
  const host=$('[data-trace-screen]');
  if(!host)return;
  const spot=traceSpot();
  if(!spot)return traceCloseScreen();
  const trace=current.trace,changes=changedValues(spot.previous,spot.step);
  stopSkipReplay();
  if(!trace.view)trace.view={zoom:1,x:0,y:0};
  const changedSet=new Set(changes.map(c=>c.name)),grouped=groupVars(spot.step.vars);
  const changeOf=name=>changes.find(c=>c.name===name);
  host.innerHTML='<section class="tscreen">'+
      '<header class="ts-head">'+
        '<span class="ts-dot"></span><span class="ts-title">逐行执行</span>'+
        '<span class="ts-step">'+esc(traceLabel())+'</span>'+
        (trace.skip&&trace.skip.length?'<span class="ts-skip-note">'+esc(skipBadge(trace.skip))+'</span>':'')+
        '<span class="grow"></span>'+
        '<button data-action="trace-mode" class="ts-btn mode">'+(trace.mode==='skip'?'跳行模式':'全部步骤')+'</button>'+
        '<button data-action="trace-play" class="ts-btn">'+(trace.playing?'暂停':'播放')+'</button>'+
        '<button data-action="trace-prev" class="ts-btn">上一步</button>'+
        '<button data-action="trace-next" class="ts-btn">下一步</button>'+
        '<button data-action="trace-close" class="ts-btn">退出全屏</button>'+
      '</header>'+
      '<div class="ts-stack">'+stackHTML(spot.step.stack,spot.step.returns)+'</div>'+
      // Plain values are drawn on the canvas too, so a step with no heap yet is still
      // worth opening - otherwise the feature looks broken on a simple program.
      (spot.step.nodes.length||(spot.step.vars||[]).length?'<div class="ts-preview">'+
        (spot.step.nodes.length?'<div class="ts-graphwrap preview">'+graphHTML(spot.step.nodes,graphKeys(spot.previous&&spot.previous.nodes),graphOptions(spot,true))+'</div>':'')+
        '<div class="ts-preview-bar">'+(spot.step.nodes.length
          ?'<span class="ts-preview-note">预览，只显示前 '+Math.min(8,spot.step.nodes.length)+' 个节点</span>'
          :'<span class="ts-preview-note">这一步只有普通变量</span>')+
        '<button class="ts-canvas-open" data-action="graph-full">打开数据画板 · 共 '+(spot.step.nodes.length?spot.step.nodes.length+' 个节点':(spot.step.vars||[]).length+' 个变量')+'</button></div></div>':'')+
      '<div class="ts-body">'+
        '<div class="ts-code">'+traceCodeHTML(spot.step.line,4)+'</div>'+
        '<div class="ts-side">'+
          '<div class="ts-label">变量</div>'+
          '<div class="ts-vars">'+(grouped.scalars.length
            ?grouped.scalars.map(v=>traceVarHTML(v,changeOf(v.name))).join('')
            :'<span class="trace-none">还没有可见的变量</span>')+'</div>'+
          (grouped.arrays.size?'<div class="ts-label">数组</div>'+[...grouped.arrays].map(([name,cells])=>arrayHTML(name,cells,spot.step.reads,changedSet)).join(''):'')+
          '<div class="ts-label">输出</div>'+
          '<pre class="ts-out">'+eolMark(spot.step.output||'（暂无输出）')+'</pre>'+
          '<div class="ts-label">最终输出</div>'+
          '<pre class="ts-out dim">'+eolMark(trace.finalOutput||'（没有输出）')+'</pre>'+
        '</div>'+
      '</div>'+
      '<footer class="ts-foot">'+
        '<input class="trace-range" type="range" min="1" max="'+spot.total+'" value="'+(spot.index+1)+'" data-trace-seek aria-label="执行进度">'+
        '<span class="ts-hint">空格 播放/暂停 · ← → 上一步/下一步 · 跳行模式会略过同一行上的重复执行</span>'+
      '</footer>'+
    '</section>';
  // Unchanged values stay perfectly still, so the eye only follows what moved: old value
  // lifts away while the new one rises in. When the jump crossed steps, the sweep below
  // owns this panel and plays that same transition once per crossed step, ending here.
  if(!(trace.skip&&trace.skip.length))playVarReel(host,1);
  const now=host.querySelector('.ts-line.now');
  if(now)motion(now,{opacity:[.35,1],translateX:[-10,0],duration:280,ease:'outCubic'});
  const frames=host.querySelectorAll('.ts-frame');
  if(frames.length)motion(frames,{opacity:[0,1],scale:[.86,1],duration:260,delay:stagger(45),ease:'outBack'});
  const cells=host.querySelectorAll('.ts-cell');
  if(cells.length)motion(cells,{opacity:[0,1],translateY:[5,0],duration:220,delay:stagger(24),ease:'outCubic'});
  const hot=host.querySelectorAll('.ts-cell.read, .ts-cell.changed');
  if(hot.length)motion(hot,{scale:[1.24,1],duration:460,delay:stagger(60),ease:'outBack'});
  const back=host.querySelector('.ts-return');
  if(back)motion(back,{opacity:[0,1],translateY:[8,0],duration:300,delay:180,ease:'outCubic'});
  // Only what appeared this step animates; edges that were already there keep
  // still instead of redrawing themselves on every single step.
  const freshNodes=host.querySelectorAll('.ts-node.new');
  if(freshNodes.length)motion(freshNodes,{opacity:[0,1],translateY:[10,0],duration:300,delay:stagger(55),ease:'outCubic'});
  host.querySelectorAll('.ts-edge.new').forEach(path=>{
    let len=0;
    try{ len=path.getTotalLength(); }catch{ return; }
    if(!len)return;
    path.style.strokeDasharray=len; path.style.strokeDashoffset=len;
    motion(path,{strokeDashoffset:[len,0],duration:460,delay:280,ease:'outCubic'});
  });
  replaySkippedVars(host,trace,spot.raw);
  bindGraphNav(host);
  const seek=host.querySelector('[data-trace-seek]');
  if(seek)seek.oninput=event=>{clearInterval(traceTimer);traceTimer=null;current.trace.playing=false;traceGoto(Number(event.target.value)-1);};
}
/* ------------------------------------------------------------- 跳过的那些步 --
 * 跳行模式一次可能跨过几十个原始步骤。与其直接瞬移，不如让「变量」面板按这些被跨过的
 * 步快速重播它自己的动画：旧值上浮、新值升起，一格一格地滚过去，读起来就是
 * 「这里循环又跑了 39 圈」。最后停在真正的目标步上。
 */
let skipReplayTimer=null;
/** "跳过 23 步" plus the line that repeated, which is the loop that ran. */
function skipBadge(skipped){
  const per=new Map();
  for(const {step} of skipped)per.set(step.line,(per.get(step.line)||0)+1);
  let line=0,count=0;
  for(const [l,c] of per)if(c>count){line=l;count=c;}
  return count>2?'跳过 '+skipped.length+' 步 · 第 '+line+' 行重复 '+count+' 次':'跳过 '+skipped.length+' 步';
}
/** The 变量 cards for one step, with the value reel ready to animate. */
function varsHTML(step,previous){
  const changes=changedValues(previous,step);
  const grouped=groupVars(step.vars);
  if(!grouped.scalars.length)return '<span class="trace-none">这一步还没有可见的变量</span>';
  return grouped.scalars.map(v=>traceVarHTML(v,changes.find(c=>c.name===v.name))).join('');
}
/** The reel animation, at the speed the caller asks for. */
function playVarReel(host,scale=1){
  host.querySelectorAll('.reel-old').forEach(old=>{
    motion(old,{translateY:[-15],opacity:[1,0],duration:190*scale,ease:'inCubic',onComplete:()=>old.remove()});
  });
  host.querySelectorAll('.reel-new').forEach(fresh=>{
    motion(fresh,{translateY:[15,0],opacity:[0,1],duration:240*scale,delay:80*scale,ease:'outCubic'});
  });
  const popped=host.querySelectorAll('.trace-var.changed');
  if(popped.length)motion(popped,{scale:[1.1,1],duration:420*scale,delay:stagger(40*scale),ease:'outBack'});
}
function stopSkipReplay(){clearInterval(skipReplayTimer);skipReplayTimer=null;}
/**
 * Sweep the 变量 panel through the steps the jump crossed.
 *
 * The destination is painted first, so the panel is never wrong if the sweep is cut short;
 * the replay then re-paints each crossed step in turn and lands back on that destination.
 * Long jumps are sampled rather than played frame by frame, so the sweep stays about a
 * second no matter how many iterations the loop actually ran.
 */
function replaySkippedVars(host,trace,targetRaw){
  const skipped=trace.skip;
  const box=host.querySelector('.ts-vars');
  if(!skipped||!skipped.length||!box)return;
  const destination=box.innerHTML;
  const frames=[];
  const stride=Math.max(1,Math.ceil(skipped.length/16));
  for(let i=0;i<skipped.length;i+=stride)frames.push(skipped[i]);
  const lastFrame=skipped[skipped.length-1];
  if(frames[frames.length-1]!==lastFrame)frames.push(lastFrame);
  const paint=entry=>{
    box.innerHTML=varsHTML(entry.step,trace.steps[entry.raw-1]);
    playVarReel(host,.34);
  };
  const gap=Math.max(38,Math.min(100,760/Math.max(1,frames.length)));
  let at=0;
  paint(frames[0]);at=1;
  stopSkipReplay();
  skipReplayTimer=setInterval(()=>{
    if(at>=frames.length){
      stopSkipReplay();
      box.innerHTML=destination;
      playVarReel(host,.34);
      return;
    }
    paint(frames[at++]);
  },gap);
}
function renderTrace(){
  const trace=current?.trace;
  // 画板打开时它才是主角，别在下面重复渲染一遍。
  if(trace?.canvas&&trace.status==='ready'&&$('[data-graph-screen]')){renderGraphScreen();return;}
  if(trace?.fullscreen&&trace.status==='ready'&&$('[data-trace-screen]'))return renderTraceScreen();
  const host=$('[data-bottom-body]');
  if(!host)return;
  if(!trace){replaceContent(host,'<div class="empty">'+icon('run')+'点「单步」把这段代码的执行过程演一遍。</div>');return;}
  if(trace.status==='loading'){replaceContent(host,loadingHTML(trace.message||'正在编译并记录执行过程','记录完成后可以逐步播放，也可以自动播放。'));animateLoading(host);return;}
  if(trace.status==='error'){replaceContent(host,'<div class="results"><div class="result-title red">无法记录执行过程<small></small></div>'+compileWarnStrip()+'<div class="result-detail"><pre>'+esc(trace.error)+'</pre></div></div>');return;}
  const spot=traceSpot();
  if(!spot)return;
  const step=spot.step;
  const compactChanges=changedValues(spot.previous,spot.step);
  // 数组元素单独成条，不然一个 4x4 的表格会摊成十六张平铺的小卡片。
  const compactVars=groupVars(step.vars);
  const compactChanged=new Set(compactChanges.map(c=>c.name));
  const pct=Math.round(((spot.index+1)/spot.total)*100);
  replaceContent(host,'<section class="trace">'+
    '<div class="trace-bar">'+
      button('trace-prev','上一步','prev')+
      button('trace-play',trace.playing?'暂停':'自动播放','run')+
      button('trace-next','下一步','next')+
      button('trace-stop','停止','close')+
      button('trace-mode',trace.mode==='skip'?'跳行模式':'全部步骤','list')+
      button('trace-screen','全屏','expand')+
      '<span class="trace-count">'+esc(traceLabel())+(trace.skip&&trace.skip.length?' · '+esc(skipBadge(trace.skip)):'')+'</span>'+
    '</div>'+
    '<div class="trace-progress"><span style="width:'+pct+'%"></span></div>'+
    compileWarnStrip()+
    '<div class="trace-vars">'+(compactVars.scalars.length
      ? compactVars.scalars.map(v=>traceVarHTML(v,compactChanges.find(c=>c.name===v.name))).join('')
      : (compactVars.arrays.size?'':'<span class="trace-none">这一步还没有可见的变量</span>'))+'</div>'+
    (compactVars.arrays.size?'<div class="trace-arrays">'+[...compactVars.arrays].map(([name,cells])=>arrayHTML(name,cells,step.reads,compactChanged)).join('')+'</div>':'')+
    '<div class="trace-body">'+
      '<label class="field"><span class="field-head">本步之前的输出</span><pre class="trace-out">'+eolMark(step.output||'（还没有输出）')+'</pre></label>'+
      '<label class="field"><span class="field-head">程序最终输出</span><pre class="trace-out">'+eolMark(trace.finalOutput||'（没有输出）')+'</pre></label>'+
    '</div>'+
    '<input class="trace-range" type="range" min="1" max="'+spot.total+'" value="'+(spot.index+1)+'" data-trace-seek aria-label="执行进度">'+
  '</section>');
  const seek=host.querySelector('[data-trace-seek]');
  if(seek)seek.oninput=event=>{clearInterval(traceTimer);traceTimer=null;current.trace.playing=false;traceGoto(Number(event.target.value)-1);};
}
async function startTrace(){
  if(busy)return;
  const {source,count,lineMap}=instrument(code());
  if(!count){toast('这段代码里没有识别到可以逐行执行的语句。');return;}
  const input=current.draft.tests[testIndex]?.input ?? current.draft.tests[0]?.input ?? '';
  traceStop();
  setBusy(true);
  const keep=current.trace||{};
  current.trace={status:'loading',message:'正在编译并记录执行过程',mode:keep.mode||'skip',speed:keep.speed??5,fullscreen:!!keep.fullscreen};
  renderTrace();
  try{
    const {module,warnings}=await compileC(source,message=>{current.trace={status:'loading',message};renderTrace();});
    // The traced copy carries the mapping back to the editor's own line numbers.
    current.compileIssues=parseCompileIssues(warnings,lineMap);syncDiagnosis();
    const {stdout}=await runCModule(module,input);
    const {steps,finalOutput}=parseTrace(stdout);
    if(!steps.length)throw new Error('没有记录到任何执行步骤，代码可能一进入就退出了。');
    if(steps.length>=20000)toast('执行步数过多，只记录了前 20000 步。');
    current.trace={status:'ready',steps,finalOutput,cursor:0,playing:false,mode:current.trace?.mode||'skip',speed:5,fullscreen:false};
    traceHighlight(steps[0].line);
  }catch(error){
    // No folder yet, or a permission that lapsed: ask, then run this again.
    if(handleToolchainError(error,()=>startTrace())){
      current.trace={status:'error',error:'需要先准备好内置编译器。按弹窗里的按钮完成，这段代码会自动重新记录一次。'};
      return;
    }
    // Two ways a runaway program is stopped: the sandbox deadline, and the
    // 20000-step ceiling baked into the instrumented source.
    current.trace={status:'error',error:error.timeout
      ? '代码执行超过 6 秒仍未结束，很可能陷入了死循环。已强制中断，工作区没有卡住。'
      : error.message};
    current.compileIssues=parseCompileIssues(error.message,lineMap);syncDiagnosis();
  }finally{setBusy(false);}
  renderTrace();
}
async function compileC(source,onProgress){
  const {compile}=await loadCompiler(onProgress);
  onProgress?.('正在编译…');
  try{ return await compileSource(compile,source); }
  catch(error){
    // A page that refuses to compile WebAssembly cannot run any in-browser C compiler.
    if(wasmRefused(error))throw new ToolchainError('wasm-blocked','这个页面用 Content-Security-Policy 禁止了本机编译 WebAssembly。');
    throw error;
  }
}
async function compileSource(compile,source){
  // -Wall, deliberately without -Werror: a warning must never stop code from running.
  // The judge's own dialect, so a program that fails there fails here the same way.
  const {module,compileOutput}=await compile({source,fileName:'main.c',flags:['-O0','-Wall',...dialectFlags()]});
  if(!module)throw new Error((compileOutput||'编译失败').trim().slice(0,4000));
  // Warnings used to be thrown away the moment a module came back, which is exactly how
  // a missing "&" in scanf stayed invisible: it compiles clean and only warns.
  return {module,warnings:compileOutput||''};
}
/**
 * Execution sandbox.
 *
 * wasi.start() runs the compiled module synchronously, so an infinite loop in
 * submitted code would block whatever thread it runs on. Running it on the page's
 * main thread froze the whole workspace with no way to cancel — so the module is
 * handed to a worker that can be terminated the moment a run overruns its deadline.
 */
const RUN_TIMEOUT_MS=6000;
let cSandbox=null;
function openSandbox(){
  const url=URL.createObjectURL(new Blob([SANDBOX_SOURCE],{type:'text/javascript'}));
  // A module worker is refused on this page: creating one throws
  // "Module scripts don't support importScripts()" before any of our code runs,
  // even with an empty body. A classic worker supports dynamic import() and works.
  const worker=new Worker(url);
  const pending=new Map();let seq=0;
  const failAll=message=>{
    for(const [id,entry] of pending){pending.delete(id);clearTimeout(entry.timer);entry.reject(new Error(message));}
  };
  worker.onmessage=event=>{
    const data=event.data||{},entry=pending.get(data.id);
    if(!entry)return;
    pending.delete(data.id);clearTimeout(entry.timer);entry.resolve(data);
  };
  worker.onerror=event=>failAll(event.message||'执行沙箱启动失败');
  worker.onmessageerror=()=>failAll('执行沙箱通信失败');
  return{
    call(payload,timeout){
      const id=++seq;
      return new Promise((resolve,reject)=>{
        const timer=timeout?setTimeout(()=>{
          pending.delete(id);
          const error=new Error('运行超时');error.timeout=true;reject(error);
        },timeout):null;
        pending.set(id,{resolve,reject,timer});
        worker.postMessage({...payload,id});
      });
    },
    close(){try{worker.terminate();}catch{}URL.revokeObjectURL(url);}
  };
}
let mainThreadOnly=false;
/**
 * Run the compiled module on the page's own thread.
 *
 * A Content-Security-Policy that allows https: but not blob: also blocks the worker,
 * which is created from a blob, so the sandbox cannot start at all. The instrumented
 * trace still bounds itself with its step ceiling; an ordinary run of a runaway
 * program will freeze the page, which is why this is the fallback and not the plan.
 */
async function runOnMainThread(module,stdin){
  const toolchain=await loadCompiler();
  const [wasiModule,fsModule]=await Promise.all([import(toolchain.wasiURL),import(toolchain.fsURL)]);
  const WASI=wasiModule.WASI||wasiModule.default;
  const {OpenFile,File,ConsoleStdout}=fsModule;
  const decode=new TextDecoder();
  let out='',err='';
  const fds=[
    new OpenFile(new File(new TextEncoder().encode(stdin||'')),'stdin'),
    new ConsoleStdout(buffer=>{out+=typeof buffer==='string'?buffer:decode.decode(buffer);}),
    new ConsoleStdout(buffer=>{err+=typeof buffer==='string'?buffer:decode.decode(buffer);})
  ];
  const wasi=new WASI(['main'],{},fds,[]);
  try{
    const instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});
    wasi.start(instance.instance||instance);
  }catch(error){
    if(!/WASIProcExit/.test(String(error)))throw error;
  }
  return{stdout:out,stderr:err};
}
async function ensureSandbox(){
  if(mainThreadOnly)return null;
  if(cSandbox)return cSandbox;
  const toolchain=await loadCompiler();
  const sandbox=openSandbox();
  try{
    const reply=await sandbox.call({type:'init',wasi:toolchain.wasiURL,fs:toolchain.fsURL},45000);
    if(reply.type!=='ready')throw new Error(reply.message||('沙箱返回了 '+reply.type));
  }
  catch(error){
    sandbox.close();
    // A worker from a blob URL is the first thing a strict Content-Security-Policy
    // takes away. Rather than fail the run, move to the page's own thread and say so.
    mainThreadOnly=true;
    toast('这个页面不允许后台线程，已改在当前页面运行；代码如果死循环，页面会卡住。');
    return null;
  }
  cSandbox=sandbox;
  return cSandbox;
}
async function runCModule(module,stdin){
  const sandbox=await ensureSandbox();
  if(!sandbox)return runOnMainThread(module,stdin);
  let reply;
  try{reply=await sandbox.call({type:'run',module,stdin},RUN_TIMEOUT_MS);}
  catch(error){
    if(error.timeout){
      // A synchronous loop cannot be interrupted from inside the page, so the
      // whole worker is thrown away; the next run starts a fresh one.
      cSandbox.close();cSandbox=null;
      throw error;
    }
    throw error;
  }
  if(reply.type!=='done')throw new Error(reply.message||'执行沙箱返回了异常结果');
  return{stdout:reply.stdout,stderr:reply.stderr};
}
// ---- Built-in C toolchain: the folder the user picks, and the dialogs around it ----
/**
 * Ask for the folder, or for permission to keep using the one already chosen.
 *
 * Both calls need a real click, so this runs from the button in the dialog rather
 * than from the `运行` that noticed the problem.
 */
function toolchainDialog(code,retry){
  const pick=canPick(),hidden=hiddenMode();
  const copy={
    absent:{title:'需要内置 C 编译器',lead:'在线调试要用本机编译代码。编译器（'+TOOLCHAIN_SIZE+'）只下载一次，之后一直用这些文件。',
      detail:pick?'推荐选一个文件夹存下来，文件你能直接看到、也能自己删；不想授权的话，也可以放进浏览器自己的存储里。':'这个页面不能选文件夹（需要 https），编译器会直接放进浏览器自己的存储里，同样只需要一次。',
      action:pick?'选择文件夹并下载':'下载到浏览器存储',alt:pick?'存到浏览器里':null},
    'needs-permission':{title:'重新允许访问编译器文件夹',lead:'上次的授权已经过期，浏览器要求再确认一次才能读那些文件。',detail:'点下面的按钮，然后在浏览器的提示里选择「允许」。',action:'允许访问'},
    denied:{title:'编译器文件夹被拒绝访问',lead:'浏览器记下了「拒绝」，需要你重新指定一个文件夹。',detail:'',action:'重新选择文件夹'},
    incomplete:{title:'编译器文件不完整',lead:'文件夹里缺少必要文件，可能是上次下载中途断了。',detail:'重新下载会覆盖这些文件。',action:'重新下载'},
    'picker-failed':{title:'打不开文件夹选择器',lead:'浏览器拒绝了这次文件夹选择。',detail:'可以改用浏览器自己的存储，不需要授权。',action:'再试一次',alt:'存到浏览器里'},
    'wasm-blocked':{title:'这个页面禁止本机编译',lead:'页面的安全策略里少了 wasm-unsafe-eval，任何跑在浏览器里的 C 编译器都会被挡下来。',detail:'这不是配置问题，只能换运行方式：代码会发到公网编译器上运行，不需要下载。',action:'改用在线编译器',alt:'知道了'},
    unsupported:{title:'这个浏览器装不了内置编译器',lead:'它既不支持文件夹访问，也没有可用的浏览器存储。',detail:'可以改用在线编译器：代码会发到公网编译器上运行，不需要下载。',action:'改用在线编译器',alt:'知道了'},
  }[code]||{title:'内置编译器不可用',lead:'',detail:'',action:'重试'};
  const m=openModal(`<header><h2>${esc(copy.title)}</h2></header>
    <div class="dl-body"><p><strong>${esc(copy.lead)}</strong></p>${copy.detail?'<p>'+esc(copy.detail)+'</p>':''}</div>
    <footer><button data-dl-cancel>${esc(copy.action==='改用在线编译器'?'改用在线编译器':'取消')}</button>${copy.alt&&copy.alt!=='知道了'?'<button data-dl-opfs>'+esc(copy.alt)+'</button>':''}${copy.action==='改用在线编译器'?'':'<button data-dl-start class="primary">'+esc(copy.action)+'</button>'}</footer>`);
  m.querySelector('[data-dl-cancel]').onclick=()=>{
    closeModal();
    // "改用在线编译器" is a choice the run should remember, not a dismissal.
    if(code==='unsupported'||code==='wasm-blocked'){persist(ONLINE_ONLY,true);toast('已改用在线编译器。');retry&&retry();}
  };
  // Nothing to download here: the only useful button is the one that switches backend.
  if(code==='unsupported'||code==='wasm-blocked')return;
  const start=async(mode)=>{
    m.querySelector('.dl-body').innerHTML=ringHTML(0)+'<p class="dl-note">正在准备编译器，请保持页面打开…</p>';
    m.querySelector('footer').innerHTML='';
    const paint=(fraction,message)=>{
      const fg=m.querySelector('.ring-fg'),label=m.querySelector('.dl-ring span');
      if(fg)fg.setAttribute('stroke-dashoffset',(2*Math.PI*26*(1-fraction)).toFixed(1));
      if(label)label.textContent=Math.round(fraction*100)+'%';
      const note=m.querySelector('.dl-note');
      if(note&&message)note.textContent=message;
    };
    try{
      if(code==='needs-permission'||code==='denied')await grantToolchain();
      else await installToolchain(paint,mode);
      closeModal();
      toast(mode==='opfs'?'编译器已放进浏览器存储。':'编译器已就绪。');
      retry&&retry();
    }catch(error){
      if(error&&error.code==='cancelled'){closeModal();return;}
      m.querySelector('.dl-body').innerHTML='<p><strong>没有成功</strong></p><p>'+esc(String(error&&error.message||error))+'</p>';
      m.querySelector('footer').innerHTML='<button data-dl-cancel>关闭</button><button data-dl-opfs>存到浏览器里</button><button data-dl-start class="primary">重试</button>';
      m.querySelector('[data-dl-cancel]').onclick=()=>closeModal();
      m.querySelector('[data-dl-opfs]').onclick=()=>start(hidden);
      m.querySelector('[data-dl-start]').onclick=()=>start(mode||hidden);
    }
  };
  m.querySelector('[data-dl-start]').onclick=()=>start(null);
  const hiddenButton=m.querySelector('[data-dl-opfs]');
  if(hiddenButton)hiddenButton.onclick=()=>start(hidden);
}
function ringHTML(percent){
  const r=26,c=2*Math.PI*r;
  return `<div class="dl-ring"><svg viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="${r}"/><circle class="ring-fg" cx="32" cy="32" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c*(1-percent)).toFixed(1)}"/></svg><span>${Math.round(percent*100)}%</span></div>`;
}
/**
 * Turn a ToolchainError into the dialog that fixes it.
 *
 * The run is retried after the problem is solved, so the learner gets the thing they
 * asked for instead of having to press the button twice.
 */
function handleToolchainError(error,retry){
  if(!error||!(error instanceof ToolchainError))return false;
  if(error.code==='unsupported'){toolchainDialog('unsupported',retry);return true;}
  toolchainDialog(error.code,retry);
  return true;
}
/** A folder is already set up: offer nothing, and never block a run on a dialog. */
async function maybeOfferToolchain(){
  const status=await toolchainStatus();
  if(status==='ready'||status==='unsupported')return;
}
async function runTests() {
  if(busy)return;
  setBusy(true);saveDraft();current.compileIssues=[];syncDiagnosis();
  try {
    const tests=structuredClone(current.draft.tests),submittedSource=code();
    current.result={rows:[],total:0,passed:0,pending:true,message:prefs.runner?'正在运行自定义测试…':'正在用在线编译器运行…'};switchBottom('results');
    let results;
    // Declared out here because the warnings are shown next to the results, not here.
    let compileWarnings='';
    if(prefs.runner){
      const response=await fetch(prefs.runner,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:submittedSource,language:$('[data-language]').selectedOptions[0].textContent,tests}),signal:AbortSignal.timeout(45000)});
      if(!response.ok)throw new Error(`执行 API 返回 ${response.status}`);
      const data=await response.json();
      if(!Array.isArray(data.results)||data.results.length!==tests.length)throw new Error('执行 API 结果数与用例数不一致');
      results=data.results;
    }else{
      // Local WASM compiler first; fall back to the online playground if it cannot load.
      const onProgress=message=>{current.result={rows:[],total:0,pending:true,message};switchBottom('results');};
      let module=null;
      // 在线编译器模式：用户明确选过它，就不再打扰。
      if(!read(ONLINE_ONLY,false)){
        try{ ({module,warnings:compileWarnings}=await compileC(submittedSource,onProgress)); }
        catch(error){
          // "main.c:3:5: error: ..." is the user's code failing to compile, not a
          // missing toolchain, so it must reach the compiler-diagnostics panel.
          if(/[^\s:][^:]*:\d+:(?:\d+:)?\s*(?:fatal error|error|warning):/.test(error.message))throw error;
          // No folder yet, or a permission that lapsed: that is a question for the
          // learner, not a reason to quietly send their code to a public compiler.
          if(handleToolchainError(error,()=>runTests()))return;
          toast('内置编译器不可用，改用在线编译器：'+error.message.slice(0,60));
        }
      }
      results=[];
      for(let index=0;index<tests.length;index++){
        const test=tests[index];
        try{
          results.push(module?await runCModule(module,test.input):await runOnline(submittedSource,test.input));
        }catch(error){
          if(error.timeout)throw new Error('用例 '+(index+1)+' 运行超过 '+(RUN_TIMEOUT_MS/1000)+' 秒仍未结束，代码很可能陷入了死循环。已强制中断，工作区没有卡死。');
          // No blob worker means no deadline enforcement, and the online judge
          // has its own server-side limit — never run unbounded code in-page.
          if(module&&/无法启动执行沙箱/.test(error.message)){
            module=null;
            toast('本机无法启动执行沙箱，改用在线编译器运行。');
            results.push(await runOnline(submittedSource,test.input));
            continue;
          }
          throw error;
        }
      }
    }
    // Moodle's judge is byte-strict about output, trailing newline included, so the
    // local runner compares exactly the same way instead of trimming whitespace.
    const rows=results.map((r,i)=>{const actual=String(r.stdout??'');const passed=actual===tests[i].expected&&!r.stderr;return{no:String(i+1),input:tests[i].input,expected:tests[i].expected,actual,error:String(r.stderr||''),passed,verdict:passed?'AC: 通过':'WA: 输出不一致',time:r.time??'-',memory:r.memory??'-',weight:'-',limit:'-',memoryLimit:'-',exit:r.exitCode??'-'};});
    current.result={rows,total:rows.length,passed:rows.filter(r=>r.passed).length,source:'custom',submittedCode:submittedSource};
    // Warnings from the build come first: they are about the code, not about a case.
    current.compileIssues=parseCompileIssues([compileWarnings].concat(results.map(r=>String(r.stderr||''))).join('\n'));
    switchBottom('results');syncDiagnosis();
  } catch(error){
    current.compileIssues=parseCompileIssues(error.message);
    current.result={rows:[],total:0,passed:0,message:error.message,compile:/error:|错误|compiler/i.test(error.message)};switchBottom('results');syncDiagnosis();throw error;
  } finally{setBusy(false);}
}
/** Jump the editor to a line the compiler complained about. */
function locateCompileLine(line) {
  if(!editor)return;
  const n=Math.min(Math.max(line,1),editor.state.doc.lines);
  const from=editor.state.doc.line(n).from;
  $('.workspace').classList.remove('show-description');
  editor.dispatch({selection:{anchor:from},effects:EditorView.scrollIntoView(from,{y:'center'})});
  editor.focus();
}
async function explainCompileErrors() {
  if(!aiReady())return;
  const output=String(current.result?.message||'');
  const issues=parseCompileIssues(output);
  const prompt=[
    '下面是我写的 C 语言代码，以及编译器的报错。请用中文说明每一处错在哪里、为什么会这样、应该怎么改。',
    '要求：直接讲结论，不要寒暄，不要重复我的代码；按错误逐条说明；最后给出改好的完整代码。',
    '题目：'+String(current.problem.statement||'').slice(0,1200),
    '我的代码：\n'+code(),
    '编译器输出：\n'+output.slice(0,4000),
    issues.length?'已经识别出的错误（供参考）：\n'+issues.map(issue=>'第 '+issue.startLine+' 行：'+issue.problem).join('\n'):''
  ].filter(Boolean).join('\n\n');
  await requestPreview('编译器在说什么',prompt,{keepOpen:true});
}

/* ------------------------------------------------------------------ export
 * Everything the workspace keeps locally, gathered into one portable archive.
 */
async function collectArchive() {
  const draftPrefix='moodle-workspace:v4:'+location.origin+':';
  const drafts=new Map();
  for(const key of Object.keys(localStorage)){
    if(!key.startsWith(draftPrefix))continue;
    try{const cached=JSON.parse(localStorage.getItem(key));if(cached&&typeof cached==='object')drafts.set(key.slice(draftPrefix.length),cached);}catch{}
  }
  try {
    for(const key of await storeKeys()){
      if(typeof key!=='string'||!key.startsWith(draftPrefix))continue;
      const stored=await storeGet(key);
      if(stored&&typeof stored==='object')drafts.set(key.slice(draftPrefix.length),stored);
    }
  } catch {}
  const entries=[];
  for(const [id,draft] of drafts){
    const meta=problems.find(p=>{try{return new URL(p.url).searchParams.get('a')===id;}catch{return false;}});
    entries.push({
      id,title:String(draft.title||meta?.title||('题目 '+id)),url:meta?.url||'',
      code:String(draft.code||''),
      tests:Array.isArray(draft.tests)?draft.tests:[]
    });
  }
  entries.sort((a,b)=>a.title.localeCompare(b.title,'zh'));
  return {
    application:'moodle-workspace',version:5,
    exportedAt:new Date().toISOString(),origin:location.origin,
    current:current?.id||null,problemCount:entries.length,problems:entries
  };
}
function archiveMarkdown(archive) {
  const fence='\x60\x60\x60';
  const lines=['# 编程工作区导出','',
    '- 导出时间：'+new Date(archive.exportedAt).toLocaleString('zh-CN'),
    '- 站点：'+archive.origin,
    '- 含草稿的题目：'+archive.problemCount,''];
  for(const item of archive.problems){
    lines.push('## '+item.title,'');
    if(item.url)lines.push('- 题目地址：'+item.url);
    lines.push('- 题目 ID：'+item.id,'','### 代码','',fence+'c',item.code||'',fence,'');
    if(item.tests.length){
      lines.push('### 用例','');
      item.tests.forEach((test,i)=>lines.push((i+1)+'. ['+(test.source||'自定义')+'] 输入 '+fence+JSON.stringify(test.input||'')+fence+' → 期望 '+fence+JSON.stringify(test.expected||'')+fence));
      lines.push('');
    }
  }
  return lines.join('\n');
}
function downloadText(name,text,type) {
  const url=URL.createObjectURL(new Blob([text],{type:type+';charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;link.download=name;link.style.display='none';
  root.append(link);link.click();
  setTimeout(()=>{link.remove();URL.revokeObjectURL(url);},4000);
}
async function openExport() {
  const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const archive=collectArchive();
  const cases=archive.problems.reduce((sum,item)=>sum+item.tests.length,0);
  const m=openModal('<header><h2>导出工作区</h2><button data-close aria-label="关闭">'+icon('close')+'</button></header>'+
    '<p class="hint">把本机保存的草稿和用例打包带走。换电脑或清理浏览器数据后都能恢复。AI 分析只留在当前页面，不会存进本机。</p>'+
    '<div class="facts"><span>'+archive.problemCount+' 道题有草稿</span><span>'+cases+' 个用例</span></div>'+
    '<footer><button data-close>取消</button><button data-export="json" class="primary">导出 JSON</button><button data-export="md">导出 Markdown</button></footer>');
  const save=async format=>{
    const fresh=await collectArchive();
    if(!fresh.problemCount){toast('还没有任何草稿可以导出。');return;}
    if(format==='md')downloadText('moodle-workspace-'+stamp+'.md',archiveMarkdown(fresh),'text/markdown');
    else downloadText('moodle-workspace-'+stamp+'.json',JSON.stringify(fresh,null,2),'application/json');
    toast('已导出 '+fresh.problemCount+' 道题的草稿。');
  };
  m.querySelector('[data-export=json]').onclick=()=>save('json');
  m.querySelector('[data-export=md]').onclick=()=>save('md');
}
function openMore() {
  const links=[...current.viewDoc.querySelectorAll('a[href]')].filter(a=>/报表|相似度|编程练习|帮助/.test(text(a))).filter((a,i,arr)=>arr.findIndex(b=>text(b)===text(a))===i);
  openModal(`<header><h2>更多功能 <small class="version-tag">v${__SCRIPT_VERSION__}</small></h2><button data-close aria-label="关闭">${icon('close')}</button></header><div class="case-tools">${button('settings','AI 与执行设置','settings')}${button('file','源文件上传','upload')}${button('export','导出工作区','doc')}${button('download','下载代码','code')}${button('original','返回原始页面','doc')}</div><h3 style="margin-top:20px">Moodle 其他功能</h3><p class="hint">以下功能在新标签页打开，不影响当前草稿。</p>${links.map(a=>`<p style="margin:8px 0"><a href="${esc(safeURL(a.getAttribute('href'),base))}" target="_blank" rel="noopener">${esc(text(a))}</a></p>`).join('')}`);
}
async function handleClick(event) {
  const el=event.target.closest('button,[data-result]');if(!el)return;
  if(el.dataset.left)return switchLeft(el.dataset.left);
  if(el.dataset.bottom)return switchBottom(el.dataset.bottom);
  if(el.dataset.tutorMode){current.tutor.mode=el.dataset.tutorMode;return renderTutor();}
  if(el.dataset.aiLine!==undefined)return locateIssue(Number(el.dataset.aiLine));
  if(el.dataset.compileLine!==undefined)return locateCompileLine(Number(el.dataset.compileLine));
  if(el.dataset.case!==undefined){testIndex=Number(el.dataset.case);renderCases();return;}
  if(el.dataset.result!==undefined){resultIndex=Number(el.dataset.result);renderResults();return;}
  if(el.dataset.problem!==undefined){const p=problems[Number(el.dataset.problem)];closeModal();return loadExercise(p.url);}
  if(el.dataset.history){
    const id=current.id;const doc=await requestDoc(el.dataset.history);
    if(current.id!==id)return;
    const source=doc.querySelector('#codeview textarea')?.value||'';
    historyCode=source;
    const host=$('[data-history-code]');
    if(host)host.innerHTML='<h3 style="margin-top:18px">历史代码（只读）</h3>'+
      '<pre class="history-code">'+esc(source||'无代码内容')+'</pre>'+
      (source.trim()?button('paste-history','把这份代码放进代码栏','code','history-paste wide'):'');
    return;
  }
  if(el.dataset.pasteHistory!==undefined){
    const id=current.id;el.disabled=true;
    try{
      // 列表项自带这次提交的地址；只读视图下面那个按钮用刚读到的那一份。
      const url=el.dataset.pasteHistory;
      const code=url?(await requestDoc(url)).querySelector('#codeview textarea')?.value||'':historyCode;
      if(current.id!==id)return;
      if(!String(code).trim())return toast('这次提交没有可读取的代码。');
      applyHistoryCode(String(code));
    }catch(error){toast(error.message);}
    finally{el.disabled=false;}
    return;
  }
  const action=el.dataset.action;
  switch(action){
    case 'problems':return openProblems();
    case 'prev':return navigateOffset(-1);
    case 'next':return navigateOffset(1);
    case 'settings':return openSettings();
    case 'more':return openMore();
    case 'submit':return submit();
    case 'run':return runTests();
    case 'refresh-result':return refreshResult();
    case 'refresh-problem':return loadExercise(current.viewURL,false);
    case 'complete':return complete();
    case 'trace':return startTrace();
    // traceGoto advances trace.cursor; trace.index does not exist, so reading it here
    // pinned both buttons to step 1 and step 2 forever.
    case 'trace-next':return traceGoto((current.trace?.cursor??0)+1);
    case 'trace-prev':return traceGoto((current.trace?.cursor??0)-1);
    case 'trace-play':return tracePlay();
    case 'trace-stop':return traceStop();
    case 'trace-screen':return traceOpenScreen();
    case 'graph-full':return openGraphScreen();
    case 'graph-close':return closeGraphScreen();
    case 'graph-in':case 'graph-out':{
      const view=current?.trace?.view;if(!view)return;
      view.zoom=Math.min(2.5,Math.max(.3,view.zoom*(action==='graph-in'?1.25:.8)));
      return applyGraphView();
    }
    case 'graph-fit':{const view=current?.trace?.view;if(!view)return;view.zoom=1;view.x=0;view.y=0;return applyGraphView();}
    case 'trace-close':return traceCloseScreen();
    case 'trace-mode':{
      const t=current?.trace;if(!t)return;
      t.mode=t.mode==='skip'?'all':'skip';
      t.cursor=0;
      traceGoto(0);
      return;
    }
    case 'show-submitted':{
      const judged=current?.result?.submittedCode;
      if(typeof judged!=='string')return toast('没有留到这次提交的代码。');
      openModal('<header><h2>判题机实际编译的代码<small class="version-tag">'+judged.split('\n').length+' 行</small></h2><button data-close aria-label="关闭">'+icon('close')+'</button></header>'+
        '<p class="hint">这是提交到 Moodle 的那一份。编译错误里的行号都是对着它算的。</p>'+
        '<pre class="submitted-code">'+esc(judged)+'</pre>');
      return;
    }
    case 'export':return openExport();
    case 'explain-error':return explainCompileErrors().catch(error=>toast(error.message));
    case 'generate':return openGenerateDialog();
    case 'ask-tutor':return askTutor();
    case 'cancel-tutor':tutorRequest?.abort();tutorRequest=null;current.tutor.status='idle';return renderTutor();
    case 'tutor-diagnose':$('.workspace').classList.add('show-description');current.tutor.mode='diagnose';return switchLeft('tutor');
    case 'add-case':current.draft.tests.push({input:'',expected:'',source:'自定义'});testIndex=current.draft.tests.length-1;saveDraft();return switchBottom('cases');
    case 'delete-case':if(current.draft.tests[testIndex]?.source==='公开样例'){toast('题目给出的用例不能删除。');return;}current.draft.tests.splice(testIndex,1);saveDraft();return renderCases();
    case 'restore-cases':current.draft.tests=current.problem.tests.map(t=>({...t,source:'公开样例'}));saveDraft();return renderCases();
    case 'file':closeModal();$('[data-attachment]').classList.toggle('hidden');return;
    case 'unfile':$('[data-file-slot] input').value='';$('[data-attachment]').classList.add('hidden');return;
    case 'clear':{
      const m=openModal(`<header><h2>清空当前代码？</h2></header><p class="hint">此操作可在编辑器内按 Ctrl + Z 撤销。</p><footer><button data-close>取消</button><button data-confirm-clear class="primary">清空</button></footer>`);
      m.querySelector('[data-confirm-clear]').onclick=()=>{editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:''}});closeModal();editor.focus();};return;
    }
    case 'indent':{
      const selection=editor.state.selection;editor.dispatch({selection:EditorSelection.single(0,editor.state.doc.length)});indentSelection(editor);editor.dispatch({selection:EditorSelection.single(Math.min(selection.main.head,editor.state.doc.length))});editor.focus();return;
    }
    case 'expand':{
      const workspace=$('.workspace'), focused=workspace.dataset.focused!=='true';
      workspace.dataset.focused=String(focused);workspace.style.gridTemplateColumns=focused?'0px 0px minmax(0,1fr)':'';return;
    }
    case 'mobile-code':$('.workspace').classList.remove('show-description');return;
    case 'mobile-description':$('.workspace').classList.add('show-description');return;
    case 'download':{
      const url=URL.createObjectURL(new Blob([code()],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='solution.c';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
    }
    case 'original':saveDraft();location.assign(current.submitURL+'#native');return location.reload();
  }
}
function setupResize() {
  $$('[data-resize]').forEach(handle=>{
    const adjust=value=>{
      const horizontal=handle.dataset.resize==='x';
      $('.app').style.setProperty(horizontal?'--split':'--editor',`${Math.max(horizontal?25:25,Math.min(horizontal?70:78,value))}%`);
      handle.setAttribute('aria-valuenow',String(Math.round(value)));
    };
    handle.onkeydown=e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const old=parseFloat($('.app').style.getPropertyValue(handle.dataset.resize==='x'?'--split':'--editor'))||50;adjust(old+(['ArrowLeft','ArrowUp'].includes(e.key)?-2:2));}};
    handle.onpointerdown=e=>{
      e.preventDefault();handle.setPointerCapture(e.pointerId);
      const region=$(handle.dataset.resize==='x'?'.workspace':'.right').getBoundingClientRect();
      handle.onpointermove=event=>adjust(handle.dataset.resize==='x'?(event.clientX-region.left)/region.width*100:(event.clientY-region.top)/region.height*100);
      handle.onpointerup=()=>{handle.onpointermove=null;handle.releasePointerCapture(e.pointerId);};
    };
  });
}
async function boot() {
  if(location.hash==='#native' || !/\/(submit|view|result|history)\.php$/.test(location.pathname) || document.querySelector('#moodle-workspace'))return;
  const id=new URL(location.href).searchParams.get('a');
  let url=id?activity('view.php',id):location.href;
  await loadExercise(url,false);
  window.addEventListener('beforeunload',saveDraft);
  window.addEventListener('popstate',()=>loadExercise(location.href.replace(/\/submit\.php/,'/view.php'),false).catch(e=>toast(e.message)));
}
boot().catch(error=>{
  if(host)toast(error.message);
  else {const el=document.createElement('div');el.textContent=`工作区加载失败：${error.message}。原始页面仍可使用。`;el.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#333;padding:16px;border:1px solid #ddd';document.body.append(el);}
});
