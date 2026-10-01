import { llm } from './ai.mjs';

/**
 * Fast inline completion.
 *
 * The point is to guess the next line or two from what the code is doing, not to finish
 * a word — so the problem statement goes in with the surrounding code, and the answer is
 * asked for in the smallest possible shape: no prose, no code fences, and no restating of
 * anything already on screen. Latency is the whole feature, so the request is capped at a
 * couple of hundred tokens and streams back into the ghost text as it arrives.
 */
const MAX_PREFIX = 3600;
const MAX_SUFFIX = 400;
const MAX_STATEMENT = 500;
const MAX_LINES = 12;

const SYSTEM = '你是 C 语言的内联补全引擎。只输出要插入光标处的代码本身，不要解释、不要代码块标记、不要重复已有代码。';
const CUT = '…（前面略）';

/** The tail of a long string, so the prompt stays small and fast. */
function tail(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : CUT + text.slice(text.length - limit);
}

/** The head of a string, cut at a line boundary so the model sees whole statements. */
function head(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const line = cut.lastIndexOf('\n');
  return (line > limit * 0.6 ? cut.slice(0, line) : cut) + '\n' + CUT;
}

/**
 * The prompt.
 *
 * The code after the cursor goes in too: without it the model happily writes a block
 * that duplicates what is already there.
 */
export function copilotPrompt({ prefix, suffix, statement }) {
  const after = head(suffix, MAX_SUFFIX);
  return [
    statement.trim() ? '题目：' + String(statement).replace(/\s+/g, ' ').trim().slice(0, MAX_STATEMENT) : '',
    '下面是一段正在编写的 C 代码。<CURSOR> 是光标位置。',
    '只补全 <CURSOR> 处接下来的内容：通常一到三行，最多一整段。',
    '不要重复光标前已经写过的任何字符，也不要重复光标后已经存在的代码。',
    '直接输出要插入的代码，需要换行就换行；缩进用空格，与相邻代码保持一致。',
    '',
    '\u0060\u0060\u0060c',
    tail(prefix, MAX_PREFIX) + '<CURSOR>' + after,
    '\u0060\u0060\u0060'
  ].filter(part => part !== '').join('\n');
}

/**
 * Turn a raw model reply into exactly what should be inserted at the caret.
 *
 * Chat models reliably add a fence, and they reliably start by repeating the line they
 * were shown — inserting that verbatim would duplicate the code the user already typed.
 */
export function cleanSuggestion(raw, prefix, suffix) {
  let text = String(raw ?? '');
  text = text.replace(/^\s*\u0060\u0060\u0060[^\n]*\n?/, '').replace(/\n?\u0060\u0060\u0060[ \t]*$/, '');
  if (!text.trim()) return '';
  // The model was shown the current line; if it echoed it, only the remainder is new.
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const typed = line.trimStart();
  if (typed && text.startsWith(typed)) text = text.slice(typed.length);
  // Same for the text after the caret, when the model repeated it instead of skipping it.
  const following = suffix.split('\n')[0].trim();
  if (following && text.endsWith(following)) text = text.slice(0, -following.length);
  text = text.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  if (!text.trim()) return '';
  // A completion that runs longer than a screenful is slow and nearly always wrong.
  const lines = text.split('\n');
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : text;
}

/**
 * Whether the caret sits somewhere a continuation makes sense at all.
 *
 * Past the closing brace of the last function there is nothing to continue, and asking
 * anyway costs a request and drops grey text over empty space. Inside a function the
 * answer is always yes; at file scope only a half-written line is worth finishing.
 */
export function copilotWorthAsking(text, pos) {
  const source = String(text ?? '');
  const at = Math.max(0, Math.min(Number(pos) || 0, source.length));
  let depth = 0, quote = '', lineComment = false, blockComment = false;
  for (let i = 0; i < at; i++) {
    const c = source[i], next = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  if (depth > 0) return true;
  const typed = source.slice(source.lastIndexOf('\n', at - 1) + 1, at).trim();
  return typed !== '' && !/[;}]$/.test(typed);
}

/** One inline suggestion. Resolves to '' when the model had nothing to add. */
export async function suggest({ prefix, suffix, statement, signal, onDelta }) {
  let raw;
  try {
    raw = await llm(copilotPrompt({ prefix, suffix, statement }), {
      system: SYSTEM, maxTokens: 150, timeoutMs: 12000, signal, onDelta
    });
  } catch (error) {
    if (/未返回有效的文字内容/.test(String(error?.message || ''))) return '';
    throw error;
  }
  return cleanSuggestion(raw, prefix, suffix);
}
