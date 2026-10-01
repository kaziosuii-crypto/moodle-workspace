/**
 * Step-by-step execution, VS Code style, without a debugger.
 *
 * The browser cannot single-step WASM with C line information: that needs DWARF
 * parsing and an instruction-level interpreter. Instead the source is
 * instrumented — a marker is printed just before every statement — the program
 * runs once, and the recorded markers are replayed as an animation. No parser,
 * no debug symbols; the marker rides on plain printf.
 */
const MARK = '__WS_STEP__';

/**
 * Insert a marker before every statement.
 *
 * Only lines inside a function body are considered (depth >= 1), which skips
 * #includes, globals and the "int main(void) {" line itself. A line only starts a
 * statement when the previous non-blank line ended one, so a call split across
 * two lines is not counted twice.
 */
export function instrument(source) {
  const lines = String(source || '').split('\n');
  const out = [];
  let depth = 0, boundary = true, count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const body = raw.trim();
    const opens = (raw.match(/\{/g) || []).length;
    const closes = (raw.match(/\}/g) || []).length;
    const isComment = body.startsWith('//') || body.startsWith('/*') || body.startsWith('*');
    const control = /^(if|else|for|while|do|switch)\b/.test(body);
    if (depth >= 1 && boundary && body && !body.startsWith('#') && !body.startsWith('}') && !isComment) {
      const indent = (raw.match(/^\s*/) || [''])[0];
      out.push(indent + 'printf("' + MARK + '%d\\n",' + (i + 1) + ');');
      count++;
    }
    out.push(raw);
    depth += opens - closes;
    if (depth < 0) depth = 0;
    if (body) boundary = /[;{}:]\s*$/.test(body) || (control && /\)\s*$/.test(body));
  }
  const text = out.join('\n');
  // The marker needs printf, which the student's code may not have included.
  const ready = /^\s*#\s*include\s*<stdio\.h>/m.test(text) ? text : '#include <stdio.h>\n' + text;
  return { source: ready, count };
}

/** Split program output into replayed steps and the text produced so far. */
export function parseTrace(stdout) {
  const steps = [];
  let output = '';
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^__WS_STEP__(\d+)\r?$/);
    if (match) { steps.push({ line: Number(match[1]), output }); continue; }
    output += line + '\n';
  }
  return { steps, finalOutput: output };
}

/** One plain sentence describing where the run is. */
export function describeStep(steps, index) {
  if (!steps.length) return '没有记录到任何执行步骤。';
  if (index >= steps.length) return '程序已结束。';
  return '第 ' + (index + 1) + ' / ' + steps.length + ' 步 · 第 ' + steps[index].line + ' 行';
}
