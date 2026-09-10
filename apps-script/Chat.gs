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
 *   - Open  <exec URL>?ping=1  in a browser -> {"ok":true,"key":true,"kb":<chars>,"prices":160,...}
 *     Add the refresh=1 parameter to that ping after pushing a new chat-kb.txt so the script re-reads it immediately (else ~20 min cache).
 *   - In the editor run  selfTest()  -> View > Logs shows a real answer + the action it produced.
 *   - Chats are logged anonymously to a self-created Sheet "Sticky Trap - App Chats"; run getConfig() for its URL.
 *
 * PROTOCOL
 *   POST body (sent as text/plain so the browser skips the CORS preflight):
 *     {"uid":"...","tab":"menu","basket":[{"p":"3\" Slap","m":"Holographic BF","f":"Pro","pr":"1.35","qty":100}],
 *      "messages":[{"role":"user"|"assistant","content":"..."}, ...]}
 *   Response: {"ok":true,"reply":"...","actions":[{"type":"add_to_basket","p":...,"m":...,"f":...,"pr":1.35,"qty":100}, ...]}
 *          or {"ok":false,"error":"...","reply":"<friendly fallback>"}
 *
 * ARCADE LEADERBOARD (Trap Points game, game/index.html) - rides on this same deployment:
 *   POST {"action":"score","uid":"...","handle":"TRAPGOD","day":<dayNum>,"best":<score>,"stars":0-3}
 *        -> upserts the player's best for that day in the 'scores' tab of the chats spreadsheet
 *   GET  with action=lb (plus optional month=YYYY-MM and uid=...)
 *        -> {ok, month, count, top:[{rank,handle,total,days,you}], you:{rank,total,days,gap_podium,gap_crown}|null}
 *   Monthly ladder = sum of each player's daily best scores that month. uids starting with 'test-' are
 *   accepted but never shown (safe for testing).
 */

var PROP = PropertiesService.getScriptProperties();
var CODE_VERSION = 22;   // bump with every paste; ?ping=1 reports it so the deployed version can be checked from outside
var SHOP_EMAIL = PropertiesService.getScriptProperties().getProperty('SHOP_EMAIL') || 'thestickytrap@gmail.com';   // where NDA copies + referral alerts go (Session.getEffectiveUser needs a scope the web app lacks)
var CACHE = CacheService.getScriptCache();

var DEFAULTS = {
  MODEL: 'claude-sonnet-5',   // Shane 2026-09-10: faster replies (was claude-opus-5; script property MODEL overrides)
  KB_URL: 'https://thestickytrap.app/data/chat-kb.txt',
  MAX_PER_HOUR: 40,        // per device
  MAX_ALL_PER_HOUR: 600,   // whole app
  MAX_TURNS: 16,           // messages kept from the client (8 exchanges)
  MAX_CHARS: 2000,         // per message
  MAX_TOKENS: 300,
  MAX_TOOL_ROUNDS: 4       // API calls per customer message (tool use loops)
};
function cfg_(k) { return PROP.getProperty(k) || DEFAULTS[k]; }

var FALLBACK = "I'm having trouble answering right now. Call or text 734 460 3845, email thestickytrap@gmail.com, or tap Start a project in the Connect tab and we'll help you directly.";
var BUSY = "Lots of questions coming in - give me a minute and try again, or call/text 734 460 3845.";

// Mirrors the app's volume bands (pricing_master.VOL_BANDS, 2026-09-08): menu price to 499, 5% off at 500, 7% at 750, 10% at 1000.
var BANDS = [[499, 1.00], [749, 0.95], [999, 0.93], [1000, 0.90]];
var MINQ = 5, MAXQ = 1000, STEP = 5, MIN_ORDER = 50;   // qty floor 5 (steps of 5); the real minimum is $50 per ORDER
var TABS = ['industry', 'social', 'menu', 'specs', 'connect', 'play'];

var SYSTEM = [
  "You are the in-app assistant for The Sticky Trap, a design house and sticker/label print shop in Ann Arbor, Michigan.",
  "You're chatting with customers inside the Sticky Trap phone app (tabs: Industry, Social, Menu, Specs, Connect, Play).",
  "Answer from the knowledge base below. Be warm, direct and SHORT - this is a small phone chat panel: one to three short sentences, under 45 words, plain text. Give the one most relevant answer (e.g. the single price for the material and tier asked, or the most common option) and offer more only if they want it. Never list every material or every tier unless they ask for the full list.",
  "No markdown headers, tables or bold; a short list with one item per line and a leading dash is fine.",
  "Quote prices exactly as listed (per piece, USD) and name the material and finish tier you're quoting. Apply the volume breaks only as the rules state and show the math when you total an order.",
  "The House facts section (turnaround, hours, and whatever else the shop adds there) is authoritative - answer those directly. If something isn't in the knowledge base - rush jobs, shipping, items or materials not on the menu, design or pre-press cost, orders over 1,000 - don't guess: say it's quoted per project and point them to call/text 734 460 3845, email thestickytrap@gmail.com, or the basket / Start a project quote flow in the app.",
  "Never invent prices, discounts or promises. Don't ask for personal details; when they're ready to order, steer them to the basket or the quote form.",
  "Never quote or estimate set-up, pre-press, vector or gloss-layer charges. If asked, FIRST say in one sentence that pre-press is assessed per design once we see the art, THEN offer the quote form (open_quote_form) or call/text - never open the form without that sentence. State the $50 minimum per order only if asked; do not elaborate on mixes or per-item minimums.",
  "ORDER STATUS: when they ask where an order is / its status / tracking, use order_status. It needs the order code (like 247-XL, on their invoice and tracker emails) AND the email on the order; if either is missing ask for both in one short question. Never describe an order unless order_status returned it. Report the stage, its message and the due date plainly; offer the Track my order panel (go_to connect) for the full timeline.",
  "Reply in the customer's language. If asked what you are: a Sticky Trap assistant powered by Claude.",
  "",
  "ACTING IN THE APP - you have tools that the app executes for the customer:",
  "- add_to_basket: as soon as you have product, material, finish and quantity - whether they say 'add' or simply ask what that exact quantity costs - quote the line AND call add_to_basket in the same turn. Never ask 'want me to add it?'; they can remove it in the basket. If any piece is missing, ask for it in one short question instead of assuming (never assume a finish). Quantities: steps of 5 from 5 up to 1,000 (over 1,000 is a call-us quote). The minimum ORDER is $50 total across the basket - the tool result says whether the basket meets it; if not, tell them how much more is needed in one line. The tool result carries the exact unit price and line total - confirm those in one line, and if they're within 55 pieces of a volume break, mention it.",
  "- open_product: when they want to see or browse a product's prices; it expands that product in the Menu tab.",
  "- show_basket: when they ask to see, review or check out their basket.",
  "- open_quote_form: when they're ready to send the order, get a quote, or upload art.",
  "- go_to: when they ask for another part of the app (materials/specs, contact, episodes, the daily brief, the game).",
  "You may call several tools in one turn (e.g. two add_to_basket lines). Their current tab and basket are given below - use them (e.g. 'your basket already has...'). After add_to_basket, state only what the result says (unit price, line total, basket subtotal); never speculate about merged or duplicate lines - the app handles that.",
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
        qty: { type: 'integer', description: 'Pieces: 5-1000 in steps of 5' },
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
    input_schema: { type: 'object', additionalProperties: false, properties: { tab: { type: 'string', enum: TABS } }, required: ['tab'] } },
  { name: 'order_status', strict: true, description: 'Look up where a customer order stands in the shop order tracker. Needs the order code (e.g. 247-XL) and the email address on the order.',
    input_schema: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, email: { type: 'string' } }, required: ['code', 'email'] } }
];

