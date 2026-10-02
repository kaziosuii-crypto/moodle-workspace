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
const MARK_KINDS = ['STEP', 'CALL', 'RET', 'READ', 'NODE', 'FLAG'];
const MARK_PREFIXES = MARK_KINDS.map(kind => '__WS_' + kind + '__');
/** Markers share stdout with the program, so this both finds and separates them. */
const MARK_SPLIT = new RegExp('(__WS_(?:' + MARK_KINDS.join('|') + ')__[^\\n]*)', 'g');
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

/** Index just past the ")" that closes the "(" at `from`, or -1 when unbalanced. */
function matchParen(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** "arr[2][3]" -> the stars, the name, and the bracket groups. */
const ARRAY_DECL = /^\s*(\*+)?\s*([A-Za-z_]\w*)\s*((?:\[[^\]]*\])+)/;

/** Names and kinds declared by one line, or [] when it declares nothing usable. */
export function declarationsIn(line) {
  const body = line.trim();
  const match = body.match(SPECIFIER);
  if (!match) return [];
  const base = specifierOf(match[0]);
  if (!base) return [];
  const rest = body.slice(match[0].length).replace(/;\s*$/, '');
  if (!rest) return [];
  if (/\(/.test(rest.split('=')[0])) return [];          // a function, not a variable
  const out = [];
  for (const part of splitTop(rest, ',')) {
    const array = part.match(ARRAY_DECL);
    if (array) {
      // "const char *w[][4]" is an array whose elements are pointers: the '*' belongs
      // to the element type and must not make the whole thing look like an opaque
      // pointer, which is how a table of strings used to vanish from the panel.
      const dims = [...array[3].matchAll(/\[([^\]]*)\]/g)].map(m => Number(m[1].trim()) || 0);
      const pointer = !!array[1];
      // A char array is a string; a char* element array is an array of strings. Either
      // way the kind is 's', and the pointer flag is what tells the two apart.
      const kind = base.kind === 'c' ? 's' : base.kind;
      out.push({ name: array[2], kind, fmt: kind === 's' ? '%.40s' : base.fmt, dims, pointer,
        size: dims.length === 1 ? Math.min(dims[0], 8) : 0 });
      continue;
    }
    if (part.includes('*')) continue;                    // scalar pointers are left alone
    const name = part.match(/^\s*([A-Za-z_]\w*)/);
    if (!name) continue;
    out.push({ name: name[1], kind: base.kind, fmt: base.fmt, size: 0 });
  }
  return out;
}

/** How many items the initialiser starting at `open` lists at its top level. */
function countElements(text, open) {
  let depth = 0, items = 0, filled = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
      if (depth === 1 && !filled) { items++; filled = true; }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (c === '{') { if (depth === 1 && !filled) { items++; filled = true; } depth++; continue; }
    if (c === '}') { if (--depth === 0) break; continue; }
    if (c === ',') { if (depth === 1) filled = false; continue; }
    if (depth === 1 && !filled && !/\s/.test(c)) { items++; filled = true; }
  }
  return items;
}

/**
 * Sizes for arrays whose first dimension is written as [].
 *
 * "const char *w[][4] = {" gives the row width but not the row count; that comes from
 * the initialiser, which can be several lines further down. The source is scanned once so
 * the declaration can be given the shape it actually has.
 */
function arrayShapes(source) {
  const text = String(source || '');
  const shapes = new Map();
  const re = /([A-Za-z_]\w*)\s*((?:\[\s*\d*\s*\])+)\s*=\s*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const dims = [...match[2].matchAll(/\[\s*(\d*)\s*\]/g)].map(m => Number(m[1]) || 0);
    if (!dims.some(d => !d)) continue;
    if (!dims[0]) dims[0] = countElements(text, text.indexOf('{', re.lastIndex - 1));
    if (dims.some(d => !d)) continue;
    shapes.set(match[1], dims);
  }
  return shapes;
}

