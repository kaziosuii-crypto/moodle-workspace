import { esc } from './adapter.mjs';

/** Render a newline as a visible marker so a trailing newline is never a guess. */
const eol = value => esc(String(value == null ? '' : value)).replace(/\n/g, '<span class="io-eol">↵</span>\n');

/* ------------------------------------------------------------------ compile
 * Clang/gcc diagnostics are English, terse and phrased for people who already
 * know C. Beginners need the cause, so the common messages are mapped to plain
 * Chinese. Anything unmatched still gets its line marked with the raw message.
 */
const COMPILE_RULES = [
  [/stray '\\\d+' in program/i, '代码里混进了中文标点', '全角标点（，。；：（）""\'\'）不是 C 语言的一部分。把它们换成半角 , . ; : ( ) " \' 。'],
  [/expected ';'/i, '这一行少了一个分号 ;', 'C 语言每条语句末尾都要有英文分号 ;。检查这一行和上一行的结尾。'],
  [/expected '\)'/i, '这一行的括号没有配平', '检查 ( 和 ) 是否成对，常见于少写或多写了一个。'],
  [/expected '\}'|expected '\}' at end of input|end of input/i, '大括号没有闭合', '往下翻到文件末尾，确认每一个 { 都有对应的 }。'],
  [/undeclared identifier|undeclared|was not declared/i, '用到了一个没有定义的变量', '变量要先声明再使用。检查拼写，或者在使用前写成 int x; 这样的定义。'],
  [/implicit declaration of function|call to undeclared function|implicitly declaring library function/i, '函数没有声明就用了', '多半是忘了 #include：printf / scanf 要 <stdio.h>，malloc / free 要 <stdlib.h>，strlen 要 <string.h>，sqrt 要 <math.h>。'],
  // A pointer is expected where a plain value was passed. In a scanf that is the
  // missing "&", which compiles with only a warning and then writes to a stray address.
  [/format .*expects argument of type '[^']*\*'|format specifies type '[^']*\*' but the argument has type/i, '传给 scanf 的应该是地址', '多半是少写了取地址符 &，写成 scanf("%d", &x); 。变量本身只是一个数字，scanf 却把它当成内存地址去写，程序可能因此崩溃，也可能悄悄改掉别的内存。'],
  [/format .*expects argument of type|format specifies type .* but the argument has type/i, '格式符和变量的类型对不上', '%d 配 int，%f / %lf 配 float / double，%c 配 char，%s 配字符串。'],
  [/too few arguments to function|too many arguments to function/i, '函数调用的参数个数不对', '对照函数定义数一数括号里的参数个数。'],
  [/lvalue required as left operand of assignment/i, '赋值号左边不能放这个东西', '= 左边必须是变量，不能写成 3 = x 或者 a + b = c。'],
  [/control reaches end of non-void function|non-void function does not return/i, '函数没有写 return', 'int main 结尾要有 return 0;，其它有返回值的函数也要保证每条分支都 return。'],
  [/may be used uninitialized|is used uninitialized|is uninitialized when used here/i, '变量没有赋初值就用了', '声明时就给个初始值，比如 int sum = 0; 再用。'],
  // The judge here is gcc-3.3, whose default is C89: a counter declared inside the
  // loop head is an error there, and it has to be an error in the local run too.
  [/for' loop initial declarations|ISO C90 forbids.*for|initial declarations are only allowed|variable declarations in for loop initializers/i, '循环计数器要在外面先声明', '这台判题机是 gcc-3.3，默认 C89，for (int i = 0; ...) 这种写法它不接受。改成 int i; 先声明，再 for (i = 0; ...)。'],
  [/declaration-after-statement|ISO C90 forbids mixed declarations/i, '变量声明要放在语句前面', 'C89 要求一个块里的变量声明都在最前面。把 int n; 这类声明提到块的顶部，别夹在语句中间。'],
  [/implicit declaration of function 'scanf'|implicit declaration of function 'printf'/i, '忘了 #include <stdio.h>', 'printf 和 scanf 都要 #include <stdio.h>。'],
  [/comparison between pointer and integer|incompatible (integer|pointer) to (integer|pointer)/i, '类型不匹配', '把不同类型的东西直接比较或赋值了。检查是不是漏写 & 或者多写了 *。'],
  [/undefined reference to/i, '链接失败：找不到这个函数', '函数名拼错了，或者只声明了却没有写实现。'],
  // wasm-ld (the local toolchain) words it differently, and without a line number.
  [/undefined symbol[\s:]+([A-Za-z_]\w*)/i, '有个函数或变量没有定义', '链接器找不到这个名字：先看拼写，再看是不是只写了调用、没有写定义。函数要写在 main 前面，或者在使用前先声明。'],
  [/duplicate symbol/i, '同一个名字定义了两次', '两个地方定义了同名的函数或全局变量，删掉其中一个。'],
  [/expected declaration specifiers/i, '这里应该是类型名', 'C 语言的语句要写在函数内部，函数外面只能放声明和定义。'],
  [/conflicting types for/i, '同一个东西被定义成了两种类型', '检查函数声明和定义的返回类型、参数类型是否一致。'],
  [/expected expression/i, '这里缺了一个表达式', '常见原因是多打了一个逗号或运算符，或者赋值号右边是空的。'],
  [/implicit conversion changes|conversion from .* may lose/i, '类型转换可能丢精度', '把 double 赋给 int 会丢掉小数部分，想保留就统一用 double。'],
  [/unused variable/i, '变量定义了但没有用到', '可以删掉，顺便检查是不是本来想用另一个变量名。'],
  [/redefinition of/i, '同一个名字定义了两次', '同一个作用域里变量名不能重复，检查是不是写了两行一样的定义。']
];

// The file name must not contain spaces, otherwise the pattern also matches the
// prose inside a diagnostic message.
const COMPILE_LINE = /^([^\s:][^\s:]*):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
const DIAGNOSTIC_START = /([^\s:][^\s:]*:\d+:(?:\d+:)?\s*(?:fatal error|error|warning|note):)/g;

export function explainCompileMessage(message, severity) {
  for (const entry of COMPILE_RULES) if (entry[0].test(message)) return { title: entry[1], hint: entry[2] };
  return { title: severity === 'warning' ? '编译器在这一行给了个警告' : '编译器在这一行报了错', hint: '' };
}

/**
 * Turn raw compiler output into issue records the editor can mark and explain.
 *
 * "places" maps an instrumented line back to the user's own line, and is passed when
 * the diagnostic came from the traced copy of the program: the helpers that make the
 * trace work live on lines the editor does not have, so those diagnostics are dropped
 * rather than pointed at the wrong line.
 */
export function parseCompileIssues(output, places = null) {
  const issues = [], seen = new Set();
  // Output may arrive line-separated (gcc) or flattened onto one line, so a
  // newline is inserted ahead of every diagnostic before splitting.
  const normalised = String(output || '').replace(DIAGNOSTIC_START, '\n$1');
  for (const raw of normalised.split('\n')) {
    const match = raw.match(COMPILE_LINE);
    if (!match) continue;
    const file = match[1], lineText = match[2], kind = match[4], message = match[5];
    if (kind === 'note') continue;
    if (places && /__ws_/.test(message)) continue;
    // In the traced copy every variable is read one step early by the marker that
    // reports it, so "used uninitialized" is about our own read, not the learner's.
    // The run path compiles the untouched source and still reports it properly.
    if (places && /uninitialized when used here|may be used uninitialized|is used uninitialized/.test(message)) continue;
    const line = places ? (places[Number(lineText)] || 0) : Number(lineText);
    const key = kind + ':' + line + ':' + message;
    if (!Number.isFinite(line) || line < 1 || seen.has(key)) continue;
    seen.add(key);
    const explained = explainCompileMessage(message, kind === 'warning' ? 'warning' : 'error');
    // One mistake often arrives twice - an error and the warning behind it - and the
    // same rule on the same line is one thing to fix, not two.
    const ruleKey = line + '|' + explained.title;
    if (seen.has(ruleKey)) continue;
    seen.add(ruleKey);
    const short = String(file).split(/[\\/]/).pop();
    // A caller that offsets line numbers can name a line that is not in the editor at
    // all - the judge's own prefix. It is listed, but there is nowhere to jump to.
    const inPrefix = /^前置代码$/.test(short);
    issues.push({
      startLine: inPrefix ? 0 : line, endLine: inPrefix ? 0 : line, prefix: inPrefix,
      severity: kind === 'warning' ? 'warning' : 'error',
      title: explained.title,
      problem: short + ':' + lineText + ' · ' + message.trim(),
      hint: explained.hint
    });
    if (issues.length >= 40) break;
  }
  return issues;
}

/* --------------------------------------------------------------------- diff
 * The judge compares bytes, so a single missing trailing newline fails a case.
 * Side-by-side output makes that invisible; this locates the exact character.
 */
export function charDiff(expected, actual) {
  const a = String(expected == null ? '' : expected), b = String(actual == null ? '' : actual);
  const shortest = Math.min(a.length, b.length);
  let head = 0;
  while (head < shortest && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < shortest - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
}

/** One plain sentence naming what actually differs. */
export function describeDiff(expected, actual) {
  const a = String(expected == null ? '' : expected), b = String(actual == null ? '' : actual);
  if (a === b) return '';
  if (a === b + '\n') return '实际输出末尾少了一个换行符 ↵';
  if (b === a + '\n') return '实际输出末尾多了一个换行符 ↵';
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return '内容相同，只差空白字符（空格 / 制表符 / 换行）';
  const diff = charDiff(a, b);
  const line = a.slice(0, diff.head).split('\n').length;
  return '从第 ' + (diff.head + 1) + ' 个字符（第 ' + line + ' 行）开始不同';
}

/** Side-by-side diff with only the differing run highlighted. */
export function diffBlock(expected, actual) {
  const a = String(expected == null ? '' : expected), b = String(actual == null ? '' : actual);
  if (a === b) return '';
  const diff = charDiff(a, b), context = 22;
  const aEnd = a.length - diff.tail, bEnd = b.length - diff.tail;
  const window = (source, start, midFrom, midTo, stop) =>
    (start > 0 ? '<span class="diff-gap">…</span>' : '') +
    eol(source.slice(start, midFrom)) +
    '<span class="diff-only">' + eol(source.slice(midFrom, midTo)) + '</span>' +
    eol(source.slice(midTo, stop)) +
    (stop < source.length ? '<span class="diff-gap">…</span>' : '');
  const row = (label, key, source, midFrom, midTo) => {
    const start = Math.max(0, midFrom - context), stop = Math.min(source.length, midTo + context);
    return '<div class="diff-row diff-' + key + '"><span class="diff-label">' + label + '</span><code>' +
      window(source, start, Math.min(midFrom, stop), Math.min(midTo, stop), stop) + '</code></div>';
  };
  return '<div class="diff"><div class="diff-verdict">' + esc(describeDiff(a, b)) + '</div>' +
    row('期望', 'expected', a, diff.head, aEnd) + row('实际', 'actual', b, diff.head, bEnd) + '</div>';
}
