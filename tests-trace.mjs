import { instrument, parseTrace } from './trace.mjs';

const HEAD = '#include <stdio.h>\n';
const CASES = {
  'basic scalars': ['int main(void) {', '    int a = 3, b = 4;', '    int s = a + b;', '    printf("%d\\n", s);', '    return 0;', '}'],
  'function + recursion': ['int fact(int n) {', '    if (n <= 1) return 1;', '    return n * fact(n - 1);', '}', 'int main(void) {', '    printf("%d\\n", fact(5));', '    return 0;', '}'],
  'arrays + loops': ['int main(void) {', '    int a[4] = {5, 6, 7, 8};', '    int s = 0;', '    for (int i = 0; i < 4; i++) {', '        s += a[i];', '    }', '    printf("%d\\n", s);', '    return 0;', '}'],
  'torture types': ['struct p { int x; };', 'int *pick(int *q) { return q; }', 'int main(void) {', '    int unsized[] = {1, 2};', '    int grid[2][2] = {{1,2},{3,4}};', '    struct p pt;', '    pt.x = 7;', '    int ok[2] = {9, 8};', '    int *ptr = ok;', '    char s[8] = "hi";', '    printf("%d %d %d %s\\n", unsized[1], grid[1][0], ptr[1], s);', '    return 0;', '}'],
  'braces in text': ['int main(void) {', '    // a comment with { and }', '    char t[] = "}{ mixed {";', '    int n = 2;', '    printf("%s %d\\n", t, n);', '    return 0;', '}'],
  'struct at file scope': ['#include <stdlib.h>', 'struct node {', '    int val;', '    struct node* next;', '};', 'enum colour { RED, GREEN };', 'int main(void) {', '    struct node* p = (struct node*)malloc(sizeof(struct node));', '    p->val = 7;', '    for (int i = 0; i < 3; i++) {', '        p->val = p->val + i;', '    }', '    printf("%d\\n", p->val);', '    free(p);', '    return 0;', '}'],
  'circular linked list': ['#include <stdlib.h>', 'struct listNode { int val; struct listNode* next; };', 'int main(void) {', '    struct listNode* head = (struct listNode*)malloc(sizeof(struct listNode));', '    head->val = 1;', '    struct listNode* cur = head;', '    for (int i = 2; i <= 4; i++) {', '        struct listNode* fresh = (struct listNode*)malloc(sizeof(struct listNode));', '        fresh->val = i;', '        cur->next = fresh;', '        cur = fresh;', '    }', '    cur->next = head;', '    struct listNode* now = head;', '    for (int k = 0; k < 3; k++) {', '        now = now->next;', '    }', '    printf("%d\\n", now->val);', '    free(head);', '    return 0;', '}'],
  // Allman 风格：函数头的 '{' 在下一行。原来这种写法整份文件一个 marker 都没有，
  // 点「单步」只会得到「没有识别到可以逐行执行的语句」。
  // printf 不带换行时，下一个 marker 会落在同一行。按整行处理就会把 marker 当成
  // 程序自己的输出打印出来（"数组元素：__WS_STEP__78|..."）。
  'printf without a trailing newline': ['int main(void) {', '    printf("a");', '    int x = 1;', '    printf("b");', '    printf("%d\\n", x);', '    return 0;', '}'],
  'allman-style heads': ['static void show(int n)', '{', '    printf("%d\\n", n);', '}', 'int main(void)', '{', '    int i = 0;', '    for (i = 0; i < 3; i++)', '    {', '        show(i);', '    }', '    return 0;', '}'],
  'switch + nested loops': ['int main(void) {', '    int total = 0;', '    for (int i = 0; i < 3; i++) {', '        for (int j = 0; j < 3; j++) {', '            switch (i) {', '                case 0: total += 1; break;', '                default: total += 2;', '            }', '        }', '    }', '    printf("%d\\n", total);', '    return 0;', '}'],
  // A one-line loop body used to hide the whole loop from the trace, and the counter
  // the head declares leaked into the enclosing scope, so every later marker named a
  // variable that no longer existed and the instrumented source no longer compiled.
  'one-line for body': ['int main(void) {', '    int sum = 0;', '    for (int i = 0; i < 4; i++) sum += i;', '    printf("%d\\n", sum);', '    return 0;', '}'],
  'unbraced for body': ['int main(void) {', '    int sum = 0;', '    for (int i = 0; i < 4; i++)', '        sum += i;', '    printf("%d\\n", sum);', '    return 0;', '}'],
  'tree with 2 field declarators': ['#include <stdlib.h>', 'struct node { int val; struct node *left, *right; };', 'struct node *ins(struct node *t, int v) {', '    if (t == NULL) {', '        struct node *n = (struct node *)malloc(sizeof(struct node));', '        n->val = v; n->left = NULL; n->right = NULL;', '        return n;', '    }', '    if (v < t->val) t->left = ins(t->left, v);', '    else t->right = ins(t->right, v);', '    return t;', '}', 'int main(void) {', '    struct node *root = NULL;', '    int keys[7] = {5, 3, 8, 1, 4, 7, 9};', '    for (int i = 0; i < 7; i++) root = ins(root, keys[i]);', '    printf("%d\\n", root->val);', '    return 0;', '}'],
  'list cursor (2 declarators)': ['#include <stdlib.h>', 'struct node {', '    int val;', '    struct node *next;', '};', 'int main(void) {', '    struct node *head = NULL, *p;', '    for (int i = 3; i >= 1; i--) {', '        p = (struct node *)malloc(sizeof(struct node));', '        p->val = i;', '        p->next = head;', '        head = p;', '    }', '    int sum = 0;', '    for (p = head; p != NULL; p = p->next) {', '        sum += p->val;', '    }', '    printf("%d\\n", sum);', '    return 0;', '}'],
};

