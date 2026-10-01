import { EditorState, EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history as editorHistory, historyKeymap, indentWithTab, indentSelection } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, completeFromList } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import css from './workspace.css';
import { esc, text, safeURL, ioDisplay, parseProblem, parseNavigation, parseResult } from './adapter.mjs';
import { parseCompileIssues, diffBlock, describeDiff } from './diagnostics.mjs';
import { SANDBOX_SOURCE } from './sandbox.mjs';
import { getKey, setKey, hasKey, maskKey } from './ai-key.mjs';
import { instrument, parseTrace, describeStep, viewIndices, changedNames } from './trace.mjs';
import { animate, stagger } from 'animejs';
import { AI_CONFIG } from './ai-config.mjs';
import { llm } from './ai.mjs';
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
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const storedPrefs=read(prefsKey,{});
dropStoredAnalyses();
let prefs = {enabled:storedPrefs.aiV5Enabled??true,runner:storedPrefs.runner||''};
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) {
    // Quota is the usual failure once many drafts and AI analyses have piled up,
    // and it also silently breaks the API key and the toolchain flag. Drop the
    // largest reclaimable entries (saved AI analyses) and try once more.
    const text=String(error&&error.name)+' '+String(error&&error.message);
    if(!/quota|exceed|full/i.test(text))return false;
    try {
      const tutors=Object.keys(localStorage).filter(k=>k.includes(':tutor:'));
      for(const stale of tutors.slice(0,60))localStorage.removeItem(stale);
      localStorage.setItem(key,JSON.stringify(value));
      return true;
    } catch { return false; }
  }
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
  const ok=persist(draftKey(current.id),current.draft);
  $('[data-save]').textContent=ok?'已存储':(storageBlocked()?'浏览器禁止了站点数据（草稿与密钥无法保存）':'草稿未能保存（浏览器存储不可用）');
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
          <footer class="foot"><span data-save>已存储</span><span data-cursor>行 1，列 1</span></footer>
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
function editorState(value) {
  const words=['int','char','float','double','long','unsigned','void','return','if','else','for','while','break','continue','struct','typedef','sizeof','const','switch','case','printf','scanf','malloc','free','strlen','main'];
  return EditorState.create({ doc:value, extensions:[
    lineNumbers(),highlightActiveLine(),highlightActiveLineGutter(),drawSelection(),editorHistory(),cpp(),
    diagnosisField,
    syntaxHighlighting(defaultHighlightStyle),indentOnInput(),bracketMatching(),closeBrackets(),foldGutter(),
    highlightSelectionMatches(),EditorView.lineWrapping,
    autocompletion({ override:[completeFromList(words.map(label=>({label,type:['printf','scanf','strlen','main'].includes(label)?'function':'keyword'})))] }),
    keymap.of([
      {key:'Mod-Enter',run:()=>{submit().catch(e=>toast(e.message));return true;}},
      {key:'Mod-i',run:()=>{complete().catch(e=>toast(e.message));return true;}},
      {key:'Mod-s',run:()=>{saveDraft();toast('草稿已保存');return true;}},
      ...closeBracketsKeymap,...defaultKeymap,...historyKeymap,...completionKeymap,...searchKeymap,...foldKeymap,indentWithTab
    ]),
    EditorView.updateListener.of(update=>{
      if (update.docChanged) {
        clearTimeout(saveTimer); saveDraft();
        if(current.tutor?.sourceCode!==undefined && current.tutor.sourceCode!==code()) {
          const warning=$('[data-tutor-stale]');if(warning)warning.classList.remove('hidden');
          $$('[data-ai-line]').forEach(b=>b.disabled=true);
        }
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
  return '<div class="result-detail">'+list+
    (issues.length?'<p class="compile-lead">这些问题已经按行标在编辑器右侧，点 L 行号可以直接跳过去。</p>':'')+
    '<details class="tutor-json tutor-reveal"><summary>编译器原始输出</summary><pre>'+esc(message)+'</pre></details>'+
    '<div class="result-assist">'+button('explain-error','AI 讲讲这几个错','ai','purple')+'</div></div>';
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
  replaceContent($('[data-left-body]'),`<div class="history"><h3>提交记录</h3>${entries.map(a=>`<button class="history-item" data-history="${esc(safeURL(a.getAttribute('href'),base))}"><span>${esc(text(a).replace(/-\s+(\d)/g,'-$1'))}</span><small>#${esc(a.getAttribute('submitid'))}</small></button>`).join('')||'<div class="empty">还没有提交记录</div>'}<div data-history-code></div></div>`);
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
    const draft=read(draftKey(id),{code:old.code ?? form.querySelector('textarea[name=code]').value,tests:problem.tests.map(t=>({...t,source:'公开样例'}))});
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
    if(file){file.setAttribute('aria-label','源文件');$('[data-file-slot]').append(file);}
    $('[data-attachment]').classList.add('hidden');
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
    <p class="hint">在 <a href="https://cloud.siliconflow.cn/account/ak" target="_blank" rel="noopener">硅基流动控制台</a> 建一个密钥粘到这里即可。密钥只写进这台浏览器的 localStorage，<strong>脚本更新后依然保留</strong>，不会上传到任何地方。点击 AI 功能时才会把题干、代码、用例与判题详情发送给硅基流动。所有 AI 功能使用同一固定模型，不会静默切换。</p>
    <label class="field">自定义用例执行 API（留空则使用内置在线编译器）<input data-runner type="url" placeholder="留空 = 内置在线编译器；或填写 https://…/run"></label>
    <details class="hint"><summary>执行 API 数据格式</summary><p>请求：{ code, language, tests: [{input, expected}] }<br>响应：{ results: [{ stdout, stderr, time, memory }] }。端点必须支持 CORS。</p></details>
    <div class="hint" data-connection role="status"></div><footer><button data-test-connection>测试连接</button><button data-save-settings class="primary">保存设置</button></footer>`);
  m.querySelector('[data-runner]').value=prefs.runner;
  m.querySelector('[data-enabled]').checked=prefs.enabled;
  m.querySelector('[data-key]').value=getKey();
  const keyState=m.querySelector('[data-key-state]');
  const paintKeyState=()=>{
    const typed=m.querySelector('[data-key]').value.trim();
    keyState.textContent=typed?(typed===getKey()?'已缓存到本机，脚本更新后仍然有效':maskKey(typed)+'（尚未保存）'):'还没有填写，AI 功能会不可用';
  };
  paintKeyState();
  m.querySelector('[data-key]').addEventListener('input',paintKeyState);
  const values=()=>({enabled:m.querySelector('[data-enabled]').checked,runner:m.querySelector('[data-runner]').value.trim()});
  m.querySelector('[data-save-settings]').onclick=()=>{
    try {
      const next=values();validateSettings(next);
      setKey(m.querySelector('[data-key]').value);
      prefs=next;persist(prefsKey,{aiV5Enabled:prefs.enabled,runner:prefs.runner});closeModal();toast(hasKey()?'设置已保存，密钥已缓存到本机':'设置已保存');
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
  current.result={...parseResult(doc,activity('result.php')),source};
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
    if(result.finished && !result.pending){current.result={...result,submitId,source:'submitted',submittedCode:data.get('code'),uploadedFile:file?.name||''};switchBottom('results');return;}
    current.result={rows:[],total:0,pending:true,message:'尚未确认本次判题结果，请稍后刷新。'};switchBottom('results');
  } catch(e) {
    current.result={rows:[],total:0,message:e.message,compile:false};switchBottom('results');toast(e.message);
  } finally {setBusy(false);}
}
// Built-in online compiler: Wandbox is a long-running public playground with
// permissive CORS, needs no key and no download. An in-browser LLVM toolchain
// would be ~100 MB, which is not acceptable to fetch on demand.
const ONLINE_COMPILER='https://wandbox.org/api/compile.json';
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
          body:JSON.stringify({compiler:'gcc-head',code:source,stdin,options:'gnu17'}),
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
      if(compileError && /OCI runtime error|crun:|Resource temporarily unavailable|internal server error/i.test(compileError))
        throw new CompilerTransportError('在线编译器暂时不可用（服务端资源不足）。');
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
// shim. Nothing is sent to a server. The ~90 MB payload is fetched once on first use
// and then served from the browser cache, so this is the offline-capable backend.
const WASM_TOOLCHAIN='https://cdn.jsdelivr.net/npm/browsercc@0.1.1/dist/index.js';
const WASI_SHIM='https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/wasi.js';
const WASI_SHIM_FS='https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/fs_mem.js';
let cToolchain=null;
async function loadToolchain(onProgress){
  if(cToolchain)return cToolchain;
  if(!read(TC_FLAG,false)&&!await tcCached())await tcDownload(onProgress||(()=>{}));
  persist(TC_FLAG,true);
  tcPatchFetch();
  onProgress?.('正在启动编译器…');
  const [toolchain,shim]=await Promise.all([import(WASM_TOOLCHAIN),import(WASI_SHIM)]);
  cToolchain={compile:toolchain.compile,shim};
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
function traceGoto(index){
  const trace=current?.trace,view=traceView();
  if(!trace||!view.length)return;
  trace.cursor=Math.max(0,Math.min(index,view.length-1));
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
    state.cursor++;
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
function traceVarHTML(v,changed){
  const cls='trace-var'+(changed?' changed':'');
  if(v.kind==='s')return '<span class="'+cls+'"><b>'+esc(v.name)+'</b><span>'+esc(v.value||'""')+'</span></span>';
  if(v.kind==='c'){const code=Number(v.value)||0;return '<span class="'+cls+'"><b>'+esc(v.name)+'</b><span>'+esc("'"+String.fromCharCode(code)+"'")+'<i>'+code+'</i></span></span>';}
  return '<span class="'+cls+'"><b>'+esc(v.name)+'</b><span>'+esc(v.value)+'</span></span>';
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
  const trace=current.trace,changed=changedNames(spot.previous,spot.step);
  const changedSet=new Set(changed),grouped=groupVars(spot.step.vars);
  host.innerHTML='<section class="tscreen">'+
      '<header class="ts-head">'+
        '<span class="ts-dot"></span><span class="ts-title">逐行执行</span>'+
        '<span class="ts-step">'+esc(traceLabel())+'</span>'+
        '<span class="grow"></span>'+
        '<button data-action="trace-mode" class="ts-btn mode">'+(trace.mode==='skip'?'跳行模式':'全部步骤')+'</button>'+
        '<button data-action="trace-play" class="ts-btn">'+(trace.playing?'暂停':'播放')+'</button>'+
        '<button data-action="trace-prev" class="ts-btn">上一步</button>'+
        '<button data-action="trace-next" class="ts-btn">下一步</button>'+
        '<button data-action="trace-close" class="ts-btn">退出全屏</button>'+
      '</header>'+
      '<div class="ts-stack">'+stackHTML(spot.step.stack,spot.step.returns)+'</div>'+
      '<div class="ts-body">'+
        '<div class="ts-code">'+traceCodeHTML(spot.step.line,4)+'</div>'+
        '<div class="ts-side">'+
          '<div class="ts-label">变量</div>'+
          '<div class="ts-vars">'+(grouped.scalars.length
            ?grouped.scalars.map(v=>traceVarHTML(v,changed.includes(v.name))).join('')
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
  // The chips that actually changed are the ones worth looking at, so they land
  // last and pop.
  const vars=host.querySelectorAll('.trace-var');
  motion(vars,{opacity:[0,1],translateY:[6,0],duration:240,delay:stagger(28),ease:'outCubic'});
  const popped=host.querySelectorAll('.trace-var.changed');
  if(popped.length)motion(popped,{scale:[1.22,1],duration:420,delay:stagger(40),ease:'outBack'});
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
  const seek=host.querySelector('[data-trace-seek]');
  if(seek)seek.oninput=event=>{clearInterval(traceTimer);traceTimer=null;current.trace.playing=false;traceGoto(Number(event.target.value)-1);};
}
function renderTrace(){
  const trace=current?.trace;
  if(trace?.fullscreen&&trace.status==='ready'&&$('[data-trace-screen]'))return renderTraceScreen();
  const host=$('[data-bottom-body]');
  if(!host)return;
  if(!trace){replaceContent(host,'<div class="empty">'+icon('run')+'点「单步」把这段代码的执行过程演一遍。</div>');return;}
  if(trace.status==='loading'){replaceContent(host,loadingHTML(trace.message||'正在编译并记录执行过程','记录完成后可以逐步播放，也可以自动播放。'));animateLoading(host);return;}
  if(trace.status==='error'){replaceContent(host,'<div class="results"><div class="result-title red">无法记录执行过程<small></small></div><div class="result-detail"><pre>'+esc(trace.error)+'</pre></div></div>');return;}
  const spot=traceSpot();
  if(!spot)return;
  const step=spot.step;
  const pct=Math.round(((spot.index+1)/spot.total)*100);
  replaceContent(host,'<section class="trace">'+
    '<div class="trace-bar">'+
      button('trace-prev','上一步','prev')+
      button('trace-play',trace.playing?'暂停':'自动播放','run')+
      button('trace-next','下一步','next')+
      button('trace-stop','停止','close')+
      button('trace-mode',trace.mode==='skip'?'跳行模式':'全部步骤','list')+
      button('trace-screen','全屏','expand')+
      '<span class="trace-count">'+esc(traceLabel())+'</span>'+
    '</div>'+
    '<div class="trace-progress"><span style="width:'+pct+'%"></span></div>'+
    '<div class="trace-vars">'+(step.vars&&step.vars.length
      ? step.vars.map(traceVarHTML).join('')
      : '<span class="trace-none">这一步还没有可见的变量</span>')+'</div>'+
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
  const {source,count}=instrument(code());
  if(!count){toast('这段代码里没有识别到可以逐行执行的语句。');return;}
  const input=current.draft.tests[testIndex]?.input ?? current.draft.tests[0]?.input ?? '';
  traceStop();
  setBusy(true);
  const keep=current.trace||{};
  current.trace={status:'loading',message:'正在编译并记录执行过程',mode:keep.mode||'skip',speed:keep.speed??5,fullscreen:!!keep.fullscreen};
  renderTrace();
  try{
    const module=await compileC(source,message=>{current.trace={status:'loading',message};renderTrace();});
    const {stdout}=await runCModule(module,input);
    const {steps,finalOutput}=parseTrace(stdout);
    if(!steps.length)throw new Error('没有记录到任何执行步骤，代码可能一进入就退出了。');
    if(steps.length>=20000)toast('执行步数过多，只记录了前 20000 步。');
    current.trace={status:'ready',steps,finalOutput,cursor:0,playing:false,mode:current.trace?.mode||'skip',speed:5,fullscreen:false};
    traceHighlight(steps[0].line);
  }catch(error){
    // Two ways a runaway program is stopped: the sandbox deadline, and the
    // 20000-step ceiling baked into the instrumented source.
    current.trace={status:'error',error:error.timeout
      ? '代码执行超过 6 秒仍未结束，很可能陷入了死循环。已强制中断，工作区没有卡住。'
      : error.message};
  }finally{setBusy(false);}
  renderTrace();
}
async function compileC(source,onProgress){
  const {compile}=await loadToolchain(onProgress);
  onProgress?.('正在编译…');
  const {module,compileOutput}=await compile({source,fileName:'main.c',flags:['-O0']});
  if(!module)throw new Error((compileOutput||'编译失败').trim().slice(0,4000));
  return module;
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
async function ensureSandbox(){
  if(cSandbox)return cSandbox;
  const sandbox=openSandbox();
  try{
    const reply=await sandbox.call({type:'init',wasi:WASI_SHIM,fs:WASI_SHIM_FS,cached:[...tcURLs]},45000);
    if(reply.type!=='ready')throw new Error(reply.message||('沙箱返回了 '+reply.type));
  }
  catch(error){
    sandbox.close();
    // Name the actual failure: a blocked worker, a blocked module import, or a
    // slow network are three different problems with three different fixes.
    throw new Error('无法启动执行沙箱（'+(error.timeout?'等待 45 秒仍未就绪':error.message)+'）');
  }
  cSandbox=sandbox;
  return cSandbox;
}
async function runCModule(module,stdin){
  const sandbox=await ensureSandbox();
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
// ---- Built-in C toolchain: download flow, local cache, and offline reuse ----
const TC_CDN='https://cdn.jsdelivr.net/npm/browsercc@0.1.1/dist/';
const TC_SHIM='https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/';
const TC_FILES=[
  ['clang.js',0.07],['clang.wasm',40.58],['lld.js',0.07],['lld.wasm',22.13],['sysroot.tar',27.29],['index.js',0.01],
].map(([name,mb])=>({url:TC_CDN+name,name,bytes:mb*1048576}));
const TC_SHIM_FILES=['index.js','wasi.js','fd.js','fs_mem.js','fs_opfs.js','strace.js','wasi_defs.js','debug.js']
  .map(name=>({url:TC_SHIM+name,name:'shim/'+name,bytes:65536}));
const TC_CACHE='moodle-workspace-c-toolchain-v1';
const TC_FLAG='moodle-workspace:v5:c-toolchain';
const TC_DISMISS='moodle-workspace:v5:c-toolchain-dismissed';
let tcFetchPatched=false;
const tcURLs=new Set([...TC_FILES,...TC_SHIM_FILES].map(a=>a.url));
async function tcCached(){
  try{ if(!self.caches)return false; const c=await caches.open(TC_CACHE); return !!(await c.match(TC_FILES[1].url)); }catch{ return false; }
}
function tcPatchFetch(){
  if(tcFetchPatched)return; tcFetchPatched=true;
  const original=self.fetch.bind(self);
  self.fetch=(input,init)=>{
    const url=typeof input==='string'?input:input?.url;
    if(!url||!tcURLs.has(url))return original(input,init);
    return caches.open(TC_CACHE).then(c=>c.match(url)).then(hit=>hit?hit.clone():original(input,init));
  };
}
async function untarGz(buffer){
  if(!self.DecompressionStream)throw new Error('浏览器不支持解压，请升级浏览器');
  const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar=new Uint8Array(await new Response(stream).arrayBuffer());
  const decoder=new TextDecoder(),files={};
  for(let offset=0;offset+512<=tar.length;){
    const name=decoder.decode(tar.subarray(offset,offset+100)).replace(/\0.*$/,'');
    if(!name)break;
    const size=parseInt(decoder.decode(tar.subarray(offset+124,offset+136)).replace(/\0.*$/,'').trim(),8)||0;
    const from=offset+512;
    files[name]=tar.slice(from,from+size);
    offset=from+Math.ceil(size/512)*512;
  }
  return files;
}
async function tcPull(url,label,onProgress,weight,offset){
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw new Error(`${label} 返回 ${response.status}`);
  const total=Number(response.headers.get('content-length'))||1;
  const reader=response.body?.getReader();
  if(!reader)return untarGz(await response.arrayBuffer());
  const chunks=[]; let received=0;
  for(;;){
    const step=await reader.read();
    if(step.done)break;
    chunks.push(step.value); received+=step.value.length;
    onProgress(offset+Math.min(1,received/total)*weight,`正在从 ${label} 下载…`);
  }
  return untarGz(await new Blob(chunks).arrayBuffer());
}
// One gzipped npm tarball (38 MB) beats the loose artefacts (90 MB), and mirrors
// serve tarballs well; each source is tried in turn until one succeeds.
const TC_SOURCES=[
  {label:'npm 官方源',main:'https://registry.npmjs.org/browsercc/-/browsercc-0.1.1.tgz',shim:'https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz'},
  {label:'npmmirror 国内源',main:'https://registry.npmmirror.com/browsercc/-/browsercc-0.1.1.tgz',shim:'https://registry.npmmirror.com/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz'},
];
async function tcDownload(onProgress){
  const cache=await caches.open(TC_CACHE);
  let lastError;
  for(const source of TC_SOURCES){
    try{
      onProgress(0,`正在从 ${source.label} 下载编译器…`);
      const main=await tcPull(source.main,source.label,onProgress,0.94,0);
      const shim=await tcPull(source.shim,source.label,onProgress,0.06,0.94);
      const prefix='package/dist/';
      for(const [name,bytes] of Object.entries(main))if(name.startsWith(prefix))await cache.put(TC_CDN+name.slice(prefix.length),new Response(bytes));
      for(const [name,bytes] of Object.entries(shim))if(name.startsWith(prefix))await cache.put(TC_SHIM+name.slice(prefix.length),new Response(bytes));
      persist(TC_FLAG,true);
      return true;
    }catch(error){ lastError=error; }
  }
  throw lastError||new Error('所有下载源都失败了');
}
function ringHTML(percent){
  const r=26,c=2*Math.PI*r;
  return `<div class="dl-ring"><svg viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="${r}"/><circle class="ring-fg" cx="32" cy="32" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c*(1-percent)).toFixed(1)}"/></svg><span>${Math.round(percent*100)}%</span></div>`;
}
async function tcOffer(){
  if(cToolchain||await tcCached()){ persist(TC_FLAG,true); return; }
  const m=openModal(`<header><h2>需要内置 C 编译器</h2></header>
    <div class="dl-body"><p><strong>在线调试需要下载内置的 C 编译器（约 40 MB）。</strong></p>
    <p>不下载就无法在本地编译运行代码，「运行」按钮将不可用。<br>只需下载一次，之后会缓存在本机，断网也能用。</p></div>
    <footer><button data-dl-cancel>取消</button><button data-dl-start class="primary">下载</button></footer>`);
  m.querySelector('[data-dl-cancel]').onclick=()=>{ persist(TC_DISMISS,true); closeModal(); };
  // Retry must re-enter this routine; calling .click() on the button from its
  // own handler recursed forever after a failed attempt.
  const startDownload=async()=>{
    m.querySelector('.dl-body').innerHTML=ringHTML(0)+'<p class="dl-note">正在下载并缓存编译器，请保持页面打开…</p>';
    m.querySelector('footer').innerHTML='';
    try{
      const paint=(fraction,message)=>{
        const fg=m.querySelector('.ring-fg'),label=m.querySelector('.dl-ring span');
        if(fg)fg.setAttribute('stroke-dashoffset',(2*Math.PI*26*(1-fraction)).toFixed(1));
        if(label)label.textContent=Math.round(fraction*100)+'%';
        const note=m.querySelector('.dl-note');
        if(note&&message)note.textContent=message;
      };
      await tcDownload(paint);
      persist(TC_DISMISS,true);
      m.querySelector('.dl-body').innerHTML='<p><strong>下载完成</strong></p><p>编译器已缓存到本机，之后运行无需再次下载。</p>';
      setTimeout(closeModal,1600);
    }catch(error){
      m.querySelector('.dl-body').innerHTML=`<p><strong>下载失败</strong></p><p>${esc(error.message)}</p>`;
      m.querySelector('footer').innerHTML='<button data-dl-cancel>关闭</button><button data-dl-start class="primary">重试</button>';
      m.querySelector('[data-dl-cancel]').onclick=()=>closeModal();
      m.querySelector('[data-dl-start]').onclick=startDownload;
    }
  };
  m.querySelector('[data-dl-start]').onclick=startDownload;
}
async function maybeOfferToolchain(){
  if(read(TC_DISMISS,false))return;
  if(read(TC_FLAG,false)||await tcCached()){ persist(TC_FLAG,true); return; }
  if(!self.caches)return;
  tcOffer();
}
async function runTests() {
  if(busy)return;
  if(!prefs.runner&&!read(TC_FLAG,false)&&!await tcCached()){ tcOffer(); return; }
  setBusy(true);saveDraft();current.compileIssues=[];syncDiagnosis();
  try {
    const tests=structuredClone(current.draft.tests),submittedSource=code();
    current.result={rows:[],total:0,passed:0,pending:true,message:prefs.runner?'正在运行自定义测试…':'正在用在线编译器运行…'};switchBottom('results');
    let results;
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
      try{ module=await compileC(submittedSource,onProgress); }
      catch(error){
        // "main.c:3:5: error: ..." is the user's code failing to compile, not a
        // missing toolchain, so it must reach the compiler-diagnostics panel.
        if(/[^\s:][^:]*:\d+:(?:\d+:)?\s*(?:fatal error|error|warning):/.test(error.message))throw error;
        toast('内置编译器不可用，改用在线编译器：'+error.message.slice(0,60));
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
    current.compileIssues=parseCompileIssues(results.map(r=>String(r.stderr||'')).join('\n'));
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
function collectArchive() {
  const draftPrefix='moodle-workspace:v4:'+location.origin+':';
  const entries=[];
  for(const key of Object.keys(localStorage)){
    if(!key.startsWith(draftPrefix))continue;
    const id=key.slice(draftPrefix.length);
    let draft=null;
    try{draft=JSON.parse(localStorage.getItem(key));}catch{continue;}
    if(!draft||typeof draft!=='object')continue;
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
function openExport() {
  const archive=collectArchive();
  const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const cases=archive.problems.reduce((sum,item)=>sum+item.tests.length,0);
  const m=openModal('<header><h2>导出工作区</h2><button data-close aria-label="关闭">'+icon('close')+'</button></header>'+
    '<p class="hint">把本机保存的草稿和用例打包带走。换电脑或清理浏览器数据后都能恢复。AI 分析只留在当前页面，不会存进本机。</p>'+
    '<div class="facts"><span>'+archive.problemCount+' 道题有草稿</span><span>'+cases+' 个用例</span></div>'+
    '<footer><button data-close>取消</button><button data-export="json" class="primary">导出 JSON</button><button data-export="md">导出 Markdown</button></footer>');
  const save=format=>{
    const fresh=collectArchive();
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
    if(current.id===id && $('[data-history-code]'))$('[data-history-code]').innerHTML=`<h3 style="margin-top:18px">历史代码（只读）</h3><pre class="history-code">${esc(doc.querySelector('#codeview textarea')?.value || '无代码内容')}</pre>`;
    return;
  }
  switch(el.dataset.action){
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
    case 'trace-next':return traceGoto((current.trace?.index??0)+1);
    case 'trace-prev':return traceGoto((current.trace?.index??0)-1);
    case 'trace-play':return tracePlay();
    case 'trace-stop':return traceStop();
    case 'trace-screen':return traceOpenScreen();
    case 'trace-close':return traceCloseScreen();
    case 'trace-mode':{
      const t=current?.trace;if(!t)return;
      t.mode=t.mode==='skip'?'all':'skip';
      t.cursor=0;
      traceGoto(0);
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
