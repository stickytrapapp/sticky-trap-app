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

LOCAL (Michigan) — Detroit / Ann Arbor / Lansing. Focus on: the 24% cannabis wholesale tax and the industry lawsuit challenging it, wholesale/retail prices, dispensary or grower closures and layoffs, regulatory enforcement, and cannabis politics (the governor's race, legislation).

NATIONAL — cannabis rescheduling / DEA, federal hemp-THC policy, and major cannabis business moves; PLUS psychedelics (FDA actions, psilocybin, Compass Pathways, MDMA, functional mushrooms).

Rules:
- Use ONLY real facts from real sources you actually found via search. NEVER invent facts, sources, or URLs.
- Prefer what is genuinely new today. Skip evergreen filler.
- Exactly 5 items per section. Each item: one or two tight, specific sentences, with the outlet name and the real article URL.
- Keep the tone sharp and useful to an industry operator.

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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 1000)}`);
  }
  return res.json();
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
    // Fallback: grab the outermost JSON object that mentions "local".
    const m = text.match(/\{[\s\S]*"local"[\s\S]*\}/);
    if (!m) throw new Error('No brief JSON found in model output:\n' + text.slice(0, 2000));
    json = m[0];
  }
  return JSON.parse(json);
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

(async () => {
  const msg = await callAnthropic();
  const text = extractText(msg);
  const brief = parseBrief(text);

  // Force the authoritative date and required fixed fields.
  brief.date = today;
  brief.label = 'Morning Brief';
  validate(brief);

  const file = {
    updated: today,
    channel: CHANNEL,
    briefs: [brief],
  };

  // Only rewrite if content actually changed (keeps history clean).
  let prev = '';
  try { prev = readFileSync(OUT, 'utf8'); } catch {}
  const next = JSON.stringify(file, null, 2) + '\n';
  if (prev.trim() === next.trim()) {
    console.log('Brief unchanged; nothing to write.');
    return;
  }
  writeFileSync(OUT, next);
  console.log(`Wrote ${OUT} for ${today}: ${brief.title}`);
})().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
