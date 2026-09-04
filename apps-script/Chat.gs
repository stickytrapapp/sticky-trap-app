/**
 * The Sticky Trap - app chat backend (STANDALONE Google Apps Script web app)
 * ---------------------------------------------------------------------------
 * Powers the "Ask us" chat panel in the app. The browser POSTs the conversation (plus the
 * customer's current tab and basket) here; this script grounds Claude in the knowledge base the
 * app publishes at https://thestickytrap.app/data/chat-kb.txt (built by Price Engine/make_chat_kb.py),
 * lets Claude ACT in the app through a few tools (add to basket, open a product, show the basket,
 * jump to a tab, open the quote form), and returns the reply plus the actions for the app to run.
 * The Anthropic key never leaves this script.
 *
 * Keep this its OWN Apps Script project (like the usage tracker) - do not merge it into the main
 * backend, whose deployments are tangled.
 *
 * ONE-TIME SETUP (~2 min)
 *   1) script.google.com -> New project -> rename it "Sticky Trap - Chat" -> paste this file over Code.gs.
 *   2) Project Settings (gear) -> Script Properties -> Add:  ANTHROPIC_API_KEY = sk-ant-...
 *      (optional overrides: MODEL, KB_URL, MAX_PER_HOUR - see DEFAULTS below)
 *   3) Ctrl+S - save BEFORE deploying; a deployment snapshots the last SAVED code.
 *   4) Deploy -> New deployment -> type Web app -> Execute as: Me . Who has access: Anyone -> Deploy.
 *      Authorize when prompted. Copy the .../exec URL.
 *   5) In index.html set  var CHAT_URL='<that /exec URL>';  commit + push (push = deploy).
 *   UPDATING LATER: paste the new code, Ctrl+S, Deploy -> Manage deployments -> pencil -> Version: New -> Deploy
 *   (the /exec URL stays the same).
 *
 * CHECKS
 *   • Open  <exec URL>?ping=1  in a browser -> {"ok":true,"key":true,"kb":<chars>,"prices":160,...}
 *   • In the editor run  selfTest()  -> View › Logs shows a real answer + the action it produced.
 *   • Chats are logged anonymously to a self-created Sheet "Sticky Trap - App Chats"; run getConfig() for its URL.
 *
 * PROTOCOL
 *   POST body (sent as text/plain so the browser skips the CORS preflight):
 *     {"uid":"...","tab":"menu","basket":[{"p":"3\" Slap","m":"Holographic BF","f":"Pro","pr":"1.35","qty":100}],
 *      "messages":[{"role":"user"|"assistant","content":"..."}, ...]}
 *   Response: {"ok":true,"reply":"...","actions":[{"type":"add_to_basket","p":...,"m":...,"f":...,"pr":1.35,"qty":100}, ...]}
 *          or {"ok":false,"error":"...","reply":"<friendly fallback>"}
 */

var PROP = PropertiesService.getScriptProperties();
var CACHE = CacheService.getScriptCache();

var DEFAULTS = {
  MODEL: 'claude-opus-5',
  KB_URL: 'https://thestickytrap.app/data/chat-kb.txt',
  MAX_PER_HOUR: 40,        // per device
  MAX_ALL_PER_HOUR: 600,   // whole app
  MAX_TURNS: 16,           // messages kept from the client (8 exchanges)
  MAX_CHARS: 2000,         // per message
  MAX_TOKENS: 700,
  MAX_TOOL_ROUNDS: 4       // API calls per customer message (tool use loops)
};
function cfg_(k) { return PROP.getProperty(k) || DEFAULTS[k]; }

var FALLBACK = "I'm having trouble answering right now. Call or text 734 460 3845, email thestickytrap@gmail.com, or tap Start a project in the Connect tab and we'll help you directly.";
var BUSY = "Lots of questions coming in - give me a minute and try again, or call/text 734 460 3845.";

// Mirrors the app's volume bands (menu price to 249, 3% off at 250, 6% at 500, 10% at 1000).
var BANDS = [[249, 1.00], [499, 0.97], [999, 0.94], [1000, 0.90]];
var MINQ = 50, MAXQ = 1000, STEP = 5;
var TABS = ['industry', 'social', 'menu', 'specs', 'connect', 'play'];

