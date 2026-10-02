export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
export const text = el => (el?.textContent || '').replace(/\u00a0/g, ' ').trim();
export function safeURL(value, base) {
  if (!value) return '';
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
export function ioText(cell) {
  if (!cell) return '';
  const lines = [...cell.querySelectorAll('ol > li')];
  if (lines.length) return lines.map(li => li.textContent.replace(/\u00a0/g, ' ').replace(/↵$/, '\n')).join('');
  const copy = cell.cloneNode(true);
  copy.querySelectorAll('a,.helplink,script').forEach(n => n.remove());
  return text(copy).replace(/↵/g, '\n');
}
export function ioDisplay(value) {
  const s = String(value ?? '');
  if (!s) return '<span class="io-empty">（空）</span>';
  const endsWithLF = s.endsWith('\n');
  const parts = (endsWithLF ? s.slice(0, -1) : s).split('\n');
  return parts.map((line, i) => {
    const last = i === parts.length - 1;
    const showArrow = last ? endsWithLF : true;
    return `${esc(line)}${showArrow ? '<span class="io-eol" aria-label="换行">↵</span>' : ''}`;
  }).join('\n');
}
export function richContent(el, base) {
  if (!el) return '';
  const allowed = new Set('P BR DIV SPAN STRONG B EM I U SUB SUP PRE CODE UL OL LI TABLE THEAD TBODY TR TH TD BLOCKQUOTE H2 H3 H4 A IMG'.split(' '));
  function render(n) {
    if (n.nodeType === 3) return esc(n.textContent);
    if (n.nodeType !== 1 || ['SCRIPT', 'STYLE', 'IFRAME', 'FORM', 'INPUT', 'BUTTON'].includes(n.tagName)) return '';
    const children = [...n.childNodes].map(render).join('');
    if (!allowed.has(n.tagName)) return children;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') return '<br>';
    if (tag === 'img') {
      const src = safeURL(n.getAttribute('src'), base);
      return src ? `<img src="${esc(src)}" alt="${esc(n.getAttribute('alt') || '')}" loading="lazy">` : '';
    }
    if (tag === 'a') return `<a href="${esc(safeURL(n.getAttribute('href'), base))}" target="_blank" rel="noopener noreferrer">${children}</a>`;
    return `<${tag}>${children}</${tag}>`;
  }
  return [...el.childNodes].map(render).join('');
}
export function formatTime(value) {
  const match = value.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日.*?(\d{1,2}:\d{2})/);
  return match ? { date: `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, time: match[4] } : { date: value || '未设置', time: '' };
}
export function parseProblem(doc, url) {
  const root = doc.querySelector('.maincontent') || doc;
  const title = text(root.querySelector('h1.name,h1')) || text(doc.querySelector('title')).split(':').pop().trim();
  const description = root.querySelector('#description,.description');
  const timing = [...root.querySelectorAll('#time-table tr')].map(row => ({
    label: text(row.querySelector('th')), ...formatTime(text(row.querySelector('td')))
  }));
  const grade = text(root.querySelector('.grade'));
  const tests = [...root.querySelectorAll('#testcase-table tr')].flatMap(row => {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 2) return [];
    return [{ input: ioText(cells[0]), expected: ioText(cells[1]), time: text(cells[2]), memory: text(cells[3]), source: '公开样例' }];
  });
  const submit = [...doc.querySelectorAll('a[href]')].find(a => /\/submit\.php\?/.test(a.getAttribute('href')));
  return {
    title, html: richContent(description, url), statement: text(description),
    timing, score: grade.match(/成绩[:：]\s*([\d.]+)/)?.[1] || '',
    discount: grade.match(/折扣[:：]\s*([\d.]+)/)?.[1] || '',
    late: text(root.querySelector('#time-table p')).replace(/^允许迟交\s*[:：]\s*/, ''),
    tests, submitURL: submit ? safeURL(submit.getAttribute('href'), url) : ''
  };
}
export function parseNavigation(doc, url, currentTitle) {
  const select = [...doc.querySelectorAll('select')].find(s => [...s.options].some(o => /\/programming\/view.php/.test(o.value)));
  return select ? [...select.options].filter(o => /\/programming\/view.php/.test(o.value)).map(o => ({
    url: safeURL(o.value, url),
    title: /跳至/.test(o.textContent) ? currentTitle : text(o),
    current: /跳至/.test(o.textContent),
    group: text(o.parentElement.tagName === 'OPTGROUP' ? { textContent: o.parentElement.getAttribute('label') } : null)
  })) : [];
}
export function parseResult(doc, base) {
  const table = doc.querySelector('#test-result-detail-table');
  const rows = table ? [...table.querySelectorAll('tr')].slice(1).flatMap(row => {
    const c = [...row.children]; if (c.length < 13) return [];
    return [{
      no: text(c[0]), weight: text(c[1]), limit: text(c[2]), memoryLimit: text(c[3]),
      input: ioText(c[4]), expected: ioText(c[5]), actual: ioText(c[6]),
      error: ioText(c[7]), time: text(c[8]), memory: text(c[9]), exit: text(c[10]),
      passed: text(c[11]) === '是', verdict: text(c[12]),
      downloads: c.slice(4, 8).map(cell => [...cell.querySelectorAll('a[href]')].map(a => ({
        label: text(a), url: safeURL(a.getAttribute('href'), base)
      })))
    }];
  }) : [];
  const root = doc.querySelector('.maincontent,#region-main') || doc.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,select,nav,#header,#footer,.navbar,.tabtree').forEach(n => n.remove());
  const content = text(clone);
  const status = content.match(/当前状态[：:]\s*([^。]+。?)/)?.[1] || '';
  const compile = /编译失败|编译错误|Compile Error|\bCE:/.test(content);
  const submitId = [...root.querySelectorAll('a[submitid]')].map(a => a.getAttribute('submitid')).find(Boolean)
    || [...root.querySelectorAll('a[href]')].map(a => {
      try { const p = new URL(a.getAttribute('href'),base).searchParams; return p.get('submitid') || p.get('submit'); } catch { return null; }
    }).find(Boolean) || '';
  const blocks = compilerBlocks(doc);
  return {
    rows, submitId, passed: rows.filter(r => r.passed).length, total: rows.length,
    status, compile, blocks, pending: /等待|正在|队列|尚未/.test(status),
    message: compile ? compilerMessage(blocks, status) : status || '暂无判题记录',
    finished: rows.length > 0 || compile
  };
}

/** A gcc/clang diagnostic line, wherever the plugin happens to have printed it. */
const DIAGNOSTIC = /[\w./\\-]+\.(?:c|cc|cpp|cxx|h):\d+:(?:\d+:)?\s*(?:fatal error|error|warning|note):/;

/**
 * Every block of text on the result page that could be the compiler's output.
 *
 * The programming plugin has moved this text around between versions, and the page
 * also carries the statement and the I/O - which have their own <pre> elements. Reading
 * only the first <pre> in the main region is how "编译错误" ends up with no explanation,
 * so all of them are collected and the raw list travels with the result for the panel.
 */
function compilerBlocks(doc) {
  const seen = new Set(), blocks = [];
  const push = (value, where) => {
    const clean = String(value || '').replace(/\r\n/g, '\n').trim();
    if (!clean || clean.length > 200000 || seen.has(clean)) return;
    seen.add(clean);
    blocks.push({ where, value: clean });
  };
  doc.querySelectorAll('textarea').forEach(node => push(node.value, 'textarea'));
  doc.querySelectorAll('pre,code,.programming-output,.compile-output,#compilation-output,#compile-output').forEach(node => push(text(node), node.tagName.toLowerCase()));
  // Some themes print the diagnostics straight into a table cell or a bare div; those
  // leaves are only worth keeping when they actually talk about the build.
  doc.querySelectorAll('td,div').forEach(node => {
    if (node.children.length) return;
    const value = text(node);
    if (value.length > 4000 || !/error|错误|warning|警告|失败|\.[ch]:\d/.test(value)) return;
    push(value, node.tagName.toLowerCase());
  });
  push(text(doc.body), 'page');
  return blocks;
}

/** The block that actually looks like compiler output; the status is the last resort. */
function compilerMessage(blocks, status) {
  const diagnostic = blocks.find(b => DIAGNOSTIC.test(b.value));
  if (diagnostic) return diagnostic.value;
  const small = blocks.find(b => b.value.length <= 4000 && /error:|错误：|编译失败|编译错误/.test(b.value));
  if (small) return small.value;
  return status || '程序编译失败。';
}
