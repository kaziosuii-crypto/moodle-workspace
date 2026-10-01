/**
 * Step-by-step execution, VS Code style, without a debugger.
 *
 * The browser cannot single-step WASM with C line information: that needs DWARF
 * parsing and an instruction-level interpreter. Instead the source is
 * instrumented — a marker printing the current line and the live variables is
 * inserted before every statement — the program runs once, and the recorded
 * markers are replayed as an animation.
 *
 * The declaration scanner below is not a C compiler. It understands the subset a
 * beginner writes (base types, arrays, multi-name declarations, block scoping)
 * and deliberately ignores anything it cannot prove safe — pointers, structs,
 * typedefs — because printing a value with the wrong format is worse than not
 * printing it.
 */
const MARK = '__WS_STEP__';
const STEP_CAP = 20000;

/** Format specifier and rendering kind for a declaration specifier list. */
function specifierOf(spec) {
  const s = spec.replace(/\s+/g, ' ').trim().replace(/^(?:(?:static|const|volatile|register|auto)\s+)+/, '');
  if (/^unsigned long long/.test(s)) return { kind: 'i', fmt: '%llu' };
  if (/^long long/.test(s)) return { kind: 'i', fmt: '%lld' };
  if (/^unsigned long/.test(s)) return { kind: 'i', fmt: '%lu' };
  if (/^unsigned/.test(s)) return { kind: 'i', fmt: '%u' };
  if (/^long/.test(s)) return { kind: 'i', fmt: '%ld' };
  if (/^(short|int|signed)/.test(s)) return { kind: 'i', fmt: '%d' };
  if (/^(double|float)/.test(s)) return { kind: 'd', fmt: '%g' };
  if (/^char/.test(s)) return { kind: 'c', fmt: '%d' };
  if (/^size_t/.test(s)) return { kind: 'i', fmt: '%zu' };
  return null;
}

/** Split on a separator that is not nested inside (), [] or {}. */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

const SPECIFIER = /^(?:(?:static|const|volatile|register|auto|unsigned|signed|long|short|int|char|float|double|size_t)\s+)+/;

/** Names and kinds declared by one line, or [] when it declares nothing usable. */
export function declarationsIn(line) {
  const body = line.trim();
  const match = body.match(SPECIFIER);
  if (!match) return [];
  const base = specifierOf(match[0]);
  if (!base) return [];
  let rest = body.slice(match[0].length).replace(/;\s*$/, '');
  if (!rest || rest.includes('*')) return [];           // pointers are left alone
  if (/\(/.test(rest.split('=')[0])) return [];          // a function, not a variable
  const out = [];
  for (const part of splitTop(rest, ',')) {
    const name = part.match(/^\s*([A-Za-z_]\w*)\s*(?:\[(\s*\d*\s*)\])?/);
    if (!name) continue;
    const size = name[2] === undefined ? 0 : Math.min(Number(name[2].trim()) || 0, 8);
    if (name[2] !== undefined) out.push({ name: name[1], kind: base.kind === 'c' ? 's' : base.kind, fmt: base.kind === 'c' ? '%.40s' : base.fmt, size });
    else out.push({ name: name[1], kind: base.kind, fmt: base.fmt, size: 0 });
  }
  return out;
}

/** "int a" -> one printable field per name, arrays expanded element by element. */
function fieldsOf(variable) {
  if (!variable.size) return [{ label: variable.name, expr: variable.name, kind: variable.kind, fmt: variable.fmt }];
  const fields = [];
  for (let i = 0; i < variable.size; i++) {
    fields.push({ label: variable.name + '[' + i + ']', expr: variable.name + '[' + i + ']', kind: variable.kind, fmt: variable.fmt });
  }
  return fields;
}

/** Every name visible here, innermost declaration winning where they shadow. */
function visible(scopes) {
  const all = scopes.flat(), out = [], seen = new Set();
  for (let i = all.length - 1; i >= 0; i--) if (!seen.has(all[i].name)) { seen.add(all[i].name); out.unshift(all[i]); }
  return out;
}
/** A marker statement for the variables visible at this point. */
function marker(line, scope) {
  const fields = [];
  for (const variable of scope) fields.push(...fieldsOf(variable));
  const format = [MARK + '%d'].concat(fields.map(f => f.kind + ':' + f.label + '=' + f.fmt)).join('|');
  const args = [String(line)].concat(fields.map(f => f.expr));
  return 'if(__ws_steps++<' + STEP_CAP + ')printf("' + format + '\\n",' + args.join(',') + ');';
}

const BOUNDARY = /[;{}]\s*$/;
const CONTROL = /^(if|else|for|while|do|switch)\b/;
const SKIP = body => !body || body.startsWith('#') || body.startsWith('}') ||
  body.startsWith('else') || /^(case\b|default\s*:)/.test(body) ||
  body.startsWith('//') || body.startsWith('/*') || body.startsWith('*');

/**
 * Insert a marker before every statement that can be instrumented safely.
 *
 * A marker is only placed where the previous line already ended a statement, so
 * an un-braced control body ("if (x)\n  y();") is never split from its head —
 * doing that would silently change what the program does. The one case that is
 * safe to wrap is a single-line body, which is braced instead.
 */
export function instrument(source) {
  const lines = String(source || '').split('\n');
  const out = [];
  const scopes = [[]];
  let count = 0;
  let previous = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const body = raw.trim();
    const indent = (raw.match(/^\s*/) || [''])[0];
    const unbracedHead = /^(if|for|while)\b/.test(previous) && /\)\s*$/.test(previous);
    const boundary = previous === '' || BOUNDARY.test(previous);
    if (scopes.length > 1 && boundary && !SKIP(body) && !unbracedHead) {
      out.push(indent + marker(i + 1, visible(scopes)));
      count++;
    } else if (scopes.length > 1 && unbracedHead && !SKIP(body) && /;\s*$/.test(body)) {
      out.push(indent + '{ ' + marker(i + 1, visible(scopes)) + ' ' + body + ' }');
      count++;
      previous = body;
      continue;
    }
    out.push(raw);
    // An initialiser such as "= {1, 2, 3}" carries braces that are not a scope
    // and would inflate the depth, hiding the declaration itself.
    const structural = raw.replace(/=\s*\{[^}]*\}/g, '=0');
    const opens = (structural.match(/\{/g) || []).length;
    const closes = (structural.match(/\}/g) || []).length;
    for (let n = 0; n < opens; n++) scopes.push([]);
    for (let n = 0; n < closes; n++) if (scopes.length > 1) scopes.pop();
    const isFunctionHead = scopes.length === 1 && opens > 0 && /\(/.test(body);
    if (!isFunctionHead && opens === 0) {
      for (const variable of declarationsIn(body)) scopes[scopes.length - 1].push(variable);
    }
    // "for (int i = 0; ...)" declares its counter in the loop's own scope, and a
    // brace on the same line would otherwise hide it from the scan above.
    const header = raw.match(/\bfor\s*\(([^;]*);/);
    if (header) for (const variable of declarationsIn(header[1] + ';')) scopes[scopes.length - 1].push(variable);
    if (body) previous = body;
  }
  const text = out.join('\n');
  return { source: '#include <stdio.h>\nstatic int __ws_steps=0;\n' + text, count };
}

