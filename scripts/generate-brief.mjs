#!/usr/bin/env node
/**
 * Daily Industry Brief generator for the Sticky Trap app.
 * Runs on GitHub Actions. Uses the Anthropic Messages API with the
 * server-side web_search tool to research current Michigan + national
 * cannabis / psychedelics news, then writes data/briefs.json.
 *
 * Requires env ANTHROPIC_API_KEY. Model can be overridden with BRIEF_MODEL.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}
const MODEL = process.env.BRIEF_MODEL || 'claude-sonnet-5';
const OUT = 'data/briefs.json';
const CHANNEL = 'https://www.youtube.com/@theflowerroompodcast';

// Authoritative date = the runner's UTC date.
const today = new Date().toISOString().slice(0, 10);

const PROMPT = `You are the newsroom for THE STICKY TRAP (a branding / sticker / label / packaging shop in Ann Arbor, Michigan) and its cannabis-culture podcast THE FLOWER ROOM. Today is ${today}.

Research the MOST RECENT news (aim for the last 24-72 hours) using web search, then write today's industry brief. Split coverage into two sections:

LOCAL (Michigan) — Detroit / Ann Arbor / Lansing. Lead with the UPSIDE for operators: new store/brand launches and expansions, strong sales or demand, product innovation, awards and events, and any relief or favorable movement on the 24% wholesale tax, lawsuit, or the governor's race. Still note the key hard news (tax, closures, enforcement) — but frame the operator's opportunity or path forward, not just the damage.

NATIONAL — lead with momentum and opportunity: progress on cannabis rescheduling / DEA, favorable federal or state policy, funding / M&A / expansion by major brands, breakthrough products, and psychedelics wins (FDA progress, psilocybin, Compass Pathways, MDMA, functional mushrooms). Cover setbacks too, but keep the angle forward-looking.

Rules:
- Use ONLY real facts from real sources you actually found via search. NEVER invent facts, sources, or URLs.
- Prefer what is genuinely new today. Skip evergreen filler.
- Exactly 5 items per section. Each item: one or two tight, specific sentences, with the outlet name and the real article URL.
- Keep the tone sharp and useful to an industry operator.
- POSITIVE LEAN: prioritize wins, growth, and opportunity; when a story is hard news, find the constructive, forward-looking angle. Aim for roughly a 2:1 ratio of upbeat/opportunity items to hard-news items in each section, and make the headline and lede optimistic. NEVER spin or fabricate to seem positive — credibility comes first; report real facts and let the selection and framing carry the optimism.

After researching, output the brief as a single JSON object between the exact markers shown below, and put NOTHING else between the markers. Shape:

===BRIEF_START===
{
  "date": "${today}",
  "label": "Morning Brief",
  "title": "<punchy headline tying local + national together>",
  "top": "<2-sentence lede on the biggest developments>",
  "local": [
    { "text": "<specific 1-2 sentences>", "source": "<outlet>", "url": "<real url>" }
  ],
  "national": [
    { "text": "<specific 1-2 sentences>", "source": "<outlet>", "url": "<real url>" }
  ]
}
===BRIEF_END===

Both "local" and "national" must have exactly 5 items.`;

async function callAnthropic() {
  // The web_search tool can return stop_reason "pause_turn" when a search runs long;
  // feed the partial turn back and continue until the model finishes (end_turn).
  const messages = [{ role: 'user', content: PROMPT }];
  let last = null;
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
        messages,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 1000)}`);
    }
    last = await res.json();
    console.log(`turn ${turn}: stop_reason=${last.stop_reason} blocks=${(last.content || []).map((b) => b.type).join(',')}`);
    if (last.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: last.content });
      continue;
    }
    return last;
  }
  return last;
}

function extractText(msg) {
  return (msg.content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function parseBrief(text) {
  const start = text.indexOf('===BRIEF_START===');
  const end = text.indexOf('===BRIEF_END===');
  let json;
  if (start !== -1 && end !== -1 && end > start) {
    json = text.slice(start + '===BRIEF_START==='.length, end).trim();
  } else {
    // Fallbacks: a ```json fence, then the outermost object mentioning "local".
    let m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m && /"local"/.test(m[1])) json = m[1].trim();
    else {
      m = text.match(/\{[\s\S]*"local"[\s\S]*\}/);
      if (!m) throw new Error('No brief JSON found. text[0..1500]=\n' + text.slice(0, 1500));
      json = m[0];
    }
  }
  return JSON.parse(json.replace(/^```(?:json)?/, '').replace(/```$/, '').trim());
}

function validate(brief) {
  const problems = [];
  for (const k of ['title', 'top', 'local', 'national']) {
    if (!brief[k]) problems.push(`missing ${k}`);
  }
  for (const sec of ['local', 'national']) {
    const arr = brief[sec];
    if (!Array.isArray(arr) || arr.length < 3) {
      problems.push(`${sec} needs >=3 items (got ${Array.isArray(arr) ? arr.length : 'none'})`);
      continue;
    }
    arr.forEach((it, i) => {
      if (!it || !it.text || !it.url) problems.push(`${sec}[${i}] missing text/url`);
    });
  }
  if (problems.length) throw new Error('Brief validation failed: ' + problems.join('; '));
}

async function generate() {
  const msg = await callAnthropic();
  const text = extractText(msg);
  if (!text.trim()) {
    throw new Error(`Empty model text. stop_reason=${msg && msg.stop_reason} blocks=${(msg && msg.content || []).map((b) => b.type).join(',')}`);
  }
  const brief = parseBrief(text);
  brief.date = today;
  brief.label = 'Morning Brief';
  validate(brief);
  return brief;
}

(async () => {
  let brief = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { brief = await generate(); break; }
    catch (e) { lastErr = e; console.error(`Attempt ${attempt} failed: ${e.message}`); }
  }
  if (!brief) { console.error(lastErr && (lastErr.stack || String(lastErr))); process.exit(1); }

  const file = { updated: today, channel: CHANNEL, briefs: [brief] };
  let prev = '';
  try { prev = readFileSync(OUT, 'utf8'); } catch {}
  const next = JSON.stringify(file, null, 2) + '\n';
  if (prev.trim() === next.trim()) {
    console.log('Brief unchanged; nothing to write.');
    return;
  }
  writeFileSync(OUT, next);
  console.log(`Wrote ${OUT} for ${today}: ${brief.title}`);
})();