/** "int a" -> one printable field per name, arrays expanded element by element. */
function fieldsOf(variable) {
  // A pointer is a value like any other — it is the (void*) of its address, and
  // the UI draws it as an arrow to whatever lives there.
  if (variable.kind === 'p') return [{ label: variable.name, expr: '(void*)' + variable.name, kind: 'p', fmt: '%p' }];
  const dims = (variable.dims || []).map(d => Math.min(d, 8));
  // An unresolved size cannot be printed at all, and a very large one would flood every
  // single step with fields, so both are left out rather than guessed.
  if (dims.some(d => !d)) return [];
  if (dims.reduce((a, b) => a * b, 1) > 32) return [];
  if (!dims.length) return [{ label: variable.name, expr: variable.name, kind: variable.kind, fmt: variable.fmt }];
  // A char array is one string. Expanding it would print each element with %s,
  // i.e. dereference a char as a pointer.
  if (dims.length === 1 && variable.kind === 's' && !variable.pointer) {
    return [{ label: variable.name, expr: '__ws_esc(' + variable.name + ')', kind: 's', fmt: '%s' }];
  }
  const fields = [];
  const walk = (suffix, depth) => {
    if (depth === dims.length) {
      const ref = variable.name + suffix;
      // __ws_esc does two jobs: it protects %s from a NULL element, and it keeps a
      // newline or a '|' inside the text from splitting the marker line in half.
      fields.push(variable.kind === 's'
        ? { label: ref, expr: '__ws_esc(' + ref + ')', kind: 's', fmt: '%s' }
        : { label: ref, expr: ref, kind: variable.kind, fmt: variable.fmt });
      return;
    }
    for (let i = 0; i < dims[depth]; i++) walk(suffix + '[' + i + ']', depth + 1);
  };
  walk('', 0);
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
  // A pointer is read through its guard: reading one that the program never gave a value
  // to is undefined behaviour, and the compiler is right to warn about it. The guard is
  // in scope for every marker inside a function, which is the only place they exist.
  const args = [String(line)].concat(fields.map(f => f.kind === 'p'
    ? '(__ws_def_' + f.label + '?(void*)' + f.label + ':(void*)0)'
    : f.expr));
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
const STRUCT_DECL = /^\s*struct\s+([A-Za-z_]\w*)\s*\*/;
/**
 * Every pointer a "struct X *a, *b = ...;" statement declares.
 *
 * Reading only the first name meant "struct node *head = NULL, *p;" recorded the
 * head of the list but never the cursor that walks it - which for a linked list is
 * usually the variable the whole trace is about.
 */
function structPtrVars(body) {
  const head = body.match(STRUCT_DECL);
  if (!head) return [];
  const out = [];
  splitTop(body.slice(head[0].length), ',').forEach((part, i) => {
    // The leading '*' was consumed by the match, so only later declarators carry one.
    const name = i ? part.match(/^\s*\*+\s*([A-Za-z_]\w*)/) : part.match(/^\s*([A-Za-z_]\w*)/);
    if (name) out.push({ name: name[1], kind: 'p', struct: head[1], size: 0, init: /^\s*=/.test(part.slice(name[0].length)) });
  });
  return out;
}

function addStructFields(def, text) {
  for (const part of splitTop(text, ';')) {
    const body = part.trim();
    if (!body) continue;
    // "struct node *left, *right;" declares two links, not one - a tree lost both.
    const links = structPtrVars(body);
    if (links.length) { for (const l of links) def.fields.push({ name: l.name, kind: 'p', target: l.struct }); continue; }
    if (body.includes('*')) continue;
    // An array field would decay to a pointer and be printed with %d, so it is left out
    // of the walker rather than printed as garbage.
    for (const v of declarationsIn(body + ';')) if (!v.dims || !v.dims.length) def.fields.push({ name: v.name, kind: v.kind, fmt: v.fmt, size: v.size });
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
    // Memory that has been handed back is not the node it used to be.
    out += '  if(__ws_freed_has((void*)__ws_p))return;\n';
    // A node already visited on this walk means a cycle; a target that was never
    // seen as a pointer value is not followed at all, so an uninitialised link
    // can never be dereferenced.
    out += '  for(__ws_i=0;__ws_i<__ws_seen_n;__ws_i++)if(__ws_seen[__ws_i]==(void*)__ws_p)return;\n';
    out += '  if(__ws_seen_n<128)__ws_seen[__ws_seen_n++]=(void*)__ws_p;\n';
    out += '  printf("__WS_NODE__' + name + '|%p", (void*)__ws_p);\n';
    for (const f of def.fields) {
      if (f.kind === 'p') out += '  printf("|p:' + f.name + '=%p", (void*)__ws_p->' + f.name + ');\n';
      else if (f.kind === 's') out += '  printf("|s:' + f.name + '=%s", __ws_esc(__ws_p->' + f.name + '));\n';
      else out += '  printf("|' + f.kind + ':' + f.name + '=' + f.fmt + '", __ws_p->' + f.name + ');\n';
    }
    out += '  printf("\\n");\n';
    for (const l of links) out += '  if(__ws_known_has((void*)__ws_p->' + l.name + '))__ws_walk_' + name + '(__ws_p->' + l.name + ', __ws_d + 1);\n';
    out += '}\n';
  }
  return out;
}

/**
 * Count block braces on one line, ignoring the braces of an initialiser.
 *
 * "const char *w[][4] = {" / "  {\"a\",\"1\"}," / "};" spans three lines. Counting its
 * braces as block braces pushed a scope that never matched its pop, and - worse - the
 * marker written before the first row landed *inside* the braces, so the instrumented
 * source no longer compiled at all. `depth` carries how deep inside an initialiser the
 * previous line left us, so those lines get no marker and no scope.
 */
function scanBraces(line, depth) {
  let opens = 0, closes = 0, quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      continue;
    }
    if (c === '=' && /^\s*\{/.test(line.slice(i + 1))) {
      // Skip the '=' and the '{' that opens the initialiser: the depth already counts
      // that brace, and consuming it twice left the line ending still one level deep.
      i = line.indexOf('{', i);
      depth = 1;
      continue;
    }
    if (c === '{') opens++;
    else if (c === '}') closes++;
  }
  return { depth, opens, closes };
}
const FUNCTION = /^([A-Za-z_][\w \t\*]*?)([\s\*]+)([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?\s*$/;

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
  const shapes = arrayShapes(source);
  /** Fill in a "[]" first dimension from the source's initialiser. */
  const resolveShape = variable => {
    if (!variable.dims || !variable.dims.some(d => !d)) return variable;
    const known = shapes.get(variable.name);
    if (!known) return variable;
    return { ...variable, dims: known, size: known.length === 1 ? Math.min(known[0], 8) : 0 };
  };
  const out = [];
  /**
   * Instrumented line -> the line of the user's file it came from, 0 for generated.
   *
   * The trace compiles the instrumented source, so a compiler warning would otherwise
   * point at a line number the editor does not have — or at one of our own helpers.
   */
  const lineMap = [0];
  const add = (text, at) => { out.push(text); lineMap.push(at || 0); };
  const scopes = [[]];
  /**
   * The per-step snippet that remembers and draws every struct pointer in scope.
   *
   * Every address a pointer has ever held is remembered, so a chain can be followed
   * safely later: only known-good addresses are ever dereferenced. The guard matters
   * because an unassigned "struct node *p;" holds whatever the stack had there, and
   * walking that would dereference garbage.
   */
  const walkCode = scope => {
    const all = scope.filter(v => v.kind === 'p');
    if (!all.length) return '';
    // A pointer with its guard down holds whatever the stack had there — a number the
    // program never chose. Naming that beats printing it as if it were an address.
    const flags = all.map(v =>
      'if(__ws_def_' + v.name + '){if(__ws_freed_has((void*)' + v.name + '))printf("__WS_FLAG__f:' + v.name + '=1\\n");}' +
      'else printf("__WS_FLAG__w:' + v.name + '=1\\n");').join('');
    const here = all.filter(v => walkable.has(v.struct));
    if (!here.length) return flags;
    return flags + '__ws_seen_n=0;' + here.map(v =>
      'if(__ws_def_' + v.name + '){__ws_known_add((void*)' + v.name + ');__ws_walk_' + v.struct + '(' + v.name + ',0);}').join('');
  };
  let count = 0;
  let previous = '';
  // A "for" head that declares its counter and has no brace on the same line: the
  // counter belongs to the loop statement, so it is parked here until the body is
  // emitted and then handed to that body's scope instead of the enclosing one.
  let pendingFor = [], pendingForSet = -1, inlineFor = null;
  // A head written Allman-style ("static void f(void)" then "{" on the next line) has
  // no brace on its own line, so it has to be held here until that brace shows up.
  let pendingHead = null;
  // How deep inside a multi-line initialiser the previous line left us.
  let initDepth = 0;
  /** Open a function's body scope, declare its parameters, and announce the call. */
  const enterFunction = (fn, headIndent, at) => {
    functionBase = braceDepth;
    // The stars belong to the return type, and a pointer return has no safe printf
    // format, so only its exit is marked.
    const retType = (fn[1] + fn[2]).trim();
    currentFunction = { name: fn[3], ret: /\*/.test(retType) ? null : specifierOf(retType) };
    for (const part of splitTop(fn[4], ',')) {
      const param = part.trim();
      for (const variable of declarationsIn(param + ';')) scopes[scopes.length - 1].push(variable);
      // A struct pointer parameter is a real graph node - for a recursive tree walk
      // it is the only thing that shows which subtree the call is working on.
      for (const variable of structPtrVars(param)) scopes[scopes.length - 1].push(variable);
    }
    const scope = scopes[scopes.length - 1];
    // A parameter always holds a value the caller supplied, so its guard starts up.
    for (const variable of scope) if (variable.kind === 'p') add(headIndent + '  int __ws_def_' + variable.name + '=1;', at);
    // fieldsOf, not the variable itself: a pointer has no fmt of its own, and that
    // undefined format is what a pointer parameter used to put straight into printf.
    const fields = scope.flatMap(v => fieldsOf(v));
    add(headIndent + '  printf("__WS_CALL__%s' + (fields.length ? '|' + fields.map(f => f.kind + ':' + f.label + '=' + f.fmt).join('|') : '') + '\\n","' + fn[3] + '"' +
      (fields.length ? ',' + fields.map(f => f.expr).join(',') : '') + ');', at);
  };
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
    // initDepth is the depth the previous line left behind: a row of a multi-line
    // initialiser must never get a marker, or the braces it sits between stop balancing.
    if (functionBase !== null && boundary && !SKIP(body) && !unbracedHead && initDepth === 0) {
      add(indent + marker(i + 1, visible(scopes)), i + 1);
      count++;
      // Reads are recorded separately so the UI can light up the exact array cell.
      const inScope = new Set(visible(scopes).map(v => v.name));
      for (const variable of visible(scopes)) {
        if (!variable.size) continue;
        const subscript = new RegExp('\\b' + variable.name + '\\s*\\[([^\\]]+)\\]', 'g');
        let hit;
        while ((hit = subscript.exec(body))) {
          const index = hit[1].trim();
          if (/[+-]{2}|=/.test(index)) continue;
          // "for (int i = 0; i < n; i++) sum += a[i];" - i is not in scope until the
          // loop starts, so recording this read here would not even compile.
          if ((index.match(/[A-Za-z_]\w*/g) || []).some(n => !inScope.has(n))) continue;
          add(indent + 'printf("__WS_READ__%s|%d\\n","' + variable.name + '",(' + index + '));', i + 1);
        }
      }
      const walks=walkCode(visible(scopes));
      if(walks)add(indent + walks, i + 1);
      if (currentFunction && currentFunction.ret && /^return\b/.test(body)) {
        const value = body.replace(/^return\b/, '').replace(/;\s*$/, '').trim();
        if (value) {
          add(indent + 'printf("__WS_RET__%s|ret=' + currentFunction.ret.fmt + '\\n","' + currentFunction.name + '",(' + value + '));', i + 1);
        }
      } else if (currentFunction && !currentFunction.ret && /^return\b/.test(body)) {
        add(indent + 'printf("__WS_RET__%s\\n","' + currentFunction.name + '");', i + 1);
      }
    } else if (functionBase !== null && unbracedHead && !SKIP(body) && /;\s*$/.test(body)) {
      // These wrapper braces are this statement's scope, which is where a counter
      // declared by the loop head has to live.
      const scope = scopes[scopes.length - 1];
      for (const variable of pendingFor) scope.push(variable);
      add(indent + '{ ' + marker(i + 1, visible(scopes)) + ' ' + body + ' }', i + 1);
      count++;
      for (const variable of pendingFor) scope.pop();
      pendingFor = [];
      previous = body;
      continue;
    }
    // "for (int i = 0; i < n; i++) work(i);" would hide the whole loop from the trace,
    // and the counter it declares belongs to the loop - left in the enclosing scope,
    // every later marker would name a variable that is already gone. Braces around the
    // body fix both and cannot change what the loop does.
    let emit = raw;
    if (functionBase !== null && !unbracedHead && body.slice(0, 3) === 'for') {
      const open = body.indexOf('(');
      const close = open < 0 ? -1 : matchParen(body, open);
      if (close > 0 && !/[{}]/.test(body.slice(0, close))) {
        const tail = body.slice(close).trim();
        const head = body.match(/\bfor\s*\(([^;]*);/);
        const decls = head ? declarationsIn(head[1] + ';') : [];
        if (decls.length && tail.slice(-1) === ';') {
          inlineFor = decls;
          count++;
          const bodyScope = visible(scopes.concat([decls]));
          emit = indent + body.slice(0, close) + ' { ' + marker(i + 1, bodyScope) + walkCode(bodyScope) + ' ' + tail + ' }';
        }
      }
    }
    add(emit, i + 1);
    // Shadow state for the guard above: raised the moment the pointer is known to
    // hold something the program put there. A declarator without an initialiser
    // starts lowered, and any later assignment raises it.
    if (functionBase !== null) {
      const declared = structPtrVars(body);
      if (declared.length) {
        for (const variable of declared) add(indent + 'int __ws_def_' + variable.name + '=' + (variable.init ? 1 : 0) + ';', i + 1);
      } else {
        for (const variable of visible(scopes).filter(v => v.kind === 'p')) {
          const assigned = new RegExp('(?:^|[;{}(,]\\s*)' + variable.name + '\\s*=(?!=)');
          // A fresh value can be the allocator handing the same address back, so the
          // "this was freed" label has to be dropped the moment the pointer is reassigned.
          if (assigned.test(body)) add(indent + '__ws_def_' + variable.name + '=1;__ws_freed_del((void*)' + variable.name + ');', i + 1);
        }
      }
      // free(p) leaves p aimed at memory the allocator may hand out again. The walker
      // refuses to enter a freed address, and the UI names that instead of drawing the
      // stale contents as if they were still the node.
      for (const call of body.match(/\bfree\s*\(\s*[A-Za-z_]\w*\s*\)/g) || []) {
        const name = /\bfree\s*\(\s*([A-Za-z_]\w*)\s*\)/.exec(call)[1];
        if (visible(scopes).some(v => v.kind === 'p' && v.name === name)) add('__ws_freed_add((void*)' + name + ');', i + 1);
      }
    }
    // An initialiser such as "= {1, 2, 3}" carries braces that are not a scope
    // and would inflate the depth, hiding the declaration itself.
    // Must run before the marker decision below is used for the next line, and it is what
    // keeps the rows of a multi-line initialiser from being mistaken for block scopes.
    const scan = scanBraces(raw, initDepth);
    const opens = scan.opens, closes = scan.closes;
    initDepth = scan.depth;
    // Depth before this line opens its brace: a function header is a top-level
    // line that opens a block and names a parameter list.
    const isFunctionHead = braceDepth === 0 && opens > 0 && /\(/.test(body);
    for (let n = 0; n < opens; n++) scopes.push([]);
    for (let n = 0; n < closes; n++) if (scopes.length > 1) scopes.pop();
    // The body of an un-braced loop head is the next line; when that line opens a
    // brace, the counter belongs inside it so that it dies with the block.
    if (opens > 0 && pendingFor.length) { scopes[scopes.length - 1].push(...pendingFor); pendingFor = []; }
    braceDepth += opens - closes;
    if (functionBase !== null && braceDepth < functionBase) functionBase = null;
    if (!isFunctionHead && opens === 0) {
      for (const variable of declarationsIn(body)) scopes[scopes.length - 1].push(resolveShape(variable));
    }
    // "struct node* p" is a pointer, not a value: it is shown as a graph node.
    if (functionBase !== null) for (const variable of structPtrVars(body)) scopes[scopes.length - 1].push(variable);
    // "for (int i = 0; ...)" declares its counter in the loop's own scope, and a
    // brace on the same line would otherwise hide it from the scan above.
    const header = raw.match(/\bfor\s*\(([^;]*);/);
    if (header && !inlineFor) for (const variable of declarationsIn(header[1] + ';')) {
      if (opens > 0) scopes[scopes.length - 1].push(variable);
      else { pendingFor.push(variable); pendingForSet = i; }
    }
    // A function header both opens the body's scope and declares its parameters. When
    // the brace is on the next line the head is parked here and registered the moment
    // that brace arrives; treating it as file scope instead left the whole body with no
    // markers at all, which is exactly the "no statements to step through" report.
    const sameLineHead = isFunctionHead ? body.match(FUNCTION) : null;
    if (sameLineHead) enterFunction(sameLineHead, indent, i + 1);
    else if (pendingHead) { if (opens > 0) enterFunction(pendingHead.fn, pendingHead.indent, pendingHead.line); pendingHead = null; }
    else if (braceDepth === 0 && opens === 0 && /[)]\s*$/.test(body) && FUNCTION.test(body)) pendingHead = { fn: body.match(FUNCTION), indent, line: i + 1 };
    // A counter parked for a body that never arrived would leak into whatever block is
    // emitted next; dropping it is the safe direction.
    if (pendingFor.length && pendingForSet !== i) { pendingFor = []; pendingForSet = -1; }
    inlineFor = null;
    if (body) previous = body;
  }
  // The walker bodies dereference struct fields, so they go after the user's
  // struct definitions; the prototypes only need a forward declaration.
  const names = [...walkable];
  const body = out.join('\n');
  const walkers = walkerSource(structs);
  // A string can contain a newline, and a marker line cut in half by one spills its tail
  // into the program's own output. The escape helper goes in only when something prints a
  // string, so an unused static function never trips -Wall on a program that has none.
  const escapeHelper = body.includes('__ws_esc(') || walkers.includes('__ws_esc(') ? [
  "static char __ws_eb[32][96];",
  "static int __ws_en=0;",
  "static const char* __ws_esc(const char* __ws_s){",
  "  char* __ws_b=__ws_eb[__ws_en++&31];",
  "  int __ws_i=0,__ws_o=0;",
  "  if(!__ws_s)__ws_s=\"(null)\";",
  "  while(__ws_s[__ws_i]&&__ws_i<40&&__ws_o<94){",
  "    unsigned char __ws_c=(unsigned char)__ws_s[__ws_i++];",
  "    if(__ws_c=='\\n'){__ws_b[__ws_o++]='\\\\';__ws_b[__ws_o++]='n';}",
  "    else if(__ws_c=='\\r'){__ws_b[__ws_o++]='\\\\';__ws_b[__ws_o++]='r';}",
  "    else if(__ws_c=='|'){__ws_b[__ws_o++]='\\\\';__ws_b[__ws_o++]='p';}",
  "    else if(__ws_c=='\\\\'){__ws_b[__ws_o++]='\\\\';__ws_b[__ws_o++]='\\\\';}",
  "    else __ws_b[__ws_o++]=(char)__ws_c;",
  "  }",
  "  __ws_b[__ws_o]=0;",
  "  return __ws_b;",
  "}"
  ] : [];
  const helpers = [
  ...escapeHelper,
    'static void* __ws_known[1024];',
    'static int __ws_known_n=0;',
    'static void __ws_known_add(void* __ws_p){int __ws_i;if(!__ws_p)return;for(__ws_i=0;__ws_i<__ws_known_n;__ws_i++)if(__ws_known[__ws_i]==__ws_p)return;if(__ws_known_n<1024)__ws_known[__ws_known_n++]=__ws_p;}',
    'static int __ws_known_has(void* __ws_p){int __ws_i;if(!__ws_p)return 0;for(__ws_i=0;__ws_i<__ws_known_n;__ws_i++)if(__ws_known[__ws_i]==__ws_p)return 1;return 0;}',
    'static void* __ws_seen[128];',
    'static int __ws_seen_n=0;',
    'static void* __ws_freed[256];',
    'static int __ws_freed_n=0;',
    'static void __ws_freed_add(void* __ws_p){int __ws_i;if(!__ws_p)return;for(__ws_i=0;__ws_i<__ws_freed_n;__ws_i++)if(__ws_freed[__ws_i]==__ws_p)return;if(__ws_freed_n<256)__ws_freed[__ws_freed_n++]=__ws_p;}',
    'static void __ws_freed_del(void* __ws_p){int __ws_i;if(!__ws_p)return;for(__ws_i=0;__ws_i<__ws_freed_n;__ws_i++)if(__ws_freed[__ws_i]==__ws_p){__ws_freed[__ws_i]=__ws_freed[--__ws_freed_n];return;}}',
    'static int __ws_freed_has(void* __ws_p){int __ws_i;if(!__ws_p)return 0;for(__ws_i=0;__ws_i<__ws_freed_n;__ws_i++)if(__ws_freed[__ws_i]==__ws_p)return 1;return 0;}'
  ].join('\n');
  const prologue = names.map(n => 'struct ' + n + ';').join('\n') + '\n' + helpers + '\n' +
    names.map(n => 'static void __ws_walk_' + n + '(struct ' + n + '*, int);').join('\n');
  const head = '#include <stdio.h>\nstatic int __ws_steps=0;\n' + prologue + '\n';
  const headLines = head.split('\n').length - 1;
  const output = head + body + '\n' + walkers;
  // Padded to the whole file so a diagnostic on any line can be looked up without a
  // bounds check; generated lines (helpers, walkers) stay 0 and are dropped.
  const places = new Array(output.split('\n').length + 1).fill(0);
  for (let k = 1; k < lineMap.length; k++) if (lineMap[k]) places[headLines + k] = lineMap[k];
  return { source: output, count, lineMap: places };
}

/** Split program output into replayed steps (line, live variables, output so far). */
/**
 * Undo the marker escapes. "\\n" is deliberately left as text: that is how the C source
 * wrote it, and it reads better in a chip than a real newline would.
 */
function unescapeField(value) {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') { out += value[i]; continue; }
    const next = value[++i];
    out += next === '\\' ? '\\' : next === 'p' ? '|' : '\\' + (next ?? '');
  }
  return out;
}
/** "i:n=3" -> { name:'n', kind:'i', value:'3' } */
function parseField(field) {
  const split = field.indexOf('=');
  if (split < 0) return null;
  const key = field.slice(0, split), value = unescapeField(field.slice(split + 1));
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
  let out = '';
  let dropNewline = false;
  let last = null;
  // Markers share stdout with the program, so a printf without a trailing newline leaves
  // the next marker in the middle of a line. Splitting whole lines therefore missed it and
  // the marker text was printed as if the program had written it. Split on markers
  // wherever they appear instead: every marker prints its own newline, so dropping that
  // newline together with the marker is what keeps the program's output byte-identical.
  const pieces = String(stdout || '').split(MARK_SPLIT);
  for (const piece of pieces) {
    if (!piece) continue;
    const isMarker = MARK_PREFIXES.some(prefix => piece.startsWith(prefix));
    if (!isMarker) {
      if (dropNewline) { dropNewline = false; out += piece[0] === '\n' ? piece.slice(1) : piece; }
      else out += piece;
      continue;
    }
    dropNewline = true;
    const line = piece;
    if (line.startsWith(MARK)) {
      const fields = line.slice(MARK.length).split('|');
      steps.push({ line: Number(fields[0]) || 0, vars: fields.slice(1).map(parseField).filter(Boolean), output: out, stack: stack.map(f => f.name), reads: [], returns: [], nodes: [] });
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
    // "this pointer was never given a value" / "this pointer was freed" rides with the
    // step it describes, so it reaches the UI as a property of the variable itself.
    if (line.startsWith('__WS_FLAG__')) {
      const flag = parseField(line.slice(11));
      const variable = flag && last && (last.vars || []).find(v => v.name === flag.name);
      if (variable) { if (flag.kind === 'w') variable.wild = true; else if (flag.kind === 'f') variable.freed = true; }
      continue;
    }
    if (line.startsWith('__WS_READ__')) {
      const body = line.slice(11), bar = body.indexOf('|');
      if (last && bar > 0) last.reads.push({ name: body.slice(0, bar), index: Number(body.slice(bar + 1)) });
      continue;
    }
    // 走到这里说明前缀和具体分支对不上，丢掉总比把 marker 当成程序输出安全。
  }
  return { steps, finalOutput: out };
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

/**
 * The raw steps a jump passes over.
 *
 * "skip" mode collapses every repeat of a line, so a single click can hide dozens of raw
 * steps - the loop iterations that failed a condition, the calls that did nothing. Handing
 * them to the player is what lets it show what went past instead of silently teleporting.
 */
export function skippedSteps(steps, from, to) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (hi - lo < 2 || !steps.length) return [];
  const out = [];
  for (let raw = lo + 1; raw < hi; raw++) out.push({ raw, step: steps[raw] });
  return out;
}

/** One plain sentence describing where the run is. */
export function describeStep(steps, index) {
  if (!steps.length) return '没有记录到任何执行步骤。';
  if (index >= steps.length) return '程序已结束。';
  return '第 ' + (index + 1) + ' / ' + steps.length + ' 步 · 第 ' + steps[index].line + ' 行';
}
