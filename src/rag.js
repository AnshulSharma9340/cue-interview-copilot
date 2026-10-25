// Picks the parts of long documents that matter for the current question (BM25 over ~900-char chunks),
// so big PDFs fit the context budget instead of being cut off after the first pages.
const STOP = new Set('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with would you your'.split(' '));

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) || []).filter((t) => t.length > 1 && !STOP.has(t));

function chunk(text, size = 900, overlap = 150) {
  const paras = String(text).split(/\n\s*\n/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur);
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size)); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// docs: [{name, text}] -> text block of the best chunks within `budget` characters.
function selectContext(docs, query, budget) {
  const chunks = [];
  for (const d of docs) chunk(d.text).forEach((c, i) => chunks.push({ doc: d.name, i, text: c, toks: tokenize(c) }));
  if (!chunks.length) return '';
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  // Everything fits: keep documents whole and in order.
  if (total <= budget) return docs.map((d) => `### ${d.name}\n${d.text}`).join('\n\n');

  const q = [...new Set(tokenize(query))];
  const N = chunks.length;
  const avgLen = chunks.reduce((n, c) => n + c.toks.length, 0) / N || 1;
  const df = new Map();
  for (const c of chunks) for (const t of new Set(c.toks)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.4, b = 0.75;
  for (const c of chunks) {
    const tf = new Map();
    for (const t of c.toks) tf.set(t, (tf.get(t) || 0) + 1);
    c.score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      c.score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.toks.length) / avgLen)));
    }
    if (c.i === 0) c.score += 0.3; // document openings usually summarize
  }
  const picked = [];
  let used = 0;
  for (const c of [...chunks].sort((x, y) => y.score - x.score)) {
    if (used + c.text.length > budget) continue;
    picked.push(c);
    used += c.text.length;
  }
  picked.sort((x, y) => (x.doc === y.doc ? x.i - y.i : x.doc.localeCompare(y.doc)));
  return picked.map((c) => `### ${c.doc} (excerpt ${c.i + 1})\n${c.text}`).join('\n\n');
}

module.exports = { selectContext, tokenize };