/** Split program output into replayed steps (line, live variables, output so far). */
export function parseTrace(stdout) {
  const steps = [];
  let output = '';
  for (const line of String(stdout || '').split('\n')) {
    const at = line.indexOf(MARK);
    if (at === 0) {
      const fields = line.slice(MARK.length).split('|');
      const variables = [];
      for (const field of fields.slice(1)) {
        const split = field.indexOf('=');
        if (split < 0) continue;
        const key = field.slice(0, split), value = field.slice(split + 1);
        const colon = key.indexOf(':');
        variables.push({ name: colon < 0 ? key : key.slice(colon + 1), kind: colon < 0 ? 'i' : key.slice(0, colon), value });
      }
      steps.push({ line: Number(fields[0]) || 0, vars: variables, output });
      continue;
    }
    output += line + '\n';
  }
  return { steps, finalOutput: output };
}

/**
 * Which recorded steps to play.
 *
 * A loop header runs once but its body is recorded once per iteration, so the
 * raw trace is full of steps that never leave the line they are on. "skip" mode
 * drops every step whose line matches the previously kept one, which collapses a
 * whole enumeration into the moves that actually change line.
 */
export function viewIndices(steps, mode) {
  if (mode !== 'skip') return steps.map((_, i) => i);
  const kept = [];
  for (let i = 0; i < steps.length; i++) {
    if (!kept.length || steps[i].line !== steps[kept[kept.length - 1]].line) kept.push(i);
  }
  return kept;
}

/** Variables that changed between two steps, by name. */
export function changedNames(previous, current) {
  if (!previous) return [];
  const before = new Map((previous.vars || []).map(v => [v.name, v.value]));
  return (current.vars || []).filter(v => before.get(v.name) !== v.value).map(v => v.name);
}

/** One plain sentence describing where the run is. */
export function describeStep(steps, index) {
  if (!steps.length) return '没有记录到任何执行步骤。';
  if (index >= steps.length) return '程序已结束。';
  return '第 ' + (index + 1) + ' / ' + steps.length + ' 步 · 第 ' + steps[index].line + ' 行';
}