/* ---------- HTTP ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'lb') { try { return out_(leaderboard_(p)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (p.action === 'track') { try { return out_(trackGet_(p)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (p.action === 'orders') { try { return out_(ordersList_(p)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (p.refresh) CACHE.remove('kb');   // ping with refresh=1 -> re-fetch the KB now instead of waiting out the 20-min cache
  if (p.ping) {
    var kb = '', n = 0; try { kb = kb_(); n = kbPrices_(kb).length; } catch (err) { kb = ''; }
    return out_({ ok: true, version: CODE_VERSION, key: !!PROP.getProperty('ANTHROPIC_API_KEY'), model: cfg_('MODEL'), kb: kb.length, prices: n, kb_url: cfg_('KB_URL') });
  }
  return out_({ ok: true, hint: 'POST {uid, tab, basket, messages:[{role,content}]}' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bad_json', reply: FALLBACK }); }

  if (body.action === 'score') { try { return out_(scoreIn_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'ref') { try { return out_(refIn_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'nda') { try { return out_(ndaIn_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'order_new') { try { return out_(orderNew_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'order_stage') { try { return out_(orderStage_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'approve') { try { return out_(approve_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'changes') { try { return out_(changes_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }
  if (body.action === 'order_delete') { try { return out_(orderDelete_(body)); } catch (err) { return out_({ ok: false, error: String(err).slice(0, 200) }); } }

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
function norm_(s) { return String(s || '').toLowerCase().replace(/["\u201d\u2033]/g, ' inch').replace(/[^a-z0-9]+/g, ''); }
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
      if (q < MINQ) return { error: true, result: { error: 'Quantities start at ' + MINQ + ' pieces (steps of ' + STEP + '). The order minimum is $' + MIN_ORDER + ' total.' } };
      if (q > MAXQ) return { error: true, result: { error: 'Over ' + MAXQ + ' pieces is a custom quote - ask them to call or text 734 460 3845.' } };
      if (q % STEP) { q = Math.round(q / STEP) * STEP; }
      var row = prices.filter(function (r) { return r.p === p && r.m === m && r.f === f; })[0];
      var hb = !!inp.holobrite;
      if (hb && row.hb == null) return { error: true, result: { error: 'HoloBrite (white underbase) is not offered on ' + m + ' - only on Holographic BF and Gold BF.' } };
      var pr = hb ? row.hb : row.pr, fname = f + (hb ? ' + HoloBrite' : ''), u = unit_(pr, q), tot = u * q;
      var before = ctx.basket.length;
      ctx.basket.push({ p: p, m: m, f: fname, pr: pr, qty: q });
      var sub = basketLines_(ctx.basket).reduce(function (a, l) { return a + l.total; }, 0);
      var nb = q < 500 ? (500 - q) : (q < 750 ? (750 - q) : (q < 1000 ? (1000 - q) : 0));
      var res = { ok: true, added: q + ' x ' + p + ' - ' + m + ' / ' + fname, unit_price: money_(u), line_total: money_(tot), menu_price: money_(pr),
                  discount: cmult_(q) < 1 ? Math.round((1 - cmult_(q)) * 100) + '% volume break applied' : 'menu price (no volume break under 500)',
                  basket: 'had ' + before + ' line(s) before this add; now ' + ctx.basket.length + ' line(s), subtotal ' + money_(sub),
                  order_total: money_(Math.max(sub, MIN_ORDER)) + (sub < MIN_ORDER ? ' ($' + MIN_ORDER + ' minimum order applied - the app charges the minimum, it does not block the order)' : '') };
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
    if (use.name === 'order_status') {
      var t = trackGet_({ o: inp.code, e: inp.email });
      if (!t.ok) return { error: true, result: { error: 'No order found for code ' + String(inp.code || '').toUpperCase() + ' with that email. Ask them to check the code on their invoice or tracker email and the email address they used.' } };
      var o = t.order, last = o.history.length ? o.history[o.history.length - 1] : null;
      return { result: { ok: true, code: o.code, stage: o.label, message: o.message, due: o.due || 'not set yet', items: o.items || '', company: o.company || o.name || '',
                         last_update: last ? new Date(last.ts).toDateString() + (last.note ? ' - ' + last.note : '') : '', awaiting_client_approval: !!o.can_approve } };
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
  var pre = [];   // v19: text the model wrote BEFORE a tool call (e.g. 'pre-press is assessed per design...') used to be dropped; keep it
  for (var i = 0; i < rounds; i++) {
    var data = callClaude_(convo, kb, ctx);
    model = data.model || model;
    if (data.usage) { usage.input_tokens += data.usage.input_tokens || 0; usage.output_tokens += data.usage.output_tokens || 0; usage.cache_read_input_tokens += data.usage.cache_read_input_tokens || 0; }
    if (data.stop_reason === 'refusal') return { reply: FALLBACK, actions: actions, usage: usage, model: model };
    var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('').trim();
    var uses = (data.content || []).filter(function (b) { return b.type === 'tool_use'; });
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      text = pre.concat(text ? [text] : []).join(' ');
      if (!text) throw new Error('empty_reply');
      return { reply: text, actions: actions, usage: usage, model: model };
    }
    if (text) pre.push(text);
    convo.push({ role: 'assistant', content: data.content });   // echo the whole turn back (thinking blocks included)
    var results = uses.map(function (u) {
      var r = runTool_(u, prices, ctx);
      if (r.action) actions.push(r.action);
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result), is_error: !!r.error };
    });
    convo.push({ role: 'user', content: results });
  }
  // ran out of rounds: keep whatever actions succeeded and say so plainly
  return { reply: pre.length ? pre.join(' ') : (actions.length ? 'Done - check your basket for the update.' : FALLBACK), actions: actions, usage: usage, model: model };
}

/* ---------- promos (data/promos.json on the site): featured of the week, double-points rule, dated events ---------- */
function promos_() {
  var hit = CACHE.get('promos'); if (hit) return JSON.parse(hit);
  var out = { events: [], featured: null, double_points: null };
  try {
    var r = UrlFetchApp.fetch('https://thestickytrap.app/data/promos.json?t=' + Date.now(), { muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() === 200) out = JSON.parse(r.getContentText());
  } catch (e) {}
  try { CACHE.put('promos', JSON.stringify(out), 1200); } catch (e) {}
  return out;
}
function activePromosText_() {
  var P = promos_(), d = new Date(), tz = Session.getScriptTimeZone();
  var t = Utilities.formatDate(d, tz, 'yyyy-MM-dd'), dow = +Utilities.formatDate(d, tz, 'u') % 7, dm = +Utilities.formatDate(d, tz, 'd');
  var lines = [];
  // upcoming events with a 'hero' block (the Social tab's ticket card): the bot can answer "when / where / tickets?" any time before the date
  (P.events || []).forEach(function (e) { var h = e.hero; if (!h || !h.date || h.date < t) return;
    lines.push('- UPCOMING EVENT: ' + (e.title || '') + ' - ' + [h.when, h.venue].filter(Boolean).join(' at ') + (h.tickets ? '. Tickets: ' + h.tickets : '') + '. The ticket card is on the Social tab (go_to social).'); });
  (P.events || []).forEach(function (e) { if (e.surfaces && e.surfaces.indexOf('app') < 0) return; if (e.from && t < e.from) return; if (e.to && t > e.to) return; lines.push('- ' + e.title + ': ' + (e.text || '')); });
  if (P.double_points) {
    var r = P.double_points, on = r.rule === 'first_weekend' ? ((dow === 6 && dm <= 7) || (dow === 0 && dm >= 2 && dm <= 8)) : (r.rule === 'weekend' ? (dow === 0 || dow === 6) : false);
    if (on) lines.push('- ' + (r.label || 'Double points') + ' (Trap Points game): ' + (r.text || 'every daily earns 2x points today'));
  }
  if (P.featured && P.featured.items && P.featured.items.length) {
    var wk = Math.floor(Date.now() / 864e5 / 7), it = P.featured.items[wk % P.featured.items.length];
    lines.push('- Featured this week: ' + it.product + ' - ' + (it.pitch || ''));
  }
  return lines.length ? ('CURRENT PROMOS (mention when relevant; never invent others):\n' + lines.join('\n')) : 'CURRENT PROMOS: none.';
}

function callClaude_(convo, kb, ctx) {
  var context = 'CUSTOMER CONTEXT (this request): on the ' + ctx.tab.charAt(0).toUpperCase() + ctx.tab.slice(1) + ' tab. ' + basketSummary_(ctx.basket) + '\n' + activePromosText_();
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
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted / not ours any more -> make a new one */ } }
  var ss = SpreadsheetApp.create('Sticky Trap - App Chats');
  PROP.setProperty('CHAT_SHEET_ID', ss.getId());
  var sh = ss.getActiveSheet(); sh.setName('chats');
  sh.appendRow(['ts', 'device_id', 'question', 'answer', 'actions', 'in_tokens', 'out_tokens', 'cache_read', 'model']);
  return ss;
}
function log_(uid, q, a, usage, model, actions) {
  try {
    var sh = ss_().getSheetByName('chats');
    var acts = (actions || []).map(function (x) { return x.type + (x.p ? ':' + x.qty + 'x' + x.p + '/' + x.m + '/' + x.f : (x.product ? ':' + x.product : (x.tab ? ':' + x.tab : ''))); }).join('; ');
    sh.appendRow([new Date(), uid, String(q).slice(0, 500), String(a).slice(0, 2000), acts.slice(0, 500),
      usage ? usage.input_tokens : '', usage ? usage.output_tokens : '', usage ? (usage.cache_read_input_tokens || 0) : '', model || '']);
  } catch (e) {}
}

