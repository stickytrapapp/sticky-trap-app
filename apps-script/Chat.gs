/**
 * The Sticky Trap — app chat backend (STANDALONE Google Apps Script web app)
 * ---------------------------------------------------------------------------
 * Powers the "Ask us" chat panel in the app. The browser POSTs the conversation here; this
 * script grounds Claude in the knowledge base the app publishes at
 * https://thestickytrap.app/data/chat-kb.txt (built by Price Engine/make_chat_kb.py) and
 * returns the reply. The Anthropic key never leaves this script.
 *
 * Keep this its OWN Apps Script project (like the usage tracker) — do not merge it into the main
 * backend, whose deployments are tangled.
 *
 * ONE-TIME SETUP (~2 min)
 *   1) script.google.com → New project → rename it "Sticky Trap — Chat" → paste this file over Code.gs.
 *   2) Project Settings (gear) → Script Properties → Add:  ANTHROPIC_API_KEY = sk-ant-…
 *      (optional overrides: MODEL, KB_URL, MAX_PER_HOUR — see DEFAULTS below)
 *   3) Ctrl+S — save BEFORE deploying; a deployment snapshots the last SAVED code.
 *   4) Deploy → New deployment → type Web app → Execute as: Me · Who has access: Anyone → Deploy.
 *      Authorize when prompted. Copy the …/exec URL.
 *   5) In index.html set  var CHAT_URL='<that /exec URL>';  commit + push (push = deploy).
 *
 * CHECKS
 *   • Open  <exec URL>?ping=1  in a browser → {"ok":true,"key":true,"kb":<chars>,…}
 *   • In the editor run  selfTest()  → View › Logs shows a real answer from Claude.
 *   • Chats are logged anonymously to a self-created Sheet "Sticky Trap — App Chats";
 *     run getConfig() to print its URL.
 *
 * PROTOCOL
 *   POST body (sent as text/plain so the browser skips the CORS preflight):
 *     {"uid":"…","messages":[{"role":"user"|"assistant","content":"…"}, …]}
 *   Response: {"ok":true,"reply":"…"}  or  {"ok":false,"error":"…","reply":"<friendly fallback>"}
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
  MAX_TOKENS: 700
};
function cfg_(k) { return PROP.getProperty(k) || DEFAULTS[k]; }

var FALLBACK = "I'm having trouble answering right now. Call or text 734 460 3845, email thestickytrap@gmail.com, or tap Start a project in the Connect tab and we'll help you directly.";
var BUSY = "Lots of questions coming in — give me a minute and try again, or call/text 734 460 3845.";

var SYSTEM = [
  "You are the in-app assistant for The Sticky Trap, a design house and sticker/label print shop in Ann Arbor, Michigan.",
  "You're chatting with customers inside the Sticky Trap phone app (tabs: Industry, Social, Menu, Specs, Connect, Play).",
  "Answer from the knowledge base below. Be warm, direct and brief — this is a small chat panel: usually one to four short sentences, plain text.",
  "No markdown headers, tables or bold; a short list with one item per line and a leading dash is fine.",
  "Quote prices exactly as listed (per piece, USD) and name the material and finish tier you're quoting. Apply the volume breaks only as the rules state and show the math when you total an order.",
  "If something isn't in the knowledge base — turnaround, rush, shipping, hours, items or materials not on the menu, design or pre-press cost, orders over 1,000 — don't guess: say it's quoted per project and point them to call/text 734 460 3845, email thestickytrap@gmail.com, or the basket / Start a project quote flow in the app.",
  "Never invent prices, discounts or promises. Don't ask for personal details; when they're ready to order, steer them to the basket or the quote form.",
  "Reply in the customer's language. If asked what you are: a Sticky Trap assistant powered by Claude.",
  "", "KNOWLEDGE BASE:", ""
].join("\n");

/* ---------- HTTP ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.ping) {
    var kb = ''; try { kb = kb_(); } catch (err) { kb = ''; }
    return out_({ ok: true, key: !!PROP.getProperty('ANTHROPIC_API_KEY'), model: cfg_('MODEL'), kb: kb.length, kb_url: cfg_('KB_URL') });
  }
  return out_({ ok: true, hint: 'POST {uid, messages:[{role,content}]}' });
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

  try {
    var r = ask_(msgs);
    log_(uid, msgs[msgs.length - 1].content, r.reply, r.usage, r.model);
    return out_({ ok: true, reply: r.reply });
  } catch (err) {
    log_(uid, msgs[msgs.length - 1].content, 'ERROR ' + String(err), null, cfg_('MODEL'));
    return out_({ ok: false, error: String(err).slice(0, 200), reply: FALLBACK });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- request hygiene ---------- */
// Keep only well-formed user/assistant text, cap length + count, and force strict alternation
// starting (and ending) with a user turn — the Messages API rejects anything else.
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

/* ---------- Claude ---------- */
function ask_(msgs) {
  var kb = kb_();
  var payload = {
    model: cfg_('MODEL'),
    max_tokens: +cfg_('MAX_TOKENS'),
    // The KB is stable across requests → one cache breakpoint on the whole system prompt.
    system: [{ type: 'text', text: SYSTEM + kb, cache_control: { type: 'ephemeral' } }],
    messages: msgs,
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
  var data = JSON.parse(text);
  if (data.stop_reason === 'refusal') return { reply: FALLBACK, usage: data.usage, model: data.model };
  var reply = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('').trim();
  if (!reply) throw new Error('empty_reply');
  return { reply: reply, usage: data.usage, model: data.model };
}

/* ---------- logging (anonymous: device id, question, answer, tokens) ---------- */
function ss_() {
  var id = PROP.getProperty('CHAT_SHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('Sticky Trap — App Chats');
    id = ss.getId(); PROP.setProperty('CHAT_SHEET_ID', id);
    var sh = ss.getActiveSheet(); sh.setName('chats');
    sh.appendRow(['ts', 'device_id', 'question', 'answer', 'in_tokens', 'out_tokens', 'cache_read', 'model']);
  }
  return SpreadsheetApp.openById(id);
}
function log_(uid, q, a, usage, model) {
  try {
    var sh = ss_().getSheetByName('chats');
    sh.appendRow([new Date(), uid, String(q).slice(0, 500), String(a).slice(0, 2000),
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
  var r = ask_([{ role: 'user', content: 'How much is a 3" slap in holographic, and what is the minimum order?' }]);
  Logger.log(r.reply + '\n\nusage: ' + JSON.stringify(r.usage) + '\nmodel: ' + r.model);
}
