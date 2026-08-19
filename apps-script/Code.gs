/**
 * The Sticky Trap Hub — backend + newsletter (Google Apps Script web app)
 * ---------------------------------------------------------------------------
 * Endpoints
 *   GET  ?action=brief[&callback=fn]                    -> latest briefs JSON (JSONP if callback)
 *   GET  ?action=subscribe&email=..[&callback=fn]       -> add a subscriber
 *   GET  ?action=unsubscribe&email=..                   -> remove a subscriber (email footer link)
 *   POST {secret, brief:{...}, send:true}               -> store brief + email subscribers (the cloud routine calls this)
 *
 * ONE-TIME SETUP
 *   1) Paste this into a new Apps Script project (script.google.com).
 *   2) Run  setup()  once (authorize it). It creates the data Sheet and a publish secret,
 *      and logs the Sheet URL + the secret (View > Logs).
 *   3) Deploy > New deployment > Web app > Execute as: Me · Who has access: Anyone. Copy the /exec URL.
 *   4) Run  getConfig()  anytime to re-print the Sheet URL, the secret, and the web-app URL.
 */

var PROP = PropertiesService.getScriptProperties();
var MAX_BRIEFS = 30;

function setup() {
  var id = PROP.getProperty('SHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('Sticky Trap Hub — Data');
    id = ss.getId();
    PROP.setProperty('SHEET_ID', id);
    var subs = ss.getActiveSheet(); subs.setName('subscribers'); subs.appendRow(['email', 'subscribed_at']);
    var br = ss.insertSheet('briefs'); br.appendRow(['date', 'json']);
  }
  if (!PROP.getProperty('PUBLISH_SECRET')) {
    PROP.setProperty('PUBLISH_SECRET', Utilities.getUuid());
  }
  getConfig();
}

function getConfig() {
  var id = PROP.getProperty('SHEET_ID');
  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  Logger.log('SHEET:  https://docs.google.com/spreadsheets/d/' + id +
             '\nSECRET: ' + PROP.getProperty('PUBLISH_SECRET') +
             '\nWEBAPP: ' + (url || '(deploy first, then re-run getConfig)'));
}

function ss_() { return SpreadsheetApp.openById(PROP.getProperty('SHEET_ID')); }
function sheet_(name) { return ss_().getSheetByName(name); }

function out_(obj, cb) {
  var s = JSON.stringify(obj);
  if (cb) return ContentService.createTextOutput(cb + '(' + s + ')')
                               .setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---------- GET ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback;
  try {
    if (p.action === 'brief')       return out_(getBriefs_(), cb);
    if (p.action === 'subscribe')   return out_(subscribe_(p.email), cb);
    if (p.action === 'unsubscribe') return unsubHtml_(unsubscribe_(p.email));
    return out_({ ok: true, service: 'sticky-trap-hub' }, cb);
  } catch (err) {
    return out_({ ok: false, error: String(err) }, cb);
  }
}

function getBriefs_() {
  var sh = sheet_('briefs'), last = sh.getLastRow(), briefs = [];
  if (last > 1) {
    var rows = sh.getRange(2, 1, last - 1, 2).getValues();
    rows.sort(function (a, b) { return a[0] < b[0] ? 1 : -1; }); // newest date first
    for (var i = 0; i < rows.length; i++) { try { briefs.push(JSON.parse(rows[i][1])); } catch (e) {} }
  }
  return { updated: briefs[0] ? briefs[0].date : '', briefs: briefs.slice(0, MAX_BRIEFS) };
}

function subscribe_(email) {
  email = (email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid_email' };
  var sh = sheet_('subscribers');
  var have = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().join('|') : '';
  if (have.indexOf(email) === -1) sh.appendRow([email, new Date()]);
  return { ok: true, subscribed: true };
}

function unsubscribe_(email) {
  email = (email || '').trim().toLowerCase();
  var sh = sheet_('subscribers'), last = sh.getLastRow();
  if (last > 1) {
    var col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = col.length - 1; i >= 0; i--) {
      if (String(col[i][0]).toLowerCase() === email) sh.deleteRow(i + 2);
    }
  }
  return email;
}

