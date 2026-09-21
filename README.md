# LAST TACKLE — prototype

A single-page rugby league career sim. Three files, no build step, runs anywhere static files can be served — same shape as Waybook.

## Run it locally

Just open `index.html` in a browser. No server needed for a first look, though some browsers restrict local file access oddly — if fonts or anything look broken, serve it instead:

```
cd last-tackle
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deploy to GitHub Pages (same steps as Waybook)

1. Create a new repo (or a folder in an existing one) and upload `index.html`, `style.css`, `app.js`.
2. Repo Settings → Pages → set source to the branch/folder you uploaded to.
3. Your game is live at `https://<username>.github.io/<repo>/`.

## What you need to play

An Anthropic API key from [console.anthropic.com](https://console.anthropic.com), with billing/credit set up. The key is entered once on the setup screen and used to call the API directly from your browser — it's stored in `sessionStorage` always, and in `localStorage` too if you tick "remember."

**This means the key is visible to anyone who opens your browser's dev tools or who you share the deployed link with as a live session.** That's fine for solo prototyping. It is *not* fine for a real public release — before anyone else plays this, the API calls need to move behind a backend of your own so your key never reaches a browser. Flagged in the earlier build discussion, still true here.

## How the game is built

The split that matters: **the engine owns every number, the AI only narrates.**

- `app.js` holds the entire simulation: player stats, club data, event templates with fixed triggers/effects/choices, and a deterministic match simulator. None of that touches the API.
- The AI is called in exactly two places:
  1. **Event narration** — given a fixed "beat" (a plain-English situation the engine already decided, e.g. "a rival club has offered $X"), the AI writes 2-4 sentences of flavor text. It never decides what happens next; the choices and their effects are hard-coded in the template.
  2. **Match commentary + recap** — given the final score, key moment types and minutes (all computed in JS), the AI writes broadcast-style lines and a short recap. It's told explicitly not to invent a different result.
- Choice **outcomes** (the short text after you pick an option) are hand-written per choice, not AI-generated — this keeps the common path cheap and fast, and reserves the AI call for the one moment per event that benefits most from unique phrasing (see the "cache aggressively" note from the design discussion).
- Recovery-week text (injury sidelined) cycles through a small static pool — no API call at all. Same reasoning.

This is different from Waybook, where the AI narrated *and* tracked all state via a hidden JSON block. Here state lives in a plain JS object (`player`) and is saved to `localStorage` after every action — the AI has no way to drift the numbers, because it never sees or sets them.

## What's actually in this prototype

- 6 fictional clubs, 9 positions, 4 starting backgrounds
- 13 event templates across career / finance / nightlife / reputation / relationships, each with 2-3 choices and real (if simple) trade-offs
- A deterministic match simulator: your stats + form + a rival-round bonus + randomness → score, player rating, injury risk
- An 18-round season, off-season contract step, aging, retirement (chosen or forced at 37)
- Autosave to `localStorage`, resume-on-load, "abandon career" reset

## Where it's deliberately thin (extension points)

- **13 templates, not 30-50.** Easy to add more — copy the shape of any existing template in `EVENT_TEMPLATES` in `app.js`. Each needs a `weight(p)` eligibility function, a `beat(p)` situation, and 2-3 `choices` with `effects` and `outcome`.
- **One competition, 6 clubs, no ladder/finals logic.** The season currently doesn't track other clubs' results or a competition table — every match is simulated in isolation against a semi-random opponent. A ladder would be a good next system to build, still entirely in JS, no AI needed.
- **No consolidated long-term memory of specific events.** The visible log keeps your last few entries; older ones just roll off. If you want the AI to occasionally reference something from three seasons ago, you'd want a short rolling summary (built the same way Waybook's history consolidation worked), regenerated every N rounds via one more API call.
- **No art.** Portraits/club crests would come from a separate, offline image-generation pass — not runtime calls — per the earlier discussion on cost and consistency.
- **Single save slot, single device.** No accounts, no cloud sync.

## Cost note

Two API calls per event/match at most (one narration call), each capped at a few hundred tokens. A full season (18 rounds, roughly 40% of which are events rather than matches) is on the order of 20-25 calls. Cheap to iterate on, but keep an eye on usage if you're testing repeatedly.
