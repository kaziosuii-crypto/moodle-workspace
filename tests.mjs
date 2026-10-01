import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { ioText, richContent, formatTime, parseProblem, parseNavigation, parseResult, safeURL } from './adapter.mjs';
import { parseTutorResponse, tutorNarrative, tutorPrompt } from './tutor.mjs';
const base='http://example.test/moodle/mod/programming/view.php?a=117';
const doc=html=>parseHTML(`<html><body>${html}</body></html>`).document;
const io=value=>`<ol><li>${value}↵</li></ol>`;

test('Moodle I/O preserves spaces and trailing newline, excludes download controls',()=>{
  assert.equal(ioText(doc(`<div><a>下载</a><ol><li>1&nbsp;2↵</li><li>&nbsp;3↵</li></ol></div>`).querySelector('div')),'1 2\n 3\n');
  assert.equal(ioText(null),'');
});
test('date and time are split',()=>{
  assert.deepEqual(formatTime('2033年 2月 25日 星期五 17:00'),{date:'2033-02-25',time:'17:00'});
});
test('rich content drops executable elements and attributes',()=>{
  const html=richContent(doc('<div><p onclick="bad()">hello <b>world</b></p><script>bad()</script><a href="javascript:bad()">link</a><img src="/a.png" onerror="bad()"></div>').querySelector('div'),base);
  assert.ok(html.includes('<b>world</b>'));
  assert.doesNotMatch(html,/onclick|onerror|javascript:|<script/);
  assert.equal(safeURL(null,base),'');
  assert.equal(safeURL('data:text/html,bad',base),'');
  assert.equal(safeURL('submit.php?a=117',base),'http://example.test/moodle/mod/programming/submit.php?a=117');
});
test('problem fields use dedicated sections, not navigation text',()=>{
  const p=parseProblem(doc(`<nav>unrelated</nav><div class="maincontent"><h1 class="name">1.3 两数求和</h1><div class="grade">成绩: 5 / 折扣: 0.8</div><div id="description"><p>输入两个整数</p></div><table id="testcase-table"><tr><th>输入</th><th>输出</th></tr><tr><td>${io('23&nbsp;45')}</td><td>${io('68')}</td><td>1秒</td><td>64M</td></tr></table><table id="time-table"><tr><th>开启时间</th><td>2019年 2月 25日 08:00</td></tr></table><a href="/moodle/mod/programming/submit.php?a=117">提交</a></div>`),base);
  assert.equal(p.title,'1.3 两数求和');
  assert.equal(p.statement,'输入两个整数');
  assert.equal(p.score,'5');assert.equal(p.discount,'0.8');
  assert.equal(p.tests[0].input,'23 45\n');assert.equal(p.tests[0].expected,'68\n');
  assert.equal(p.timing[0].date,'2019-02-25');
  assert.ok(p.submitURL.endsWith('submit.php?a=117'));
});
test('navigation filters non-programming resources and resolves current title',()=>{
  const items=parseNavigation(doc('<select><option value="/moodle/mod/forum/view.php?id=1">讨论</option><option value="/moodle/mod/programming/view.php?id=166">1.2 输入输出</option><option value="/moodle/mod/programming/view.php?id=167">跳至...</option></select>'),base,'1.3 两数求和');
  assert.equal(items.length,2);assert.equal(items[1].current,true);assert.equal(items[1].title,'1.3 两数求和');
});
test('result table parses all 13 fields and submission identity',()=>{
  const cells=['1','2','1秒','64M',io('2&nbsp;3'),io('5'),`<a href="download.php?submit=99">下载</a>${io('5')}`,'无','0.004','10','0','是','AC: 完全正确'];
  const r=parseResult(doc(`<div class="maincontent"><p>当前状态：程序已处理完毕。</p><table id="test-result-detail-table"><tr><th>No.</th></tr><tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr></table></div>`),base);
  assert.equal(r.submitId,'99');assert.equal(r.passed,1);assert.equal(r.total,1);assert.equal(r.pending,false);
  assert.equal(r.rows[0].actual,'5\n');assert.equal(r.rows[0].weight,'2');assert.equal(r.rows[0].time,'0.004');
});
test('pending and compilation failure remain distinct from accepted results',()=>{
  const pending=parseResult(doc('<div class="maincontent"><p>当前状态：正在处理。</p></div>'),base);
  assert.equal(pending.pending,true);assert.equal(pending.finished,false);
  const ce=parseResult(doc('<div class="maincontent"><p>当前状态：编译失败。</p><pre>error: missing semicolon</pre></div>'),base);
  assert.equal(ce.compile,true);assert.equal(ce.finished,true);assert.match(ce.message,/semicolon/);
});
const diagnostic={startLine:2,endLine:3,severity:'warning',title:'check',problem:'why',hint:'think',suggestion:'change',replacement:'return 0;'};
test('tutor requires narrative plus validated JSON issue records',()=>{
  const answer=parseTutorResponse(JSON.stringify({explanation:'Reason',issues:[diagnostic],nextSteps:['Try an edge case']}),5);
  assert.equal(answer.issues[0].startLine,2);
  assert.equal(answer.issues[0].suggestion,'change');
  assert.throws(()=>parseTutorResponse('not json',5),/JSON/);
  assert.throws(()=>parseTutorResponse('{"issues":[],"nextSteps":[]}',5),/文字讲解/);
  assert.throws(()=>parseTutorResponse(JSON.stringify({explanation:'why',issues:[{...diagnostic,severity:'bad'}],nextSteps:[]}),5),/格式/);
});
test('out-of-bounds tutor lines cannot navigate outside the editor',()=>{
  const answer=parseTutorResponse(JSON.stringify({explanation:'Reason',issues:[{...diagnostic,startLine:999,endLine:1000}],nextSteps:[]}),5);
  assert.equal(answer.issues[0].startLine,null);
  assert.equal(answer.issues[0].locationWarning,true);
});
test('tutor narrative escapes HTML while formatting prose and lists',()=>{
  const html=tutorNarrative('**hello** `int`\n\n- one\n- <img src=x onerror=bad()>');
  assert.match(html,/<strong>hello<\/strong>/);
  assert.match(html,/<code>int<\/code>/);
  assert.match(html,/<ul>/);
  assert.doesNotMatch(html,/<img/);
});
test('tutor prompt keeps test inputs expected outputs and submission evidence',()=>{
  const context={editorCode:'int main(){}',publicTests:[{input:'1 2\n',expected:'3\n'}],submission:{matchesEditor:false,cases:[{actual:'-1\n',expected:'3\n'}]}};
  const prompt=tutorPrompt(context,'diagnose','why?');
  assert.ok(prompt.includes(JSON.stringify(context)));
  assert.match(prompt,/诊断错误/);
  assert.match(prompt,/why\?/);
});

test('逐行执行的上一步/下一步读的是真实存在的游标字段',()=>{
  // 这两个按钮曾经用 current.trace.index 算目标步，而 index 从来没被赋过值，
  // 于是 (undefined ?? 0) ± 1 永远只得到第 1、2 步 —— 手动点怎么都走不动。
  const source=readFileSync(new URL('./workspace.mjs',import.meta.url),'utf8');
  assert.ok(!/current\.trace\??\.index/.test(source),
    'trace.index 从不赋值；用 cursor 算下一步');
});
