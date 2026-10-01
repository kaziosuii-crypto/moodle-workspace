import { instrument, parseTrace } from './trace.mjs';

const HEAD = '#include <stdio.h>\n';
const CASES = {
  'basic scalars': ['int main(void) {', '    int a = 3, b = 4;', '    int s = a + b;', '    printf("%d\\n", s);', '    return 0;', '}'],
  'function + recursion': ['int fact(int n) {', '    if (n <= 1) return 1;', '    return n * fact(n - 1);', '}', 'int main(void) {', '    printf("%d\\n", fact(5));', '    return 0;', '}'],
  'arrays + loops': ['int main(void) {', '    int a[4] = {5, 6, 7, 8};', '    int s = 0;', '    for (int i = 0; i < 4; i++) {', '        s += a[i];', '    }', '    printf("%d\\n", s);', '    return 0;', '}'],
  'torture types': ['struct p { int x; };', 'int *pick(int *q) { return q; }', 'int main(void) {', '    int unsized[] = {1, 2};', '    int grid[2][2] = {{1,2},{3,4}};', '    struct p pt;', '    pt.x = 7;', '    int ok[2] = {9, 8};', '    int *ptr = ok;', '    char s[8] = "hi";', '    printf("%d %d %d %s\\n", unsized[1], grid[1][0], ptr[1], s);', '    return 0;', '}'],
  'braces in text': ['int main(void) {', '    // a comment with { and }', '    char t[] = "}{ mixed {";', '    int n = 2;', '    printf("%s %d\\n", t, n);', '    return 0;', '}'],
  'struct at file scope': ['struct node {', '    int val;', '    struct node* next;', '};', 'enum colour { RED, GREEN };', 'int main(void) {', '    struct node* p = (struct node*)malloc(sizeof(struct node));', '    p->val = 7;', '    for (int i = 0; i < 3; i++) {', '        p->val = p->val + i;', '    }', '    printf("%d\\n", p->val);', '    free(p);', '    return 0;', '}'],
  'switch + nested loops': ['int main(void) {', '    int total = 0;', '    for (int i = 0; i < 3; i++) {', '        for (int j = 0; j < 3; j++) {', '            switch (i) {', '                case 0: total += 1; break;', '                default: total += 2;', '            }', '        }', '    }', '    printf("%d\\n", total);', '    return 0;', '}'],
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
  if (trace.steps.length < inst.count) problems.push('steps ' + trace.steps.length + ' < markers ' + inst.count);
  if (trace.finalOutput !== a.program_output) problems.push('output ' + JSON.stringify(trace.finalOutput) + ' vs ' + JSON.stringify(a.program_output));
  if (problems.length) { fail++; console.log('FAIL  ' + name.padEnd(22) + problems.join(' | ')); }
  else { pass++; console.log('ok    ' + name.padEnd(22) + String(inst.count).padStart(3) + ' sites ' + String(trace.steps.length).padStart(3) + ' steps  out=' + JSON.stringify(trace.finalOutput)); }
}
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
