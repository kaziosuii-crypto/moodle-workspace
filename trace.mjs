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
    const tail = part.slice(name[0].length);
    if (name[2] !== undefined) {
      // "int arr[]" has no known length, and "int grid[2][3]" would print the
      // inner row (a pointer) as a number. Both are dropped rather than guessed.
      if (!name[2].trim()) continue;
      if (/^\s*\[/.test(tail)) continue;
      out.push({ name: name[1], kind: base.kind === 'c' ? 's' : base.kind, fmt: base.kind === 'c' ? '%.40s' : base.fmt, size: Math.min(Number(name[2].trim()) || 0, 8) });
    } else out.push({ name: name[1], kind: base.kind, fmt: base.fmt, size: 0 });
  }
  return out;
}

/** "int a" -> one printable field per name, arrays expanded element by element. */
function fieldsOf(variable) {
  // A pointer is a value like any other — it is the (void*) of its address, and
  // the UI draws it as an arrow to whatever lives there.
  if (variable.kind === 'p') return [{ label: variable.name, expr: '(void*)' + variable.name, kind: 'p', fmt: '%p' }];
  if (!variable.size) return [{ label: variable.name, expr: variable.name, kind: variable.kind, fmt: variable.fmt }];
  // A char array is one string. Expanding it would print each element with %s,
  // i.e. dereference a char as a pointer.
  if (variable.kind === 's') return [{ label: variable.name, expr: variable.name, kind: 's', fmt: '%.40s' }];
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

/**
 * Struct support.
 *
 * Pointer-to-struct fields are what make a linked list or a tree readable, so the
 * file's struct definitions are scanned first. For every struct that points to
 * itself a walker is generated that prints each node's address, its fields and
 * where each link goes; the UI turns those addresses into arrows.
 */
const STRUCT_OPEN = /^\s*struct\s+([A-Za-z_]\w*)\s*\{/;
const STRUCT_PTR_VAR = /^\s*struct\s+([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)\s*(?:=|;|,|\))/;

function addStructFields(def, text) {
  for (const part of splitTop(text, ';')) {
    const body = part.trim();
    if (!body) continue;
    const link = body.match(/^struct\s+([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)$/);
    if (link) { def.fields.push({ name: link[2], kind: 'p', target: link[1] }); continue; }
    if (body.includes('*')) continue;
    for (const v of declarationsIn(body + ';')) def.fields.push({ name: v.name, kind: v.kind, fmt: v.fmt, size: v.size });
  }
}

export function structDefs(source) {
  const structs = new Map();
  let current = null;
  for (const raw of String(source || '').split('\n')) {
    const line = raw.trim();
    if (!current) {
      const open = line.match(STRUCT_OPEN);
      if (!open) continue;
      current = { name: open[1], fields: [] };
      const rest = line.slice(line.indexOf('{') + 1);
      // A one-line struct still has fields to read, up to its closing brace.
      if (rest.includes('}')) { addStructFields(current, rest.slice(0, rest.indexOf('}'))); structs.set(current.name, current); current = null; }
      else addStructFields(current, rest);
      continue;
    }
    if (line.startsWith('}')) { structs.set(current.name, current); current = null; continue; }
    addStructFields(current, line);
  }
  return structs;
}

/** One C function per self-referential struct that prints every reachable node. */
function walkerSource(structs) {
  let out = '';
  for (const [name, def] of structs) {
    const links = def.fields.filter(f => f.kind === 'p' && f.target === name);
    if (!links.length) continue;
    out += 'static void __ws_walk_' + name + '(struct ' + name + '* __ws_p, int __ws_d){\n';
    // Only the node a variable actually points at is read. Following the links
    // would dereference whatever happens to be in them, and an uninitialised
    // "next" would crash a program that runs fine without instrumentation.
    out += '  int __ws_i;\n';
    out += '  if(!__ws_p || __ws_d > 64 || __ws_steps > ' + STEP_CAP + ')return;\n';
    // A node already visited on this walk means a cycle; a target that was never
    // seen as a pointer value is not followed at all, so an uninitialised link
    // can never be dereferenced.
    out += '  for(__ws_i=0;__ws_i<__ws_seen_n;__ws_i++)if(__ws_seen[__ws_i]==(void*)__ws_p)return;\n';
    out += '  if(__ws_seen_n<128)__ws_seen[__ws_seen_n++]=(void*)__ws_p;\n';
    out += '  printf("__WS_NODE__' + name + '|%p", (void*)__ws_p);\n';
    for (const f of def.fields) {
      if (f.kind === 'p') out += '  printf("|p:' + f.name + '=%p", (void*)__ws_p->' + f.name + ');\n';
      else if (f.kind === 's') out += '  printf("|s:' + f.name + '=%.24s", __ws_p->' + f.name + ');\n';
      else out += '  printf("|' + f.kind + ':' + f.name + '=' + f.fmt + '", __ws_p->' + f.name + ');\n';
    }
    out += '  printf("\\n");\n';
    for (const l of links) out += '  if(__ws_known_has((void*)__ws_p->' + l.name + '))__ws_walk_' + name + '(__ws_p->' + l.name + ', __ws_d + 1);\n';
    out += '}\n';
  }
  return out;
}

/** "int isPrime(int n) {" -> return type, name, parameter list. */
function structuralOf(line) {
  let out = '', i = 0, init = -1, quote = '';
  while (i < line.length) {
    const c = line[i];
    if (quote) { out += c; if (c === '\\') { i += 2; continue; } if (c === quote) quote = ''; i++; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    if (init >= 0) {
      if (c === '{') init++;
      else if (c === '}' && --init === 0) { out += '0'; init = -1; i++; continue; }
      i++; continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '=' && /^\s*\{/.test(line.slice(i + 1))) { init = 0; out += '='; i++; continue; }
    out += c; i++;
  }
  return out;
}
const FUNCTION = /^([A-Za-z_][\w \t\*]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?\s*$/;

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
  const structs = structDefs(source);
  const walkable = new Set([...structs].filter(([, d]) => d.fields.some(f => f.kind === 'p' && f.target === d.name)).map(([n]) => n));
  const out = [];
  const scopes = [[]];
  let count = 0;
  let previous = '';
  let currentFunction = null;
  // Instrumentation is only valid inside a function body. A struct / union / enum
  // definition also opens a brace at file scope, so brace count alone cannot tell
  // them apart — the depth of the enclosing function is tracked explicitly.
  let braceDepth = 0, functionBase = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const body = raw.trim();
    const indent = (raw.match(/^\s*/) || [''])[0];
    const unbracedHead = /^(if|for|while)\b/.test(previous) && /\)\s*$/.test(previous);
    const boundary = previous === '' || BOUNDARY.test(previous);
    if (functionBase !== null && boundary && !SKIP(body) && !unbracedHead) {
      out.push(indent + marker(i + 1, visible(scopes)));
      count++;
      // Reads are recorded separately so the UI can light up the exact array cell.
      for (const variable of visible(scopes)) {
        if (!variable.size) continue;
        const subscript = new RegExp('\\b' + variable.name + '\\s*\\[([^\\]]+)\\]', 'g');
        let hit;
        while ((hit = subscript.exec(body))) {
          const index = hit[1].trim();
          if (/[+-]{2}|=/.test(index)) continue;
          out.push(indent + 'printf("__WS_READ__%s|%d\\n","' + variable.name + '",(' + index + '));');
        }
      }
      const pointers=visible(scopes).filter(v=>v.kind==='p'&&walkable.has(v.struct));
      if(pointers.length)out.push(indent + '__ws_seen_n=0;');
      for (const variable of pointers) {
        // Every address a pointer has ever held is remembered, so a chain can be
        // followed safely later: only known-good addresses are ever dereferenced.
        out.push(indent + '__ws_known_add((void*)' + variable.name + ');');
        out.push(indent + '__ws_walk_' + variable.struct + '(' + variable.name + ',0);');
      }
      if (currentFunction && currentFunction.ret && /^return\b/.test(body)) {
        const value = body.replace(/^return\b/, '').replace(/;\s*$/, '').trim();
        if (value) {
          out.push(indent + 'printf("__WS_RET__%s|ret=' + currentFunction.ret.fmt + '\\n","' + currentFunction.name + '",(' + value + '));');
        }
      } else if (currentFunction && !currentFunction.ret && /^return\b/.test(body)) {
        out.push(indent + 'printf("__WS_RET__%s\\n","' + currentFunction.name + '");');
      }
    } else if (functionBase !== null && unbracedHead && !SKIP(body) && /;\s*$/.test(body)) {
      out.push(indent + '{ ' + marker(i + 1, visible(scopes)) + ' ' + body + ' }');
      count++;
      previous = body;
      continue;
    }
    out.push(raw);
    // An initialiser such as "= {1, 2, 3}" carries braces that are not a scope
    // and would inflate the depth, hiding the declaration itself.
    const structural = structuralOf(raw);
    const opens = (structural.match(/\{/g) || []).length;
    const closes = (structural.match(/\}/g) || []).length;
    // Depth before this line opens its brace: a function header is a top-level
    // line that opens a block and names a parameter list.
    const isFunctionHead = braceDepth === 0 && opens > 0 && /\(/.test(body);
    for (let n = 0; n < opens; n++) scopes.push([]);
    for (let n = 0; n < closes; n++) if (scopes.length > 1) scopes.pop();
    braceDepth += opens - closes;
    if (functionBase !== null && braceDepth < functionBase) functionBase = null;
    if (!isFunctionHead && opens === 0) {
      for (const variable of declarationsIn(body)) scopes[scopes.length - 1].push(variable);
    }
    // "struct node* p" is a pointer, not a value: it is shown as a graph node.
    const sv = functionBase !== null ? body.match(STRUCT_PTR_VAR) : null;
    if (sv) scopes[scopes.length - 1].push({ name: sv[2], kind: 'p', struct: sv[1], size: 0 });
    // "for (int i = 0; ...)" declares its counter in the loop's own scope, and a
    // brace on the same line would otherwise hide it from the scan above.
    const header = raw.match(/\bfor\s*\(([^;]*);/);
    if (header) for (const variable of declarationsIn(header[1] + ';')) scopes[scopes.length - 1].push(variable);
    // A function header both opens the body's scope and declares its parameters.
    const fn = !isFunctionHead ? null : body.match(FUNCTION);
    if (fn) {
      functionBase = braceDepth;
      // A pointer return type has no safe printf format, so only its exit is marked.
      currentFunction = { name: fn[2], ret: /\*/.test(fn[1]) ? null : specifierOf(fn[1]) };
      for (const part of splitTop(fn[3], ',')) {
        for (const variable of declarationsIn(part.trim() + ';')) scopes[scopes.length - 1].push(variable);
      }
      const scope = scopes[scopes.length - 1];
      const fields = scope.map(v => v.kind + ':' + v.name + '=' + v.fmt);
      out.push(indent + '  printf("__WS_CALL__%s' + (fields.length ? '|' + fields.join('|') : '') + '\\n","' + fn[2] + '"' +
        (scope.length ? ',' + scope.map(v => v.name).join(',') : '') + ');');
    }
    if (body) previous = body;
  }
  // The walker bodies dereference struct fields, so they go after the user's
  // struct definitions; the prototypes only need a forward declaration.
  const names = [...walkable];
  const helpers = [
    'static void* __ws_known[1024];',
    'static int __ws_known_n=0;',
    'static void __ws_known_add(void* __ws_p){int __ws_i;if(!__ws_p)return;for(__ws_i=0;__ws_i<__ws_known_n;__ws_i++)if(__ws_known[__ws_i]==__ws_p)return;if(__ws_known_n<1024)__ws_known[__ws_known_n++]=__ws_p;}',
    'static int __ws_known_has(void* __ws_p){int __ws_i;if(!__ws_p)return 0;for(__ws_i=0;__ws_i<__ws_known_n;__ws_i++)if(__ws_known[__ws_i]==__ws_p)return 1;return 0;}',
    'static void* __ws_seen[128];',
    'static int __ws_seen_n=0;'
  ].join('\n');
  const prologue = names.map(n => 'struct ' + n + ';').join('\n') + '\n' + helpers + '\n' +
    names.map(n => 'static void __ws_walk_' + n + '(struct ' + n + '*, int);').join('\n');
  return { source: '#include <stdio.h>\nstatic int __ws_steps=0;\n' + prologue + '\n' + out.join('\n') + '\n' + walkerSource(structs), count };
}

/** Split program output into replayed steps (line, live variables, output so far). */
/** "i:n=3" -> { name:'n', kind:'i', value:'3' } */
function parseField(field) {
  const split = field.indexOf('=');
  if (split < 0) return null;
  const key = field.slice(0, split), value = field.slice(split + 1);
  const colon = key.indexOf(':');
  return { name: colon < 0 ? key : key.slice(colon + 1), kind: colon < 0 ? 'i' : key.slice(0, colon), value };
}

/**
 * Replay the marker stream into steps.
 *
 * Enter/return markers are interleaved with the step markers, so walking them in
 * order rebuilds the call stack that was live at each step, and array reads are
 * attached to the step that performed them.
 */
export function parseTrace(stdout) {
  const steps = [];
  const stack = [];
  const lines = [];
  let last = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith(MARK)) {
      const fields = line.slice(MARK.length).split('|');
      steps.push({ line: Number(fields[0]) || 0, vars: fields.slice(1).map(parseField).filter(Boolean), output: lines.join('\n'), stack: stack.map(f => f.name), reads: [], returns: [], nodes: [] });
      last = steps[steps.length - 1];
      continue;
    }
    if (line.startsWith('__WS_CALL__')) {
      const body = line.slice(11), bar = body.indexOf('|');
      const name = bar < 0 ? body : body.slice(0, bar);
      stack.push({ name, args: (bar < 0 ? '' : body.slice(bar + 1)).split('|').map(parseField).filter(Boolean) });
      continue;
    }
    if (line.startsWith('__WS_RET__')) {
      const body = line.slice(10), bar = body.indexOf('|');
      const name = bar < 0 ? body : body.slice(0, bar);
      stack.pop();
      if (last) last.returns.push({ name, value: bar < 0 ? null : body.slice(bar + 1).replace(/^ret=/, '') });
      continue;
    }
    if (line.startsWith('__WS_NODE__')) {
      const body = line.slice(11), bar = body.indexOf('|');
      const parts = (bar < 0 ? '' : body.slice(bar + 1)).split('|');
      // A circular list walks forever; one entry per address is what gets drawn.
      if (last && !last.nodes.some(n => n.addr === parts[0])) last.nodes.push({
        type: bar < 0 ? body : body.slice(0, bar),
        addr: parts[0],
        fields: parts.slice(1).map(f => { const eq = f.indexOf('='); const key = f.slice(0, eq), c = key.indexOf(':'); return { name: c < 0 ? key : key.slice(c + 1), kind: c < 0 ? 'i' : key.slice(0, c), value: f.slice(eq + 1) }; })
      });
      continue;
    }
    if (line.startsWith('__WS_READ__')) {
      const body = line.slice(11), bar = body.indexOf('|');
      if (last && bar > 0) last.reads.push({ name: body.slice(0, bar), index: Number(body.slice(bar + 1)) });
      continue;
    }
    lines.push(line);
  }
  return { steps, finalOutput: lines.join('\n') };
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
  return changedValues(previous, current).map(c => c.name);
}

/** Value changes as {name, from, to} so the UI can show the transition, not just the result. */
export function changedValues(previous, current) {
  if (!previous) return [];
  const before = new Map((previous.vars || []).map(v => [v.name, v.value]));
  const out = [];
  for (const v of current.vars || []) {
    const from = before.get(v.name);
    if (from !== undefined && from !== v.value) out.push({ name: v.name, from, to: v.value, kind: v.kind });
  }
  return out;
}

/** One plain sentence describing where the run is. */
export function describeStep(steps, index) {
  if (!steps.length) return '没有记录到任何执行步骤。';
  if (index >= steps.length) return '程序已结束。';
  return '第 ' + (index + 1) + ' / ' + steps.length + ' 步 · 第 ' + steps[index].line + ' 行';
}