/** Per-case assertions beyond "it compiles and prints the same".
 *
 * The cursor in "struct node *head = NULL, *p;" used to be invisible: only the
 * first declarator was read, so a linked-list trace never showed the pointer that
 * walks the list - the one variable the whole picture is about.
 */
const CHECKS = {
  // A recursive builder whose return type is "struct node *" used to be skipped
  // entirely, so the trace showed the call and none of the tree it built.
  'tree with 2 field declarators': ({ trace }) => {
    const most = Math.max(0, ...trace.steps.map(s => s.nodes.length));
    return most >= 7 ? [] : ['only ' + most + ' of 7 nodes reached the walker'];
  },
  'list cursor (2 declarators)': ({ trace }) => {
    const names = new Set(trace.steps.flatMap(s => s.vars.map(v => v.name)));
    const missing = ['head', 'p'].filter(n => !names.has(n));
    return missing.length ? ['no variable ' + missing.join(', ') + ' (saw ' + [...names].join(', ') + ')'] : [];
  },
};

const run = async (code) => (await fetch('https://wandbox.org/api/compile.json', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({compiler:'gcc-head', code, options:'gnu17'}) })).json();

let pass = 0, fail = 0;
for (const [name, body] of Object.entries(CASES)) {
  const plain = HEAD + body.join('\n');
  const inst = instrument(body.join('\n'));
  const a = await run(plain), b = await run(inst.source);
  const trace = parseTrace(b.program_output || '');
  const problems = [];
  if ((b.compiler_output || '').trim() || (b.compiler_error || '').trim()) problems.push('compile');
  if (String(b.status) !== '0') problems.push('status ' + b.status);
  // 没有 marker 意味着插桩完全没生效，此时 steps 断言会恰好地静默通过。
  if (!inst.count) problems.push('no markers at all');
  if (trace.steps.length < inst.count) problems.push('steps ' + trace.steps.length + ' < markers ' + inst.count);
  if (trace.finalOutput !== a.program_output) problems.push('output ' + JSON.stringify(trace.finalOutput) + ' vs ' + JSON.stringify(a.program_output));
  if (CHECKS[name]) problems.push(...CHECKS[name]({ inst, trace, plain }));
  if (problems.length) { fail++; console.log('FAIL  ' + name.padEnd(22) + problems.join(' | ')); }
  else { pass++; console.log('ok    ' + name.padEnd(22) + String(inst.count).padStart(3) + ' sites ' + String(trace.steps.length).padStart(3) + ' steps  out=' + JSON.stringify(trace.finalOutput)); }
}
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