function unsubHtml_(email) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,Arial;padding:40px;text-align:center">' +
    '<h2>Unsubscribed</h2><p>' + esc_(email) + ' has been removed from the Morning Brief.</p></div>');
}

/* ---------- POST (cloud routine) ---------- */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== PROP.getProperty('PUBLISH_SECRET')) return out_({ ok: false, error: 'unauthorized' });
    var brief = body.brief;
    if (!brief || !brief.date) return out_({ ok: false, error: 'missing_brief' });

    var sh = sheet_('briefs'), last = sh.getLastRow(), replaced = false;
    if (last > 1) {
      var dates = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < dates.length; i++) {
        if (String(dates[i][0]) === String(brief.date)) { sh.getRange(i + 2, 2).setValue(JSON.stringify(brief)); replaced = true; break; }
      }
    }
    if (!replaced) sh.appendRow([brief.date, JSON.stringify(brief)]);

    var emailed = (body.send === false) ? 0 : emailBrief_(brief);
    return out_({ ok: true, stored: true, replaced: replaced, emailed: emailed });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function emailBrief_(brief) {
  var sh = sheet_('subscribers');
  if (sh.getLastRow() < 2) return 0;
  var emails = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var subject = 'Morning Brief — ' + brief.date + ' · ' + brief.title;
  var n = 0;
  for (var i = 0; i < emails.length; i++) {
    var to = String(emails[i][0]).trim();
    if (!to) continue;
    try {
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: renderEmail_(brief, to), name: 'The Sticky Trap' });
      n++;
    } catch (err) { /* quota hit or bad address — skip, keep going */ }
  }
  return n;
}

function renderEmail_(b, to) {
  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  var unsub = url ? (url + '?action=unsubscribe&email=' + encodeURIComponent(to)) : 'mailto:thestickytrap@gmail.com?subject=unsubscribe';
  var h = '<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:auto;color:#15171d;line-height:1.5">';
  h += '<div style="font-weight:800;font-size:20px;color:#7a3cf0">The Sticky Trap — Morning Brief</div>';
  h += '<div style="font-size:12px;color:#888;margin-bottom:8px">' + esc_(b.label || '') + ' · ' + esc_(b.date) + '</div>';
  h += '<h2 style="font-size:18px;margin:10px 0 6px">' + esc_(b.title) + '</h2>';
  h += '<p><b>Top story:</b> ' + esc_(b.top) + '</p>';
  (b.sections || []).forEach(function (s) {
    h += '<h3 style="margin:16px 0 6px">' + esc_(s.name) + '</h3><ul>';
    (s.items || []).forEach(function (it) {
      h += '<li style="margin:5px 0">' + esc_(it.text) +
           (it.url ? ' — <a href="' + esc_(it.url) + '">' + esc_(it.source || 'source') + '</a>' : '') + '</li>';
    });
    h += '</ul>';
    if (s.angle) h += '<p style="color:#a06a00;font-style:italic">🎙️ Podcast angle: ' + esc_(s.angle) + '</p>';
  });
  if (b.why) h += '<p style="border-top:1px solid #eee;padding-top:10px"><b>Why it matters to The Sticky Trap:</b> ' + esc_(b.why) + '</p>';
  h += '<p style="font-size:11px;color:#aaa;border-top:1px solid #eee;padding-top:10px;margin-top:14px">' +
       'The Sticky Trap · Ann Arbor · <a href="' + esc_(unsub) + '">unsubscribe</a></p></div>';
  return h;
}

/* ---------- test helper ---------- */
function testEmail() {
  // sends today's stored brief to YOU only, without touching the list
  var b = getBriefs_().briefs[0];
  if (!b) { Logger.log('No brief stored yet.'); return; }
  MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: '[TEST] ' + b.title, htmlBody: renderEmail_(b, Session.getActiveUser().getEmail()), name: 'The Sticky Trap' });
  Logger.log('Test sent to ' + Session.getActiveUser().getEmail());
}