var SYSTEM = [
  "You are the in-app assistant for The Sticky Trap, a design house and sticker/label print shop in Ann Arbor, Michigan.",
  "You're chatting with customers inside the Sticky Trap phone app (tabs: Industry, Social, Menu, Specs, Connect, Play).",
  "Answer from the knowledge base below. Be warm, direct and brief - this is a small chat panel: usually one to four short sentences, plain text.",
  "No markdown headers, tables or bold; a short list with one item per line and a leading dash is fine.",
  "Quote prices exactly as listed (per piece, USD) and name the material and finish tier you're quoting. Apply the volume breaks only as the rules state and show the math when you total an order.",
  "If something isn't in the knowledge base - turnaround, rush, shipping, hours, items or materials not on the menu, design or pre-press cost, orders over 1,000 - don't guess: say it's quoted per project and point them to call/text 734 460 3845, email thestickytrap@gmail.com, or the basket / Start a project quote flow in the app.",
  "Never invent prices, discounts or promises. Don't ask for personal details; when they're ready to order, steer them to the basket or the quote form.",
  "Reply in the customer's language. If asked what you are: a Sticky Trap assistant powered by Claude.",
  "",
  "ACTING IN THE APP - you have tools that the app executes for the customer:",
  "- add_to_basket: only when they clearly ask to add or order something AND you have product, material, finish and quantity. If any piece is missing, ask for it in one short question instead of assuming (never assume a finish). Quantities: minimum 50, steps of 5, maximum 1,000 (over 1,000 is a call-us quote). The tool result carries the exact unit price and line total - confirm those in one line, and if they're within 55 pieces of a volume break, mention it.",
  "- open_product: when they want to see or browse a product's prices; it expands that product in the Menu tab.",
  "- show_basket: when they ask to see, review or check out their basket.",
  "- open_quote_form: when they're ready to send the order, get a quote, or upload art.",
  "- go_to: when they ask for another part of the app (materials/specs, contact, episodes, the daily brief, the game).",
  "You may call several tools in one turn (e.g. two add_to_basket lines). Their current tab and basket are given below - use them (e.g. 'your basket already has...').",
  "", "KNOWLEDGE BASE:", ""
].join("\n");

var TOOLS = [
  { name: 'add_to_basket', strict: true,
    description: "Add a line to the customer's basket in the app. Names should match the menu (e.g. product '3\" Slap', 'Miron 250 ml', 'Tip Band'; material 'White Vinyl', 'Holographic BF', 'Gold BF' (Tip Band: 'White Vinyl' or 'Holographic'); finish 'Base', 'Spot Gloss UV', 'Standard Embossing', 'Pro' (Tip Band: Base or Spot Gloss UV only)). Fuzzy names are accepted and normalized. Returns the exact unit price (with volume break) and line total, or an error explaining what's invalid.",
    input_schema: { type: 'object', additionalProperties: false,
      properties: {
        product: { type: 'string', description: 'Menu product name' },
        material: { type: 'string', description: 'Material' },
        finish: { type: 'string', description: 'Finish tier' },
        qty: { type: 'integer', description: 'Pieces: 50-1000 in steps of 5' },
        holobrite: { type: 'boolean', description: 'White-ink underbase option (Holographic BF / Gold BF only); false if not requested' }
      }, required: ['product', 'material', 'finish', 'qty', 'holobrite'] } },
  { name: 'open_product', strict: true,
    description: 'Switch to the Menu tab and expand one product so the customer sees its prices.',
    input_schema: { type: 'object', additionalProperties: false, properties: { product: { type: 'string' } }, required: ['product'] } },
  { name: 'show_basket', strict: true, description: 'Open the basket drawer in the Menu tab.',
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'open_quote_form', strict: true, description: 'Scroll the customer to the quote / art-upload form (name, email, phone, files, deadline) so they can send their order.',
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'go_to', strict: true, description: 'Switch the app to a tab.',
    input_schema: { type: 'object', additionalProperties: false, properties: { tab: { type: 'string', enum: TABS } }, required: ['tab'] } }
];

