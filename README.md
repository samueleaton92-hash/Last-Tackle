 # LAST TACKLE — prototype

A single-page rugby league career sim, played like a tabletop RPG scene: you type what you do, the engine rolls dice against your attributes, and the AI narrates the result. Three files, no build step — same shape as Waybook.

## Run it locally

Open `index.html` in a browser. If fonts or anything looks broken, serve it instead:

```
cd last-tackle
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deploy to GitHub Pages

1. Create a repo (or folder in one) and upload `index.html`, `style.css`, `app.js`.
2. Repo Settings → Pages → set source to the branch/folder you uploaded to.
3. Live at `https://<username>.github.io/<repo>/`.

## What you need to play

An Anthropic API key from [console.anthropic.com](https://console.anthropic.com), with billing set up. Entered once on the setup screen, stored in `sessionStorage` (and `localStorage` too if you tick "remember"), used to call the API directly from your browser.

**The key is visible to anyone with access to your browser's dev tools or a shared session.** Fine for solo prototyping, not fine for a public release — before anyone else plays this, calls need to move behind a backend so the key never reaches a browser.

## How it plays

Every event gives you a situation and asks what you do — there are no multiple-choice buttons. You type your own action (or tap a suggestion chip to fill the box, then edit it if you like) and hit the button to resolve it.

Two kinds of events:

- **Checks** — situations with a real uncertain outcome (handling a media scandal, smoothing over a fight with a teammate, showing up for a date night). Your text is read for which of six attributes it's testing — **Power, Steel, Boot, Fitness, Charisma, Composure** — and how boldly you're playing it. The engine rolls a d20, adds your attribute's modifier, checks it against the difficulty, and the result lands in one of four tiers: critical success, success, fail, or critical failure. Playing it **bold** raises the difficulty but a success jumps straight to the best tier; playing it **cautious** lowers the difficulty but caps how good or bad the result can be.
- **Choices** — situations that are a decision, not a skill attempt (signing with a rival club, accepting a proposal, calling time on your career). Your text is matched to one of two or three fixed outcomes. No dice — you don't roll to find out who you propose to.

### Match day

Before kickoff you get one tap: **Cautious / Balanced / All out.** This widens or narrows the same variance that decides your match rating and score — bold play can produce a much better or much worse performance than balanced, cautious play is steadier but caps both ends. No typing required for this part; it's meant to happen every match without adding friction across an 18-round season.

On roughly 45% of matches, a genuine **crunch moment** fires mid-game — a last-ditch tackle to save a try, a kick to win it at the death, a rival trying to needle you into a reaction — picked based on the match state that's already been simulated (a kicking chance for a close margin, a niggle template on rivalry rounds, and so on). You type what you do, it's resolved with the same dice-check machinery as an event, and the result adjusts the actual score and your match rating before the game is finalized — a genuine success there can flip a loss into a win. It costs no extra API call: the same single narration call that writes the commentary and recap is simply given the crunch moment's result and told to make clear that specific moment, and your stated action in it, is what swung the game.

## How the game is built

The rule that matters: **the engine owns every number, including the dice roll. The AI only narrates what the engine already decided.**

Concretely, when you submit a free-text action:

1. **Skill classification** (checks only) — the engine keyword-matches your text against the attributes a "sensible" reading of the situation could test, and picks one. Plain JavaScript, instant, no API call.
2. **Boldness classification** — same idea, keyword-matched to cautious / standard / bold. Also no API call.
3. **The roll** — a real d20 + your attribute's modifier vs. the event's difficulty, computed in JS and shown as a short rolling-die animation before the result lands (skipped instantly if the browser's reduced-motion setting is on).
4. **Effects applied** — each template has hand-written, deterministic effects for each of the four result tiers (or each branch, for choice-mode events; or a score/rating delta, for match crunch moments). The roll (or branch match) decides which set applies; nothing here is AI-generated.
5. **Narration** — only now does the AI get called, and only to describe in 2-4 sentences what already happened, weaving in your own wording. It's explicitly told the outcome is fixed and it must not contradict it.

Match days work almost the same way: the engine computes a base score, key moments and injury risk from your stats, form, experience and chosen boldness; if a crunch moment fires, that's resolved with a real dice check exactly like an event, and its score/rating delta is applied on top of the base result — then the AI narrates the whole thing once, told not to invent a different final score.

The proactive tabs — Girlfriend / Team / Coach / Media / Training — stay static (a small hand-written line pool, no API call), since they're meant to be used every week without adding cost or latency.

### Why keyword-matching instead of asking the AI to classify

It would be easy to have the AI read your free text and decide which attribute to test or which branch you meant — LLMs are much better at that kind of fuzzy judgment than a keyword list. That was deliberately avoided anyway: the entire point of "the engine owns the numbers" is that nothing which can be reasoned or argued with gets to decide whether you succeed. A keyword classifier is dumber, but it's inspectable and can't be talked into a favorable ruling by clever phrasing.

The real cost of that choice: type something the keyword lists don't recognize and you'll silently get the template's default skill or branch rather than what you actually meant. The suggestion chips exist mostly to paper over this — they're phrased to hit the keyword lists reliably, so a player who doesn't want to think about exact wording can tap one. The keyword lists themselves live near the top of `app.js` (`SKILL_KEYWORDS`, `BOLD_WORDS`, `CAUTIOUS_WORDS`, and each template's `matchWords`) and are easy to extend if you find your own phrasing keeps missing.

### Cost note

Each event now costs two AI calls (opening narration + outcome narration) instead of one, since the outcome text is no longer pre-written per choice — it has to reflect whatever you actually typed. Still short, cheap calls; a full 18-round season is on the order of 25-35 calls total.

## What's in this prototype

- Six attributes (Power, Steel, Boot, Fitness, Charisma, Composure), 6 fictional clubs, 9 positions, 4 starting backgrounds
- 7 dice-check events and 10 decision events, covering career, finance, nightlife, reputation and relationships
- A deterministic match simulator: your stats + form + experience + a rival-round bonus + randomness → score, player rating (properly bounded — a debut player can't post a 9 or 10 no matter how lucky the roll), and injury risk
- A relationship neglect system: girlfriend, coach, teammates and media all quietly decay if you go 3+ weeks without an event or proactive action touching them; a badly neglected relationship can end on its own
- Proactive tabs (Girlfriend / Team / Coach / Media / Training) for once-a-week actions outside the random event roll
- An 18-round season, off-season contract step, aging, retirement (chosen or forced at 37)
- Autosave to `localStorage`, resume-on-load, "abandon career" reset

## Where it's deliberately thin (extension points)

- **17 templates, not 30-50.** Add more by copying the shape of an existing entry in `EVENT_TEMPLATES` — decide `mode: 'check'` (needs `primarySkills`, `baseDC`, `outcomeTable`) or `mode: 'choice'` (needs `branches`).
- **Keyword lists are hand-tuned, not exhaustive.** If players keep getting misclassified into the wrong skill or branch, that's the first place to look — either widen `SKILL_KEYWORDS`/`matchWords`, or accept it as a deliberate trade-off (see above).
- **4 crunch-moment templates, not a dozen.** Add more by copying the shape of an entry in `MATCH_MOMENTS` — needs `side` ('own' or 'opp'), `weight(base, player)`, `primarySkills`, `baseDC`, and an `outcomeTable`.
- **One competition, 6 clubs, no ladder/finals logic.** Every match is simulated in isolation against a semi-random opponent.
- **No consolidated long-term memory of specific events.** The visible log keeps your last few entries; older ones roll off.
- **No art.** Would come from a separate, offline image-generation pass — not runtime calls.
- **Single save slot, single device.** No accounts, no cloud sync.