/* ---------- arcade leaderboard (Trap Points game) ---------- */
var SCORE_MAX = 60000;
function scoresSheet_() {
  var ss = ss_(), sh = ss.getSheetByName('scores');
  if (!sh) { sh = ss.insertSheet('scores'); sh.appendRow(['ts', 'uid', 'handle', 'day', 'month', 'best', 'stars', 'slot']); }
  try { if (sh.getRange(1, 8).getValue() === '') sh.getRange(1, 8).setValue('slot'); } catch (e) {}   // boards per 6-hour slot since 2026-09-08
  try { sh.getRange('C:C').setNumberFormat('@'); sh.getRange('E:E').setNumberFormat('@'); } catch (e) {}   // keep handles like 007 and months like 2026-09 as text
  return sh;
}
function monthOfDay_(day) { var d = new Date(day * 864e5); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2); }
function scoreIn_(b) {
  var uid = String(b.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  var handle = String(b.handle || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  var day = Math.round(+b.day || 0), slot = Math.round(+b.slot || 0), best = Math.max(0, Math.min(SCORE_MAX, Math.round(+b.best || 0))), stars = Math.max(0, Math.min(3, Math.round(+b.stars || 0)));
  var today = Math.floor(Date.now() / 864e5);
  if (!uid || !handle || !best || Math.abs(day - today) > 1) return { ok: false, error: 'bad_score' };
  if (!throttle_('score:' + uid)) return { ok: false, error: 'rate_limited' };
  var month = monthOfDay_(day), sh = scoresSheet_(), rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === uid && +rows[i][3] === day && (+rows[i][7] || 0) === slot) {   // one row per player per board (slot)
      var better = best > +rows[i][5];
      if (better) sh.getRange(i + 1, 3, 1, 6).setValues([[handle, day, month, best, stars, slot]]);
      CACHE.remove('lb:' + month);
      return { ok: true, updated: better };
    }
  }
  sh.appendRow([new Date(), uid, handle, day, month, best, stars, slot]);
  CACHE.remove('lb:' + month);
  return { ok: true, updated: true };
}
function leaderboard_(p) {
  var month = /^\d{4}-\d{2}$/.test(p.month || '') ? p.month : monthOfDay_(Math.floor(Date.now() / 864e5));
  var uid = String(p.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  var key = 'lb:' + month, hit = CACHE.get(key), board;
  if (hit) board = JSON.parse(hit);
  else {
    var sh = scoresSheet_(), rows = sh.getDataRange().getValues(), agg = {};
    for (var i = 1; i < rows.length; i++) {
      if (monthOfDay_(+rows[i][3]) !== month) continue;   // derive from the numeric day column (Sheets may coerce col E)
      var u = String(rows[i][1]);
      if (u.indexOf('test-') === 0) continue;                          // test traffic never shows
      var a = agg[u] || (agg[u] = { uid: u, handle: '', total: 0, days: 0, ts: 0 });
      a.total += +rows[i][5]; a.days++;
      var t = new Date(rows[i][0]).getTime(); if (t >= a.ts) { a.ts = t; a.handle = String(rows[i][2]); }
    }
    board = Object.keys(agg).map(function (k) { return agg[k]; }).sort(function (x, y) { return y.total - x.total || y.days - x.days; });
    try { CACHE.put(key, JSON.stringify(board), 60); } catch (e) {}
  }
  var top = board.slice(0, 10).map(function (r, i) { return { rank: i + 1, handle: r.handle, total: r.total, days: r.days, you: !!uid && r.uid === uid }; });
  var you = null;
  for (var j = 0; j < board.length; j++) if (uid && board[j].uid === uid) {
    you = { rank: j + 1, total: board[j].total, days: board[j].days, handle: board[j].handle,
            gap_podium: j >= 3 ? board[2].total - board[j].total + 1 : 0, gap_crown: j > 0 ? board[0].total - board[j].total + 1 : 0 };
    break;
  }
  var refs = 0; try { refs = refCount_(String(p.handle || '')); } catch (e) {}
  return { ok: true, month: month, count: board.length, top: top, you: you, refs: refs };
}

/* ---------- referrals: a new player's first finished board reports the handle that referred them ---------- */
function refsSheet_() {
  var ss = ss_(), sh = ss.getSheetByName('referrals');
  if (!sh) { sh = ss.insertSheet('referrals'); sh.appendRow(['ts', 'referrer', 'new_uid', 'new_handle']); try { sh.getRange('B:B').setNumberFormat('@'); sh.getRange('D:D').setNumberFormat('@'); } catch (e) {} }
  return sh;
}
function refIn_(b) {
  var uid = String(b.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  var handle = String(b.handle || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  var ref = String(b.ref || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!uid || !handle || !ref || ref === handle) return { ok: false, error: 'bad_ref' };
  if (!throttle_('ref:' + uid)) return { ok: false, error: 'rate_limited' };
  var sh = refsSheet_(), rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (String(rows[i][2]) === uid) return { ok: true, dup: true };   // one referral per new player, ever
  sh.appendRow([new Date(), ref, uid, handle]);
  CACHE.remove('refs:' + ref);
  try { MailApp.sendEmail(SHOP_EMAIL, 'Trap Points referral: ' + ref + ' brought in ' + handle,
    ref + ' referred a new player (' + handle + ', uid ' + uid + ') who just finished their first board.\nThey get +500 on their next ladder load.\nSheet: ' + ss_().getUrl()); } catch (e) {}
  return { ok: true };
}
function refCount_(handle) {
  handle = String(handle || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); if (!handle) return 0;
  var key = 'refs:' + handle, hit = CACHE.get(key); if (hit !== null) return +hit;
  var rows = refsSheet_().getDataRange().getValues(), n = 0;
  for (var i = 1; i < rows.length; i++) if (String(rows[i][1]) === handle && String(rows[i][2]).indexOf('test-') !== 0) n++;
  try { CACHE.put(key, String(n), 300); } catch (e) {}
  return n;
}


/* ---------- meeting NDA (thestickytrap.app/nda/): log + signed PDF to both parties ---------- */
function ndaSheet_() {
  var ss = ss_(), sh = ss.getSheetByName('ndas');
  if (!sh) { sh = ss.insertSheet('ndas'); sh.appendRow(['ts', 'date_on_doc', 'other_party', 'other_name', 'company', 'title', 'email', 'purpose', 'fm_name', 'fm_title', 'ua']); }
  return sh;
}
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
function sigBlob_(dataUrl, name) {
  var m = /^data:image\/png;base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length > 400000) return null;
  return Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/png', name);
}
function ndaIn_(b) {
  var o = b.other || {}, f = b.fm || {};
  var email = String(o.email || '').trim().slice(0, 120), name = String(o.name || '').trim().slice(0, 80), company = String(o.company || '').trim().slice(0, 80);
  var party = String(b.party || company || name).trim().slice(0, 120), purpose = String(b.purpose || '').trim().slice(0, 200), date = String(b.date || '').trim().slice(0, 40);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) return { ok: false, error: 'bad_nda' };
  if (!throttle_('nda:' + email)) return { ok: false, error: 'rate_limited' };
  var sigO = sigBlob_(o.sig, 'sig-other.png'), sigF = sigBlob_(f.sig, 'sig-fm.png');
  if (!sigO) return { ok: false, error: 'no_signature' };
  ndaSheet_().appendRow([new Date(), date, party, name, company, String(o.title || '').slice(0, 80), email, purpose, String(f.name || '').slice(0, 80), String(f.title || '').slice(0, 80), String(b.ua || '').slice(0, 120)]);
  var line = function (k, v) { return '<tr><td style="padding:3px 10px 3px 0;color:#666">' + k + '</td><td style="padding:3px 0"><b>' + esc_(v || '&mdash;') + '</b></td></tr>'; };
  var block = function (title, sub, sigcid, rows) {
    return '<td style="vertical-align:top;width:50%;padding:12px;border:1px solid #ddd;border-radius:8px">' +
      '<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#888;font-weight:700">' + title + '</div><div style="font-weight:700;margin:2px 0 8px">' + esc_(sub) + '</div>' +
      (sigcid ? '<img src="cid:' + sigcid + '" style="width:220px;height:auto;display:block;border-bottom:1px solid #999;margin-bottom:6px">' : '<div style="height:60px;border-bottom:1px solid #999;margin-bottom:6px"></div>') +
      '<table style="font-size:13px;border-collapse:collapse">' + rows + '</table></td>';
  };
  var html = '<div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#111;font-size:14px;line-height:1.55">' +
    '<div style="text-align:center;font-size:18px;font-weight:900;letter-spacing:.02em;margin:10px 0 2px">MUTUAL NON-DISCLOSURE AGREEMENT</div>' +
    '<div style="text-align:center;color:#666;margin-bottom:16px">State of Michigan</div>' +
    '<p>This Agreement is made on <b>' + esc_(date) + '</b>, between <b>FM Holdings LLC d/b/a The Sticky Trap</b> and <b>' + esc_(party) + '</b> (each a "Party").</p>' +
    '<p>Purpose of the meeting: <b>' + esc_(purpose || '&mdash;') + '</b></p>' +
    "<p>In connection with the Parties' discussions, each Party may share confidential information with the other, including designs, artwork, pricing, methods, customers, and business plans. Each Party agrees to keep the other Party's confidential information strictly confidential, to use it only to evaluate or conduct business between the Parties, and not to disclose it to anyone else without the other Party's prior written consent. This applies to information shared before, during, or after the meeting at which this Agreement is signed.</p>" +
    '<p>This Agreement is governed by the laws of the State of Michigan and remains in effect for three (3) years from the date above. It does not apply to information that is or becomes public through no fault of the receiving Party, or that a Party already lawfully knew.</p>' +
    '<p><i>This Agreement may be signed in counterparts, including by electronic or photographed signature, and each Party keeps a signed copy.</i></p>' +
    '<table style="width:100%;border-collapse:separate;border-spacing:10px 0;margin-top:10px"><tr>' +
    block('FM Holdings LLC', 'd/b/a The Sticky Trap', sigF ? 'sigfm' : '', line('Print name', f.name) + line('Title', f.title) + line('Date', date)) +
    block('Other Party', party, 'sigother', line('Print name', name) + line('Company', company) + line('Title', o.title) + line('Email', email) + line('Date', date)) +
    '</tr></table>' +
    '<p style="color:#888;font-size:11px;text-align:center;margin-top:22px">FM Holdings LLC &middot; d/b/a The Sticky Trap &middot; 4750 Venture Dr, Suite 101, Ann Arbor, MI 48108 &middot; (734) 460-3845 &middot; thestickytrap@gmail.com<br>Signed electronically at thestickytrap.app/nda ' + new Date().toString() + '</p></div>';
  var inline = { sigother: sigO }; if (sigF) inline.sigfm = sigF;
  // the PDF copy needs the images embedded, not cid-referenced
  var pdfHtml = html.replace('cid:sigother', 'data:image/png;base64,' + Utilities.base64Encode(sigO.getBytes()));
  if (sigF) pdfHtml = pdfHtml.replace('cid:sigfm', 'data:image/png;base64,' + Utilities.base64Encode(sigF.getBytes()));
  var pdf = null; try { pdf = Utilities.newBlob('<html><body>' + pdfHtml + '</body></html>', 'text/html', 'nda.html').getAs('application/pdf').setName('Sticky Trap NDA - ' + (company || name).replace(/[^\w .-]/g, '') + '.pdf'); } catch (e) {}
  var me = SHOP_EMAIL;
  var subject = 'Signed NDA - The Sticky Trap & ' + (company || name);
  var opts = { htmlBody: '<p>Here is your signed copy of the mutual NDA with The Sticky Trap' + (purpose ? ' (' + esc_(purpose) + ')' : '') + '. The PDF is attached.</p>' + html, inlineImages: inline, name: 'The Sticky Trap', cc: me };
  if (pdf) opts.attachments = [pdf];
  MailApp.sendEmail(email, subject, 'Your signed NDA with The Sticky Trap is attached.', opts);
  return { ok: true };
}


/* ---------- order tracker: sheet 'orders', client emails per stage, staff console, stale nudges ---------- */
var STAGE_ORDER = ['received', 'quoted', 'deposit', 'proofing', 'proof_sent', 'approved', 'printing', 'ready', 'shipped', 'complete'];
var STAGES = {
  received:   { label: 'Request received',          msg: 'We have your request and will follow up with a quote shortly.' },
  quoted:     { label: 'Quote sent',                msg: 'Your quote / invoice is on its way. The deposit locks in your spot in the queue.' },
  deposit:    { label: 'Deposit received',          msg: 'Thank you - your order is in the queue and art is next.' },
  proofing:   { label: 'Art & proof in progress',   msg: 'We are working on your proof now.' },
  proof_sent: { label: 'Proof sent - approval needed', msg: 'Your proof is ready. Please review it and tap Approve so we can print. Proof before we print - no surprises.' },
  approved:   { label: 'Proof approved',            msg: 'Approved - your order is queued for print.' },
  printing:   { label: 'Printing',                  msg: 'Your order is on the press.' },
  ready:      { label: 'Ready for pickup',          msg: 'Your order is finished and ready for pickup at 4750 Venture Dr, Suite 101, Ann Arbor. Mon-Fri 10-5.' },
  shipped:    { label: 'Shipped',                   msg: 'Your order is on its way.' },
  complete:   { label: 'Complete',                  msg: 'All done - thank you for sticking with us.' }
};
var NUDGE_HOURS = { proof_sent: 24, printing: 72 };   // Shane 2026-09-08: 24 h in proof, 72 h in printing -> nudge the team (never the client)
var ORDER_COLS = ['code', 'created', 'name', 'company', 'email', 'phone', 'items', 'due', 'stage', 'stage_ts', 'history', 'token', 'monday_item', 'square_inv', 'nudged_ts', 'notes', 'source', 'pay_url'];   // pay_url = Square invoice link (v22)
function ordersSheet_() {
  var ss = ss_(), sh = ss.getSheetByName('orders');
  if (!sh) { sh = ss.insertSheet('orders'); sh.appendRow(ORDER_COLS); try { sh.getRange('A:A').setNumberFormat('@'); sh.getRange('H:H').setNumberFormat('@'); } catch (e) {} }
  else if (sh.getLastColumn() < ORDER_COLS.length) { sh.getRange(1, 1, 1, ORDER_COLS.length).setValues([ORDER_COLS]); }   // columns added later (pay_url) get their header
  return sh;
}
function consolePin_() { return String(PROP.getProperty('CONSOLE_PIN') || '4750'); }
function pinOk_(p) { return String(p || '') === consolePin_(); }
function fmtDue_(v) { if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMM d'); return String(v == null ? '' : v); }   // Sheets coerces 'Sep 19' to a Date
function rowObj_(r) { var o = {}; ORDER_COLS.forEach(function (k, i) { o[k] = r[i]; }); o.due = fmtDue_(o.due); return o; }
function orderCode_(sh) {
  var rows = sh.getDataRange().getValues(), have = {}; for (var i = 1; i < rows.length; i++) have[String(rows[i][0]).toUpperCase()] = 1;
  for (var t = 0; t < 20; t++) { var c = 'ST-' + Date.now().toString(36).toUpperCase().slice(-4) + String.fromCharCode(65 + Math.floor(Math.random() * 26)); if (!have[c]) return c; }
  return 'ST-' + Date.now().toString(36).toUpperCase();
}
function findOrder_(sh, code) {
  code = String(code || '').trim().toUpperCase(); if (!code) return null;
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (String(rows[i][0]).toUpperCase() === code) return { i: i + 1, o: rowObj_(rows[i]) };
  return null;
}
function trackUrl_(o) { return 'https://thestickytrap.app/track/?o=' + encodeURIComponent(o.code) + '&t=' + encodeURIComponent(o.token); }
function reorderUrl_(o) { var e = encodeURIComponent; return 'https://thestickytrap.app/?reorder=' + e(o.code) + '&items=' + e(String(o.items || '').slice(0, 400)) + '&name=' + e(o.name || '') + '&co=' + e(o.company || '') + '&email=' + e(o.email || '') + '&phone=' + e(o.phone || '') + '#menu'; }   // opens the app's quote form pre-filled (v22)
function stageMail_(o, stage, note) {
  if (!o.email || !STAGES[stage]) return false;
  var st = STAGES[stage], url = trackUrl_(o), who = o.company || o.name || '';
  var btn = function (label, href) { return '<a href="' + href + '" style="display:inline-block;background:#FF1FA2;color:#fff;text-decoration:none;font-weight:800;padding:12px 20px;border-radius:24px;margin:14px 0">' + label + '</a>'; };
  var html = '<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:15px;line-height:1.55">' +
    '<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;font-weight:700">The Sticky Trap - order ' + esc_(o.code) + '</div>' +
    '<h2 style="margin:6px 0 10px;font-size:22px">' + esc_(st.label) + '</h2>' +
    '<p>' + esc_(st.msg) + '</p>' + (note ? '<p style="background:#f4f2fa;padding:10px 12px;border-radius:8px"><b>Note from the shop:</b> ' + esc_(note) + '</p>' : '') +
    (o.items ? '<p style="color:#555"><b>Order:</b> ' + esc_(o.items) + (o.due ? ' &middot; <b>Due:</b> ' + esc_(o.due) : '') + '</p>' : '') +
    (stage === 'proof_sent' ? btn('Review & approve my proof', url) : btn('Track my order', url)) +
    (stage === 'quoted' && o.pay_url ? btn('Pay the invoice', o.pay_url) : '') +
    (stage === 'complete' ? btn('Reorder this job', reorderUrl_(o)) : '') +
    '<p style="color:#888;font-size:12px">Reply to this email or text 734 460 3845 with any changes. FM Holdings LLC d/b/a The Sticky Trap, 4750 Venture Dr, Suite 101, Ann Arbor, MI 48108.</p></div>';
  MailApp.sendEmail(o.email, 'Your Sticky Trap order ' + o.code + ': ' + st.label, st.label + ' - ' + st.msg + '\n' + url + (stage === 'quoted' && o.pay_url ? '\nPay: ' + o.pay_url : '') + (stage === 'complete' ? '\nReorder: ' + reorderUrl_(o) : ''), { htmlBody: html, name: 'The Sticky Trap', replyTo: SHOP_EMAIL });
  return true;
}
function orderNew_(b) {
  var email = String(b.email || '').trim().slice(0, 120), name = String(b.name || '').trim().slice(0, 80), company = String(b.company || '').trim().slice(0, 80);
  var fromConsole = pinOk_(b.pin);
  if (!fromConsole && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (!fromConsole && !throttle_('order:' + email)) return { ok: false, error: 'rate_limited' };
  var sh = ordersSheet_(), code = String(b.code || '').trim().toUpperCase().slice(0, 24) || orderCode_(sh);
  if (findOrder_(sh, code)) return { ok: false, error: 'code_exists' };
  var stage = STAGES[b.stage] ? b.stage : 'received', now = new Date(), token = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  var o = { code: code, created: now, name: name, company: company, email: email, phone: String(b.phone || '').slice(0, 40), items: String(b.items || '').slice(0, 400), due: String(b.due || '').slice(0, 40),
            stage: stage, stage_ts: now, history: JSON.stringify([{ stage: stage, ts: now.getTime(), note: '' }]), token: token, monday_item: '', square_inv: String(b.square_inv || '').slice(0, 60), nudged_ts: '', notes: '', source: String(b.source || '').slice(0, 20), pay_url: /^https:\/\//.test(String(b.pay_url || '')) ? String(b.pay_url).slice(0, 300) : '' };
  sh.appendRow(ORDER_COLS.map(function (k) { return o[k]; }));
  var emailed = false; try { emailed = stageMail_(o, stage, ''); } catch (e) {}
  return { ok: true, code: code, token: token, url: trackUrl_(o), emailed: emailed };
}
function orderStage_(b) {
  if (!pinOk_(b.pin)) return { ok: false, error: 'bad_pin' };
  var stage = String(b.stage || ''); if (!STAGES[stage]) return { ok: false, error: 'bad_stage' };
  var sh = ordersSheet_(), f = findOrder_(sh, b.code); if (!f) return { ok: false, error: 'not_found' };
  var o = f.o, now = new Date(), note = String(b.note || '').slice(0, 300), hist = []; try { hist = JSON.parse(o.history || '[]'); } catch (e) {}
  if (b.square_inv && !o.square_inv) { try { sh.getRange(f.i, ORDER_COLS.indexOf('square_inv') + 1).setValue(String(b.square_inv).slice(0, 60)); } catch (e) {} }
  if (b.pay_url && !o.pay_url && /^https:\/\//.test(String(b.pay_url))) { try { o.pay_url = String(b.pay_url).slice(0, 300); sh.getRange(f.i, ORDER_COLS.indexOf('pay_url') + 1).setValue(o.pay_url); } catch (e) {} }
  if (b.only_forward && STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(o.stage)) return { ok: true, code: o.code, stage: o.stage, skipped: true };   // automated sources never move an order backwards
  hist.push({ stage: stage, ts: now.getTime(), note: note });
  sh.getRange(f.i, ORDER_COLS.indexOf('stage') + 1, 1, 3).setValues([[stage, now, JSON.stringify(hist)]]);
  sh.getRange(f.i, ORDER_COLS.indexOf('nudged_ts') + 1).setValue('');
  o.stage = stage; o.history = JSON.stringify(hist);
  var emailed = false; try { emailed = stageMail_(o, stage, note); } catch (e) {}
  return { ok: true, code: o.code, stage: stage, emailed: emailed };
}
function approve_(b) {
  var sh = ordersSheet_(), f = findOrder_(sh, b.code); if (!f) return { ok: false, error: 'not_found' };
  var o = f.o; if (String(b.token || '') !== String(o.token)) return { ok: false, error: 'bad_token' };
  if (o.stage !== 'proof_sent' && o.stage !== 'proofing') return { ok: false, error: 'not_in_proof' };
  var now = new Date(), hist = []; try { hist = JSON.parse(o.history || '[]'); } catch (e) {}
  hist.push({ stage: 'approved', ts: now.getTime(), note: 'Approved by client online' });
  sh.getRange(f.i, ORDER_COLS.indexOf('stage') + 1, 1, 3).setValues([['approved', now, JSON.stringify(hist)]]);
  sh.getRange(f.i, ORDER_COLS.indexOf('nudged_ts') + 1).setValue('');
  try { MailApp.sendEmail(SHOP_EMAIL, 'PROOF APPROVED - ' + o.code + ' (' + (o.company || o.name) + ')', (o.company || o.name) + ' approved the proof for ' + o.code + ' online.\n' + (o.items || '') + '\nDue: ' + (o.due || 'tbd') + '\nConsole: https://thestickytrap.app/console/'); } catch (e) {}
  o.stage = 'approved'; try { stageMail_(o, 'approved', ''); } catch (e) {}
  return { ok: true };
}
function changes_(b) {   // client asks for proof changes from the tracker page (v22): back to 'proofing', note logged, shop told
  var sh = ordersSheet_(), f = findOrder_(sh, b.code); if (!f) return { ok: false, error: 'not_found' };
  var o = f.o; if (String(b.token || '') !== String(o.token)) return { ok: false, error: 'bad_token' };
  if (o.stage !== 'proof_sent' && o.stage !== 'proofing') return { ok: false, error: 'not_in_proof' };
  var note = String(b.note || '').trim().slice(0, 400); if (!note) return { ok: false, error: 'no_note' };
  var now = new Date(), hist = []; try { hist = JSON.parse(o.history || '[]'); } catch (e) {}
  hist.push({ stage: 'proofing', ts: now.getTime(), note: 'Client requested changes: ' + note });
  sh.getRange(f.i, ORDER_COLS.indexOf('stage') + 1, 1, 3).setValues([['proofing', now, JSON.stringify(hist)]]);
  sh.getRange(f.i, ORDER_COLS.indexOf('nudged_ts') + 1).setValue('');
  try { MailApp.sendEmail(notifyTo_(), 'CHANGES REQUESTED - ' + o.code + ' (' + (o.company || o.name) + ')', (o.company || o.name) + ' asked for changes to the proof for ' + o.code + ':' + '\n\n' + note + '\n\n' + (o.items || '') + '\n' + 'Due: ' + (o.due || 'tbd') + '\n' + 'Console: https://thestickytrap.app/console/?o=' + encodeURIComponent(o.code), { replyTo: o.email || SHOP_EMAIL }); } catch (e) {}
  o.stage = 'proofing'; try { stageMail_(o, 'proofing', 'We got your request - ' + note + ' - and will send a revised proof.'); } catch (e) {}
  return { ok: true };
}
function publicOrder_(o) {
  var hist = []; try { hist = JSON.parse(o.history || '[]'); } catch (e) {}
  var st = STAGES[o.stage] || STAGES.received;
  return { code: o.code, name: o.name, company: o.company, items: o.items, due: o.due, stage: o.stage, label: st.label, message: st.msg, token: o.token,
           stage_ts: o.stage_ts ? new Date(o.stage_ts).getTime() : null, can_approve: (o.stage === 'proof_sent' || o.stage === 'proofing'),
           can_change: (o.stage === 'proof_sent' || o.stage === 'proofing'), pay_url: (o.stage === 'quoted' && o.pay_url) ? o.pay_url : '', reorder_url: o.stage === 'complete' ? reorderUrl_(o) : '',
           stages: STAGE_ORDER.filter(function (k) { return k !== 'shipped' || o.stage === 'shipped'; }).filter(function (k) { return k !== 'ready' || o.stage !== 'shipped'; }).map(function (k) { return { key: k, label: STAGES[k].label }; }),
           history: hist.map(function (h) { return { stage: h.stage, label: (STAGES[h.stage] || {}).label || h.stage, ts: h.ts, note: h.note || '' }; }) };
}
function trackGet_(p) {
  var sh = ordersSheet_(), f = findOrder_(sh, p.o); if (!f) return { ok: false, error: 'not_found' };
  var o = f.o, tok = String(p.t || ''), em = String(p.e || '').trim().toLowerCase();
  if (!(tok && tok === String(o.token)) && !(em && em === String(o.email || '').trim().toLowerCase())) return { ok: false, error: 'not_found' };
  return { ok: true, order: publicOrder_(o) };
}
function ordersList_(p) {
  if (!pinOk_(p.pin)) return { ok: false, error: 'bad_pin' };
  var rows = ordersSheet_().getDataRange().getValues(), out = [];
  for (var i = 1; i < rows.length; i++) { var o = rowObj_(rows[i]); if (o.stage === 'complete') continue;
    out.push({ code: o.code, name: o.name, company: o.company, email: o.email, items: o.items, due: o.due, stage: o.stage, stage_ts: o.stage_ts ? new Date(o.stage_ts).getTime() : null }); }
  out.sort(function (a, b) { return (a.stage_ts || 0) - (b.stage_ts || 0); });
  return { ok: true, orders: out };
}
function notifyTo_() { var extra = String(PROP.getProperty('NUDGE_TO') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); return [SHOP_EMAIL].concat(extra).join(','); }   // script property NUDGE_TO = extra addresses (Erin, ...)
function nudgeStale_() {
  var sh = ordersSheet_(), rows = sh.getDataRange().getValues(), now = Date.now(), stale = [];
  for (var i = 1; i < rows.length; i++) { var o = rowObj_(rows[i]), h = NUDGE_HOURS[o.stage]; if (!h || !o.stage_ts) continue;
    var age = (now - new Date(o.stage_ts).getTime()) / 36e5, last = o.nudged_ts ? (now - new Date(o.nudged_ts).getTime()) / 36e5 : 999;
    if (age > h && last > 24) { stale.push(o.code + ' - ' + (o.company || o.name) + ' - ' + STAGES[o.stage].label + ' for ' + Math.round(age) + ' h' + (o.due ? ' (due ' + o.due + ')' : '')); sh.getRange(i + 1, ORDER_COLS.indexOf('nudged_ts') + 1).setValue(new Date()); } }
  if (!stale.length) return 0;
  MailApp.sendEmail(notifyTo_(), 'Order tracker: ' + stale.length + ' order' + (stale.length > 1 ? 's' : '') + ' need a push', stale.join('\n') + '\n\nLog the next stage: https://thestickytrap.app/console/');
  return stale.length;
}
function orderDelete_(b) {
  if (!pinOk_(b.pin)) return { ok: false, error: 'bad_pin' };
  var sh = ordersSheet_(), f = findOrder_(sh, b.code); if (!f) return { ok: false, error: 'not_found' };
  sh.deleteRow(f.i); return { ok: true, deleted: f.o.code };
}
/* ---------- Monday-morning digest: what the app did last week ---------- */
function weeklyDigest_() {
  var ss = ss_(), since = Date.now() - 7 * 864e5, tz = Session.getScriptTimeZone();
  function rowsOf(name) { var sh = ss.getSheetByName(name); return sh ? sh.getDataRange().getValues().slice(1) : []; }
  function ts(v) { return v instanceof Date ? v.getTime() : (new Date(v).getTime() || 0); }
  var chats = rowsOf('chats').filter(function (r) { return ts(r[0]) >= since && String(r[1]).indexOf('test-') !== 0; });
  var qs = chats.map(function (r) { return { q: String(r[2]).slice(0, 110), a: String(r[3]).slice(0, 110), acts: String(r[4]) }; });
  var adds = qs.filter(function (x) { return x.acts.indexOf('add_to_basket') >= 0; }).length;
  var quotes = qs.filter(function (x) { return x.acts.indexOf('open_quote_form') >= 0; }).length;
  var orders = rowsOf('orders').map(rowObj_).filter(function (o) { return String(o.code).indexOf('TEST-') !== 0; });
  var newOrders = orders.filter(function (o) { return ts(o.created) >= since; });
  var byStage = {}; orders.forEach(function (o) { if (o.stage !== 'complete') byStage[o.stage] = (byStage[o.stage] || 0) + 1; });
  var stale = orders.filter(function (o) { var h = NUDGE_HOURS[o.stage]; return h && o.stage_ts && (Date.now() - ts(o.stage_ts)) / 36e5 > h; });
  var moves = 0; orders.forEach(function (o) { try { JSON.parse(o.history || '[]').forEach(function (h) { if (h.ts >= since) moves++; }); } catch (e) {} });
  var refs = rowsOf('referrals').filter(function (r) { return ts(r[0]) >= since && String(r[2]).indexOf('test-') !== 0; }).length;
  var ndas = rowsOf('ndas').filter(function (r) { return ts(r[0]) >= since && String(r[2]).indexOf('Test Farms') !== 0; }).length;
  var players = {}; rowsOf('scores').forEach(function (r) { if (ts(r[0]) >= since && String(r[1]).indexOf('test-') !== 0) players[String(r[1])] = 1; });
  var lines = [];
  lines.push('THE STICKY TRAP APP - week ending ' + Utilities.formatDate(new Date(), tz, 'MMM d'));
  lines.push('');
  lines.push('ORDERS: ' + newOrders.length + ' new, ' + moves + ' stage change' + (moves === 1 ? '' : 's') + '. Open now: ' + (Object.keys(byStage).map(function (k) { return byStage[k] + ' ' + (STAGES[k] || {}).label; }).join(', ') || 'none') + '.');
  if (stale.length) lines.push('  Needs a push: ' + stale.map(function (o) { return o.code + ' (' + (o.company || o.name) + ', ' + (STAGES[o.stage] || {}).label + ')'; }).join('; '));
  lines.push('CHAT: ' + chats.length + ' question' + (chats.length === 1 ? '' : 's') + ' asked, ' + adds + ' basket add' + (adds === 1 ? '' : 's') + ' by the bot, ' + quotes + ' sent to the quote form.');
  lines.push('GAME: ' + Object.keys(players).length + ' player' + (Object.keys(players).length === 1 ? '' : 's') + ' posted scores. Referrals: ' + refs + '. NDAs signed: ' + ndas + '.');
  lines.push('');
  if (qs.length) { lines.push('WHAT PEOPLE ASKED THE BOT (newest first) - anything it fumbled belongs in chat-facts.txt:'); qs.slice(-30).reverse().forEach(function (x) { lines.push('  Q: ' + x.q); lines.push('     A: ' + x.a); }); }
  else lines.push('No chat questions this week.');
  lines.push('');
  lines.push('Console: https://thestickytrap.app/console/  -  Sheet: ' + ss.getUrl());
  var digestTo = String(PROP.getProperty('DIGEST_TO') || '').trim() || SHOP_EMAIL;   // Shane 2026-09-09: digest to the shop inbox only (Erin stays on the nudges via NUDGE_TO); set DIGEST_TO to widen it later
  MailApp.sendEmail(digestTo, 'Sticky Trap app - week in review', lines.join('\n'), { name: 'The Sticky Trap app' });
  return lines.length;
}
// Run ONCE from the editor: hourly stale-order nudge + Monday 7 am digest.
function installNudges() {
  ScriptApp.getProjectTriggers().forEach(function (t) { var f = t.getHandlerFunction(); if (f === 'nudgeStale_' || f === 'weeklyDigest_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('nudgeStale_').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('weeklyDigest_').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  Logger.log('installed: hourly nudgeStale_ + Monday 7am weeklyDigest_');
}

/* ---------- editor helpers ---------- */
// Run this ONCE from the editor (pick it in the function dropdown, click Run) to grant the send-mail scope;
// the web app then inherits the grant and NDA copies / referral alerts start going out.
function authorizeMail() {
  MailApp.sendEmail(SHOP_EMAIL, 'Sticky Trap chat web app: mail authorized', 'The chat web app can now send signed NDA copies and referral alerts. Sent by authorizeMail() from the Apps Script editor.');
  Logger.log('mail sent to ' + SHOP_EMAIL + ' - the web app can send email now');
}
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