/* ---------- HTTP ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.ping) {
    var kb = '', n = 0; try { kb = kb_(); n = kbPrices_(kb).length; } catch (err) { kb = ''; }
    return out_({ ok: true, key: !!PROP.getProperty('ANTHROPIC_API_KEY'), model: cfg_('MODEL'), kb: kb.length, prices: n, kb_url: cfg_('KB_URL') });
  }
  return out_({ ok: true, hint: 'POST {uid, tab, basket, messages:[{role,content}]}' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bad_json', reply: FALLBACK }); }

  var uid = String(body.uid || 'anon').slice(0, 40);
  var msgs = clean_(body.messages);
  if (!msgs.length) return out_({ ok: false, error: 'empty', reply: FALLBACK });
  if (!throttle_(uid)) return out_({ ok: false, error: 'rate_limited', reply: BUSY });
  if (!PROP.getProperty('ANTHROPIC_API_KEY')) return out_({ ok: false, error: 'no_key', reply: FALLBACK });

  var ctx = { tab: TABS.indexOf(body.tab) > -1 ? body.tab : 'industry', basket: cleanBasket_(body.basket) };
  try {
    var r = ask_(msgs, ctx);
    log_(uid, msgs[msgs.length - 1].content, r.reply, r.usage, r.model, r.actions);
    return out_({ ok: true, reply: r.reply, actions: r.actions });
  } catch (err) {
    log_(uid, msgs[msgs.length - 1].content, 'ERROR ' + String(err), null, cfg_('MODEL'), []);
    return out_({ ok: false, error: String(err).slice(0, 200), reply: FALLBACK });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- request hygiene ---------- */
