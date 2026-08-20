#!/usr/bin/env python3
"""
Refresh data/episodes.json from The Flower Room YouTube RSS feed.

- Pulls the channel feed server-side (no CORS issue here).
- MERGES: keeps curated titles for episodes we already have; only adds
  genuinely new videos (by id). Newest first.
- Writes the file only when something changed.
- Prints "CHANGED: <n> new" or "NOCHANGE" so a scheduler can decide
  whether to commit + push.

Run manually any time:  python tools/update_episodes.py
"""
import json, sys, os, urllib.request
import xml.etree.ElementTree as ET

CHANNEL_ID = "UCbapblj0hpQMPyeUXt2NyiA"  # The Flower Room
FEED = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "episodes.json")

ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"


def fetch_feed():
    req = urllib.request.Request(FEED, headers={"User-Agent": "sticky-trap-app/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    eps = []
    for e in root.findall(f"{ATOM}entry"):
        vid = e.findtext(f"{YT}videoId") or ""
        title = (e.findtext(f"{ATOM}title") or "").strip()
        pub = e.findtext(f"{ATOM}published") or ""
        if vid:
            eps.append({"id": vid, "title": title, "published": pub})
    return eps


def main():
    try:
        feed_eps = parse(fetch_feed())
    except Exception as ex:
        print(f"ERROR fetching/parsing feed: {ex}", file=sys.stderr)
        return 2
    if not feed_eps:
        print("ERROR: feed returned no episodes", file=sys.stderr)
        return 2

    # existing (curated) file
    existing = {"episodes": []}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            existing = json.load(f)
    by_id = {e["id"]: e for e in existing.get("episodes", [])}

    new_count = 0
    for fe in feed_eps:
        if fe["id"] in by_id:
            # keep curated title; refresh published just in case it was blank
            if not by_id[fe["id"]].get("published"):
                by_id[fe["id"]]["published"] = fe["published"]
        else:
            by_id[fe["id"]] = fe
            new_count += 1

    # newest first by published date
    merged = sorted(by_id.values(), key=lambda e: e.get("published", ""), reverse=True)

    if new_count == 0 and merged == existing.get("episodes", []):
        print("NOCHANGE")
        return 0

    from datetime import date
    out = {
        "ok": True,
        "updated": date.today().isoformat(),
        "channel": "https://www.youtube.com/@theflowerroompodcast",
        "episodes": merged,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"CHANGED: {new_count} new" if new_count else "CHANGED: metadata")
    return 0


if __name__ == "__main__":
    sys.exit(main())
