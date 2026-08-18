# The Sticky Trap Hub

A phone-installable **PWA** that ties together every Sticky Trap / Flower Room link **and** serves the daily **Cannabis + Psychedelics** industry brief — live, self-updating, with an archive.

Static site, no build step. Designed for **GitHub Pages** (or any static host).

## How it works
- `index.html` fetches [`data/briefs.json`](data/briefs.json) on load and renders the **latest** brief + an **archive** of past days.
- The daily cloud routine ("Daily Morning Brief") researches the news and **commits a new brief to the top of `data/briefs.json`** each morning → the site updates itself. That's the data pipe.
- Installable: open on a phone → Share → **Add to Home Screen**.

## `data/briefs.json` schema (what the routine writes)
Prepend a new object to `briefs` (newest first). Keep `updated` = the newest date.
```json
{
  "updated": "YYYY-MM-DD",
  "briefs": [
    {
      "date": "YYYY-MM-DD",
      "label": "Cannabis + Psychedelics",
      "title": "one-line headline",
      "top": "the single biggest development, 1–2 sentences",
      "sections": [
        {
          "name": "🌿 Cannabis",
          "items": [ { "text": "…", "source": "Publisher", "url": "https://…" } ],
          "angle": "one debatable podcast talking point"
        },
        {
          "name": "🍄 Psychedelics",
          "items": [ { "text": "…", "source": "Publisher", "url": "https://…" } ],
          "angle": "…"
        }
      ],
      "why": "one sentence tying it to The Sticky Trap"
    }
  ]
}
```
Keep the array trimmed (e.g. newest ~30) so the file stays small.

## Deploy (one-time)
1. Push this repo to GitHub.
2. Settings → Pages → Deploy from branch → `main` / root.
3. Site lives at `https://<user>.github.io/<repo>/`.

## The daily pipe (one-time)
The "Daily Morning Brief" cloud routine gets: this repo cloned + a repo-scoped token, and a prompt to (a) research, (b) prepend the new brief to `data/briefs.json` in the schema above, (c) commit & push. Then the site is hands-off.

## TODO — real newsletter
The signup is currently a `mailto` placeholder. Wire a real email service (e.g. Buttondown/Substack) to own the list and send the brief to subscribers.

## Files
`index.html` · `data/briefs.json` · `manifest.webmanifest` · `sw.js` · `icons/` · `.nojekyll`