// Keep only well-formed user/assistant text, cap length + count, and force strict alternation
// starting (and ending) with a user turn - the Messages API rejects anything else.
function clean_(list) {
  if (!Array.isArray(list)) return [];
  var maxTurns = +cfg_('MAX_TURNS'), maxChars = +cfg_('MAX_CHARS');
  var out = [];
  list.slice(-maxTurns * 2).forEach(function (m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
    var c = String(m.content == null ? '' : m.content).trim();
    if (!c) return;
    if (c.length > maxChars) c = c.slice(0, maxChars);
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + c; // merge doubles
    else out.push({ role: m.role, content: c });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out.slice(-maxTurns);
}

function cleanBasket_(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map(function (i) {
    return { p: String(i.p || '').slice(0, 60), m: String(i.m || '').slice(0, 40), f: String(i.f || '').slice(0, 60),
             pr: +i.pr || 0, qty: Math.max(0, Math.min(MAXQ, Math.round(+i.qty || 0))) };
  }).filter(function (i) { return i.p && i.qty > 0; });
}

// Sliding counters in the script cache (per device + global), 1-hour windows.
function throttle_(uid) {
  var limUid = +cfg_('MAX_PER_HOUR'), limAll = +cfg_('MAX_ALL_PER_HOUR');
  var ku = 'rl:' + uid, ka = 'rl:__all__';
  var cu = +(CACHE.get(ku) || 0) + 1, ca = +(CACHE.get(ka) || 0) + 1;
  CACHE.put(ku, String(cu), 3600); CACHE.put(ka, String(ca), 3600);
  return cu <= limUid && ca <= limAll;
}

/* ---------- knowledge base ---------- */
function kb_() {
  var hit = CACHE.get('kb');
  if (hit) return hit;
  var r = UrlFetchApp.fetch(cfg_('KB_URL') + '?t=' + Date.now(), { muteHttpExceptions: true, followRedirects: true });
  if (r.getResponseCode() !== 200) throw new Error('kb_fetch_' + r.getResponseCode());
  var text = r.getContentText();
  if (text.length < 500) throw new Error('kb_too_short');
  try { CACHE.put('kb', text, 1200); } catch (e) {} // ~20 min; a value over 100 KB won't cache but still works
  return text;
}

// The KB's price block is machine-readable (same format make_chat_kb.parse_kb reads):
//   ### <product>
//     <material>: <finish> $x (HoloBrite $y) | <finish> $x | ...
function kbPrices_(kb) {
  var out = [], prod = null;
  kb.split('\n').forEach(function (line) {
    if (line.indexOf('### ') === 0) { prod = line.slice(4).trim(); return; }
    if (!prod) return;
    var mm = /^ {2}([^:]+): (.+)$/.exec(line); if (!mm) return;
    mm[2].split(' | ').forEach(function (item) {
      var im = /^(.+?) \$(\d+\.\d+)(?: \(HoloBrite \$(\d+\.\d+)\))?$/.exec(item.trim());
      if (im) out.push({ p: prod, m: mm[1].trim(), f: im[1], pr: +im[2], hb: im[3] ? +im[3] : null });
    });
  });
  return out;
}

/* ---------- pricing helpers (mirror the app) ---------- */
function cmult_(q) { for (var i = 0; i < BANDS.length; i++) if (q <= BANDS[i][0]) return BANDS[i][1]; return BANDS[BANDS.length - 1][1]; }
function unit_(pr, q) { return Math.floor(pr * cmult_(q) * 100 + 0.5) / 100; }
function money_(v) { return '$' + v.toFixed(2); }
function basketLines_(basket) {
  return basket.map(function (i) { var u = unit_(i.pr, i.qty); return { text: i.qty + ' x ' + i.p + ' - ' + i.m + ' / ' + i.f + ' @ ' + money_(u) + ' = ' + money_(u * i.qty), total: u * i.qty }; });
}
function basketSummary_(basket) {
  if (!basket.length) return 'Basket: empty.';
  var lines = basketLines_(basket), tot = lines.reduce(function (a, l) { return a + l.total; }, 0);
  return 'Basket (' + basket.length + ' line' + (basket.length > 1 ? 's' : '') + ', subtotal ' + money_(tot) + '):\n' + lines.map(function (l) { return '- ' + l.text; }).join('\n');
}

/* ---------- fuzzy name matching against the KB ---------- */
function norm_(s) { return String(s || '').toLowerCase().replace(/["”″]/g, ' inch').replace(/[^a-z0-9]+/g, ''); }
function matchProduct_(q, prices) {
  var names = []; prices.forEach(function (r) { if (names.indexOf(r.p) < 0) names.push(r.p); });
  var nq = norm_(q).replace(/inches|inch|in\b/g, 'inch');
  var alts = function (n) { var b = norm_(n); return [b, b.replace('inch', ''), b.replace('ml', ''), b.replace('puck', ''), b.replace('mm', '')]; };
  for (var i = 0; i < names.length; i++) if (alts(names[i]).indexOf(nq) > -1) return names[i];
  for (var j = 0; j < names.length; j++) { var a = alts(names[j]); for (var k = 0; k < a.length; k++) if (a[k] && (nq.indexOf(a[k]) > -1 || a[k].indexOf(nq) > -1)) return names[j]; }
  // digits + keyword (e.g. "3 slap", "250 jar", "95 tube")
  var d = (nq.match(/\d+/) || [''])[0];
  for (var t = 0; t < names.length; t++) { var bn = norm_(names[t]); if (d && bn.indexOf(d) > -1 && ((/slap/.test(nq) && /slap/.test(bn)) || (/(jar|miron)/.test(nq) && /miron/.test(bn)) || (/tube/.test(nq) && /tube/.test(bn)) || (/o2|cart|vape/.test(nq) && /o2/.test(bn)))) return names[t]; }
  if (/deli/.test(nq)) return names.filter(function (n) { return /deli/i.test(n); })[0] || null;
  if (/tip|band|tab/.test(nq)) return names.filter(function (n) { return /tip band/i.test(n); })[0] || null;
  if (/pop/.test(nq)) return names.filter(function (n) { return /pop top/i.test(n); })[0] || null;
  return null;
}
function matchMaterial_(q, product, prices) {
  var mats = []; prices.forEach(function (r) { if (r.p === product && mats.indexOf(r.m) < 0) mats.push(r.m); });
  var nq = norm_(q);
  for (var i = 0; i < mats.length; i++) if (norm_(mats[i]) === nq) return mats[i];
  var want = /gold/.test(nq) ? 'gold' : (/holo|rainbow|metal/.test(nq) ? 'holo' : (/white|vinyl|plain|standard/.test(nq) ? 'white' : null));
  for (var j = 0; j < mats.length; j++) { var m = norm_(mats[j]); if ((want === 'gold' && /gold/.test(m)) || (want === 'holo' && /holo/.test(m)) || (want === 'white' && /white/.test(m))) return mats[j]; }
  return null;
}
function matchFinish_(q, product, material, prices) {
  var fins = []; prices.forEach(function (r) { if (r.p === product && r.m === material && fins.indexOf(r.f) < 0) fins.push(r.f); });
  var nq = norm_(q);
  for (var i = 0; i < fins.length; i++) if (norm_(fins[i]) === nq) return fins[i];
  var want = /pro|3layer|three|full/.test(nq) ? 'Pro' : (/standard|emboss|2layer|two|raised/.test(nq) ? 'Standard Embossing' : (/spot|gloss|uv|1layer|one/.test(nq) ? 'Spot Gloss UV' : (/base|flat|plain|none|no/.test(nq) ? 'Base' : null)));
  return fins.indexOf(want) > -1 ? want : null;
}

/* ---------- tool execution (validated against the KB; the app applies the actions) ---------- */
function runTool_(use, prices, ctx) {
  var inp = use.input || {};
  try {
    if (use.name === 'add_to_basket') {
      var p = matchProduct_(inp.product, prices);
      if (!p) return { error: true, result: { error: "Unknown product '" + inp.product + "'. Menu products: " + uniq_(prices, 'p').join(', ') } };
      var m = matchMaterial_(inp.material, p, prices);
      if (!m) return { error: true, result: { error: "Unknown material '" + inp.material + "' for " + p + ". Options: " + uniq_(prices.filter(function (r) { return r.p === p; }), 'm').join(', ') } };
      var f = matchFinish_(inp.finish, p, m, prices);
      if (!f) return { error: true, result: { error: "Unknown finish '" + inp.finish + "' for " + p + " " + m + ". Options: " + uniq_(prices.filter(function (r) { return r.p === p && r.m === m; }), 'f').join(', ') } };
      var q = Math.round(+inp.qty || 0);
      if (q < MINQ) return { error: true, result: { error: 'Minimum order is ' + MINQ + ' pieces per item.' } };
      if (q > MAXQ) return { error: true, result: { error: 'Over ' + MAXQ + ' pieces is a custom quote - ask them to call or text 734 460 3845.' } };
      if (q % STEP) { q = Math.round(q / STEP) * STEP; }
      var row = prices.filter(function (r) { return r.p === p && r.m === m && r.f === f; })[0];
      var hb = !!inp.holobrite;
      if (hb && row.hb == null) return { error: true, result: { error: 'HoloBrite (white underbase) is not offered on ' + m + ' - only on Holographic BF and Gold BF.' } };
      var pr = hb ? row.hb : row.pr, fname = f + (hb ? ' + HoloBrite' : ''), u = unit_(pr, q), tot = u * q;
      ctx.basket.push({ p: p, m: m, f: fname, pr: pr, qty: q });
      var sub = basketLines_(ctx.basket).reduce(function (a, l) { return a + l.total; }, 0);
      var nb = q < 250 ? (250 - q) : (q < 500 ? (500 - q) : (q < 1000 ? (1000 - q) : 0));
      var res = { ok: true, added: q + ' x ' + p + ' - ' + m + ' / ' + fname, unit_price: money_(u), line_total: money_(tot), menu_price: money_(pr),
                  discount: cmult_(q) < 1 ? Math.round((1 - cmult_(q)) * 100) + '% volume break applied' : 'menu price (no volume break under 250)',
                  basket_subtotal: money_(sub), basket_lines: ctx.basket.length };
      if (nb && nb <= 55) res.tip = 'Adding ' + nb + ' more pieces reaches the next volume break.';
      return { result: res, action: { type: 'add_to_basket', p: p, m: m, f: fname, pr: pr, qty: q } };
    }
    if (use.name === 'open_product') {
      var pp = matchProduct_(inp.product, prices);
      if (!pp) return { error: true, result: { error: "Unknown product '" + inp.product + "'. Menu products: " + uniq_(prices, 'p').join(', ') } };
      return { result: { ok: true, opened: pp }, action: { type: 'open_product', product: pp } };
    }
    if (use.name === 'show_basket') return { result: { ok: true, basket: basketSummary_(ctx.basket) }, action: { type: 'show_basket' } };
    if (use.name === 'open_quote_form') return { result: { ok: true, note: 'Quote form is now on screen (name, email, phone, art files, deadline). Nothing is charged until they approve the quote.' }, action: { type: 'open_quote_form' } };
    if (use.name === 'go_to') {
      var tab = TABS.indexOf(inp.tab) > -1 ? inp.tab : null;
      if (!tab) return { error: true, result: { error: 'Unknown tab. Tabs: ' + TABS.join(', ') } };
      return { result: { ok: true, tab: tab }, action: { type: 'go_to', tab: tab } };
    }
    return { error: true, result: { error: 'unknown tool ' + use.name } };
  } catch (err) { return { error: true, result: { error: String(err) } }; }
}
function uniq_(rows, k) { var o = []; rows.forEach(function (r) { if (o.indexOf(r[k]) < 0) o.push(r[k]); }); return o; }

/* ---------- Claude (tool-use loop) ---------- */
function ask_(msgs, ctx) {
  var kb = kb_(), prices = kbPrices_(kb);
  var convo = msgs.slice(), actions = [], usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, model = cfg_('MODEL');
  var rounds = +cfg_('MAX_TOOL_ROUNDS');
  for (var i = 0; i < rounds; i++) {
    var data = callClaude_(convo, kb, ctx);
    model = data.model || model;
    if (data.usage) { usage.input_tokens += data.usage.input_tokens || 0; usage.output_tokens += data.usage.output_tokens || 0; usage.cache_read_input_tokens += data.usage.cache_read_input_tokens || 0; }
    if (data.stop_reason === 'refusal') return { reply: FALLBACK, actions: actions, usage: usage, model: model };
    var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('').trim();
    var uses = (data.content || []).filter(function (b) { return b.type === 'tool_use'; });
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      if (!text) throw new Error('empty_reply');
      return { reply: text, actions: actions, usage: usage, model: model };
    }
    convo.push({ role: 'assistant', content: data.content });   // echo the whole turn back (thinking blocks included)
    var results = uses.map(function (u) {
      var r = runTool_(u, prices, ctx);
      if (r.action) actions.push(r.action);
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result), is_error: !!r.error };
    });
    convo.push({ role: 'user', content: results });
  }
  // ran out of rounds: keep whatever actions succeeded and say so plainly
  return { reply: actions.length ? 'Done - check your basket for the update.' : FALLBACK, actions: actions, usage: usage, model: model };
}

function callClaude_(convo, kb, ctx) {
  var context = 'CUSTOMER CONTEXT (this request): on the ' + ctx.tab.charAt(0).toUpperCase() + ctx.tab.slice(1) + ' tab. ' + basketSummary_(ctx.basket);
  var payload = {
    model: cfg_('MODEL'),
    max_tokens: +cfg_('MAX_TOKENS'),
    // Stable prompt (rules + KB) carries the cache breakpoint; the volatile context block comes after it.
    system: [{ type: 'text', text: SYSTEM + kb, cache_control: { type: 'ephemeral' } },
             { type: 'text', text: context }],
    tools: TOOLS,
    messages: convo,
    output_config: { effort: 'low' },
    fallbacks: 'default'   // if the safety classifiers decline a turn, the API re-routes it instead of returning a refusal
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': PROP.getProperty('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) {
    var msg = ''; try { msg = JSON.parse(text).error.message; } catch (e) { msg = text.slice(0, 200); }
    throw new Error('api_' + code + ': ' + msg);
  }
  return JSON.parse(text);
}

/* ---------- logging (anonymous: device id, question, answer, actions, tokens) ---------- */
function ss_() {
  var id = PROP.getProperty('CHAT_SHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('Sticky Trap - App Chats');
    id = ss.getId(); PROP.setProperty('CHAT_SHEET_ID', id);
    var sh = ss.getActiveSheet(); sh.setName('chats');
    sh.appendRow(['ts', 'device_id', 'question', 'answer', 'actions', 'in_tokens', 'out_tokens', 'cache_read', 'model']);
  }
  return SpreadsheetApp.openById(id);
}
function log_(uid, q, a, usage, model, actions) {
  try {
    var sh = ss_().getSheetByName('chats');
    var acts = (actions || []).map(function (x) { return x.type + (x.p ? ':' + x.qty + 'x' + x.p + '/' + x.m + '/' + x.f : (x.product ? ':' + x.product : (x.tab ? ':' + x.tab : ''))); }).join('; ');
    sh.appendRow([new Date(), uid, String(q).slice(0, 500), String(a).slice(0, 2000), acts.slice(0, 500),
      usage ? usage.input_tokens : '', usage ? usage.output_tokens : '', usage ? (usage.cache_read_input_tokens || 0) : '', model || '']);
  } catch (e) {}
}

/* ---------- editor helpers ---------- */
function getConfig() {
  var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  Logger.log('KEY set: ' + !!PROP.getProperty('ANTHROPIC_API_KEY') + '\nMODEL: ' + cfg_('MODEL') + '\nKB_URL: ' + cfg_('KB_URL') +
    '\nCHATS SHEET: ' + (PROP.getProperty('CHAT_SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + PROP.getProperty('CHAT_SHEET_ID') : '(created on first chat)') +
    '\nWEBAPP: ' + (url || '(deploy first)'));
}
function selfTest() {
  var ctx = { tab: 'menu', basket: [] };
  var r = ask_([{ role: 'user', content: 'Add 100 3" slaps, holographic, Pro finish to my basket please.' }], ctx);
  Logger.log(r.reply + '\n\nactions: ' + JSON.stringify(r.actions) + '\nusage: ' + JSON.stringify(r.usage) + '\nmodel: ' + r.model);
}
