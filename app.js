// ============================================================
// LAST TACKLE — prototype
// Engine owns every number. The AI only narrates what the engine
// has already decided. See README for the split.
// ============================================================

const MODEL = 'claude-sonnet-4-6';
const SAVE_KEY = 'lastTackle.save.v1';
const KEY_STORAGE = 'lastTackle.apiKey';
const ROUNDS_PER_SEASON = 18;
const EVENT_CHANCE = 0.4;

// ---------- Static data ----------

const POSITIONS = [
  'Fullback', 'Wing', 'Centre', 'Five-eighth', 'Halfback',
  'Hooker', 'Prop', 'Second-row', 'Lock'
];

const CLUBS = [
  { id: 'storm',    name: 'Portside Storm',      tier: 7 },
  { id: 'harbour',  name: 'Harbour City Sharks',  tier: 8 },
  { id: 'westside', name: 'Westside Bulldogs',    tier: 6 },
  { id: 'valley',   name: 'Valley Warriors',      tier: 5 },
  { id: 'ironbark', name: 'Ironbark Miners',      tier: 6 },
  { id: 'coast',    name: 'Coastline Titans',     tier: 7 }
];

const RIVALS = { storm: 'harbour', harbour: 'storm', westside: 'valley', valley: 'westside', ironbark: 'coast', coast: 'ironbark' };

const BACKGROUNDS = {
  junior_star: {
    label: 'Junior rep star, expected to shine',
    statBonus: { attack: 6, defense: 2, kicking: 2, fitness: 0 },
    repStart: 35,
    intro: 'the rep-team hype that followed you into first grade'
  },
  battler: {
    label: 'Battler who fought for this contract',
    statBonus: { attack: 0, defense: 4, kicking: 0, fitness: 6 },
    repStart: 10,
    intro: 'the long, unglamorous road here — trials, cuts, one last shot that finally landed'
  },
  family_club: {
    label: 'Following family into the club',
    statBonus: { attack: 2, defense: 2, kicking: 2, fitness: 2 },
    repStart: 25,
    intro: 'a family name the fans already know, for better or worse'
  },
  import: {
    label: 'Moved cities alone to get this shot',
    statBonus: { attack: 4, defense: 4, kicking: 0, fitness: 2 },
    repStart: 18,
    intro: 'a city with no one in it you know yet'
  }
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.weight; if (r <= 0) return it; }
  return items[items.length - 1];
}
function clubName(id) { return (CLUBS.find(c => c.id === id) || {}).name || id; }

// ---------- Event templates ----------
// trigger(p): boolean eligibility. weight(p): relative pick chance.
// choices: { id, label, effects(p) -> mutates p, outcome(p, vars) -> string }
// beat(p): short fixed description of the situation fed to the AI as the "beat" —
// the AI narrates this beat, it never invents what happens.

const EVENT_TEMPLATES = [
  {
    id: 'contract_offer_rival',
    category: 'Career',
    weight: (p) => (p.contractYearsLeft <= 1 && p.age >= 20) ? 14 : 0,
    beat: (p) => {
      const rivalPool = CLUBS.filter(c => c.id !== p.club);
      const rival = pick(rivalPool);
      const offer = Math.round(p.salary * (1 + Math.random() * 0.5 + 0.1));
      return { rival, offer, text: `${rival.name} have approached your management with a ${p.contractYearsLeft + 1}-year offer worth $${offer.toLocaleString()} a season, well above what ${clubName(p.club)} are paying you now.` };
    },
    choices: [
      {
        id: 'accept',
        label: 'Sign with the rivals',
        effects: (p, v) => {
          p.relationships.teammates -= 15; p.relationships.coach -= 25;
          p.club = v.rival.id; p.salary = v.offer; p.contractYearsLeft = 3; p.reputation += 4;
        },
        outcome: (p, v) => `You sign. ${clubName(v.rival.id)} announce it within the hour — and your old dressing room finds out from the same press release you did.`
      },
      {
        id: 'decline',
        label: 'Stay loyal to your club',
        effects: (p) => { p.relationships.teammates += 10; p.relationships.coach += 15; p.reputation += 2; p.contractYearsLeft = 2; },
        outcome: () => `You knock it back without much fanfare. The club never officially thanks you for it, but the coach starts talking to you differently.`
      },
      {
        id: 'leverage',
        label: 'Use it to renegotiate where you are',
        effects: (p, v) => { p.relationships.coach -= 10; p.salary = Math.round(p.salary * 1.2); p.contractYearsLeft = 2; p.flags.usedLeverage = true; },
        outcome: () => `Management matches most of it to keep you. The coach signs off on the numbers but doesn't love how you got there.`
      }
    ]
  },
  {
    id: 'coach_tactical_clash',
    category: 'Career',
    weight: (p) => p.relationships.coach < 25 ? 10 : 4,
    beat: (p) => ({ text: `The coach pulls you aside after review. He wants you playing a tighter, more structured role — less of the ad-lib you've built your name on.` }),
    choices: [
      {
        id: 'comply',
        label: 'Play it his way',
        effects: (p) => { p.relationships.coach += 15; p.stats.defense += 3; p.form -= 5; },
        outcome: () => `You rein it in. The coach is happy. Something in your game feels smaller for a few weeks.`
      },
      {
        id: 'push_back',
        label: 'Push back and keep playing your way',
        effects: (p) => { p.relationships.coach -= 15; p.form += 8; p.reputation += 3; },
        outcome: () => `You hold your ground. It's tense in the video session, but you back yourself, and it shows on the field.`
      },
      {
        id: 'compromise',
        label: 'Find a middle ground with him',
        effects: (p) => { p.relationships.coach += 5; p.stats.attack += 1; p.stats.defense += 1; },
        outcome: () => `You meet him partway. Not everyone's fully satisfied, but nobody's fully unhappy either.`
      }
    ]
  },
  {
    id: 'captaincy_offer',
    category: 'Career',
    weight: (p) => (p.reputation >= 55 && p.age >= 24 && !p.flags.isCaptain) ? 9 : 0,
    beat: (p) => ({ text: `With the leadership group thin this year, the coach floats the idea of handing you the captaincy.` }),
    choices: [
      {
        id: 'accept_captaincy',
        label: 'Accept the armband',
        effects: (p) => { p.flags.isCaptain = true; p.reputation += 10; p.relationships.media += 10; p.salary = Math.round(p.salary * 1.1); },
        outcome: () => `You take it. The number on your jersey doesn't change, but everything else around you does.`
      },
      {
        id: 'decline_captaincy',
        label: 'Decline — not ready for the scrutiny',
        effects: (p) => { p.form += 5; p.relationships.coach -= 5; },
        outcome: () => `You turn it down. The coach respects the honesty, even if he'd hoped for a different answer.`
      }
    ]
  },
  {
    id: 'sponsorship_deal',
    category: 'Finance',
    weight: (p) => p.reputation >= 30 ? 8 : 2,
    beat: (p) => {
      const brand = pick(['a regional car dealership', 'a supplement brand', 'a local pub chain', 'a streetwear label']);
      const amount = Math.round(1000 + p.reputation * 80 + Math.random() * 4000);
      return { brand, amount, text: `${brand.charAt(0).toUpperCase() + brand.slice(1)} wants your face on their next campaign — $${amount.toLocaleString()}, six months, moderate demands on your time.` };
    },
    choices: [
      {
        id: 'sign_sponsor',
        label: 'Sign the deal',
        effects: (p, v) => { p.cash += v.amount; p.relationships.media += 5; p.form -= 2; },
        outcome: (p, v) => `Done. The ${v.brand} money lands in your account, and your face lands on a billboard you didn't expect to see on the way to training.`
      },
      {
        id: 'pass_sponsor',
        label: 'Pass — keep the focus on football',
        effects: (p) => { p.form += 3; },
        outcome: () => `You pass. Your manager isn't thrilled, but your week stays simple.`
      }
    ]
  },
  {
    id: 'investment_tip',
    category: 'Finance',
    weight: (p) => p.age >= 20 ? 6 : 0,
    beat: (p) => ({ text: `A teammate's cousin is raising money for a property flip and swears it's a sure thing. He's asking $${(5000 + Math.round(p.reputation * 30)).toLocaleString()} in.` }),
    choices: [
      {
        id: 'invest',
        label: 'Put the money in',
        effects: (p) => {
          const amount = 5000 + Math.round(p.reputation * 30);
          const win = Math.random() < 0.45;
          p.cash += win ? Math.round(amount * (0.5 + Math.random())) : -amount;
          p.flags.lastInvestOutcome = win ? 'win' : 'loss';
        },
        outcome: (p) => p.flags.lastInvestOutcome === 'win'
          ? `It actually comes off. Not life-changing money, but a nice surprise a few months later.`
          : `It falls over inside a year. The cousin stops returning calls.`
      },
      {
        id: 'skip_invest',
        label: `Keep your money where it is`,
        effects: () => {},
        outcome: () => `You wish him luck and keep your hands off your own savings.`
      }
    ]
  },
  {
    id: 'night_out_before_match',
    category: 'Nightlife',
    weight: (p) => 7,
    beat: (p) => ({ text: `Thursday night, a few of the boys are heading out. Captain's run is 9am tomorrow, then a match Saturday.` }),
    choices: [
      {
        id: 'go_big',
        label: 'Go all in, worry about it tomorrow',
        effects: (p) => { p.form -= 10; p.relationships.teammates += 8; p.relationships.coach -= 6; p.stats.fitness -= 2; },
        outcome: () => `It's a big one. Fun at the time. The captain's run the next morning is not.`
      },
      {
        id: 'one_or_two',
        label: 'Go, but keep it controlled',
        effects: (p) => { p.relationships.teammates += 5; },
        outcome: () => `You stay long enough to not be the guy who left early, and leave early enough to not regret it.`
      },
      {
        id: 'skip_night',
        label: 'Stay home, protect the week',
        effects: (p) => { p.form += 6; p.relationships.teammates -= 4; },
        outcome: () => `You skip it. Someone posts a video from the night out; you're not in it, and a couple of the boys notice.`
      }
    ]
  },
  {
    id: 'media_scandal',
    category: 'Reputation',
    weight: (p) => p.relationships.media < 0 ? 9 : 2,
    beat: (p) => ({ text: `A tabloid has run a story built on a half-true version of your night out last week, sourced from "a club insider."` }),
    choices: [
      {
        id: 'fight_back',
        label: 'Come out swinging publicly',
        effects: (p) => { p.relationships.media -= 15; p.reputation -= 5; p.relationships.teammates += 5; },
        outcome: () => `Your statement is sharp and a little too honest. The story gets more attention, not less.`
      },
      {
        id: 'no_comment',
        label: 'Say nothing, let it die',
        effects: (p) => { p.relationships.media += 2; p.form -= 3; },
        outcome: () => `You say nothing. It cycles out of the news in about four days, the way most of these do.`
      },
      {
        id: 'club_statement',
        label: 'Let the club handle the response',
        effects: (p) => { p.relationships.coach += 5; p.relationships.media += 5; },
        outcome: () => `The club's media manager puts out three careful sentences. It works better than anything you'd have said yourself.`
      }
    ]
  },
  {
    id: 'charity_appearance',
    category: 'Reputation',
    weight: () => 6,
    beat: (p) => ({ text: `The club asks if you'll spend a Wednesday afternoon visiting the children's hospital as part of the community program.` }),
    choices: [
      {
        id: 'go_charity',
        label: 'Go, and mean it',
        effects: (p) => { p.reputation += 8; p.relationships.media += 6; p.form += 2; },
        outcome: () => `It's a better afternoon than you expected. One kid asks for your headgear and you give it to him on the spot.`
      },
      {
        id: 'skip_charity',
        label: `Send apologies, too much on this week`,
        effects: (p) => { p.reputation -= 3; },
        outcome: () => `You skip it. Nobody says anything, but the community manager's next email is a little cooler than usual.`
      }
    ]
  },
  {
    id: 'teammate_conflict',
    category: 'Relationships',
    weight: (p) => p.relationships.teammates < 0 ? 10 : 3,
    beat: (p) => ({ text: `Words in the sheds after a loss. A senior teammate says, loudly, that your positioning cost the team the game.` }),
    choices: [
      {
        id: 'confront',
        label: 'Have it out with him directly',
        effects: (p) => { p.relationships.teammates -= 10; p.form += 4; },
        outcome: () => `It gets heated before someone steps between you. You clear the air, roughly.`
      },
      {
        id: 'let_it_go',
        label: 'Let it go, deal with it on the field',
        effects: (p) => { p.relationships.teammates += 6; p.form -= 4; },
        outcome: () => `You say nothing and let your next few sessions do the talking instead.`
      }
    ]
  },
  {
    id: 'new_relationship',
    category: 'Relationships',
    weight: (p) => (!p.partner && p.age >= 19) ? 6 : 0,
    beat: (p) => ({ text: `Someone keeps coming up in conversation with your mates — a friend of a friend, no connection to the club or the game.` }),
    choices: [
      {
        id: 'pursue_relationship',
        label: 'Ask them out',
        effects: (p) => { p.partner = { name: pick(['Alex', 'Maya', 'Jordan', 'Sam', 'Riley', 'Casey']), value: 20 }; p.form += 5; },
        outcome: (p) => `You go for it. It's early days, but it's good — someone in your corner who couldn't care less what round it is.`
      },
      {
        id: 'skip_relationship',
        label: 'Not the right time',
        effects: () => {},
        outcome: () => `You keep things as they are. There'll be other Saturdays.`
      }
    ]
  },
  {
    id: 'partner_ultimatum',
    category: 'Relationships',
    weight: (p) => (p.partner && p.partner.value < -5) ? 12 : 0,
    beat: (p) => ({ text: `${p.partner ? p.partner.name : 'Your partner'} sits you down. The football is taking every week, every weekend, every ounce of attention you have left.` }),
    choices: [
      {
        id: 'recommit',
        label: 'Recommit — make the time',
        effects: (p) => { p.partner.value += 25; p.form -= 4; p.relationships.coach -= 3; },
        outcome: () => `You mean it, and for a while you follow through. Training takes a small, deliberate back seat.`
      },
      {
        id: 'choose_football',
        label: 'Be honest that football comes first right now',
        effects: (p) => {
          const stay = Math.random() < 0.3;
          if (!stay) { p.partner = null; p.form -= 8; p.reputation -= 2; }
          else { p.partner.value = -5; }
          p.flags.chosePlayingCareer = true;
        },
        outcome: (p) => p.partner ? `It's a hard conversation, but you're honest, and somehow it holds.` : `The honesty costs you the relationship. It's a quiet few weeks after.`
      }
    ]
  },
  {
    id: 'family_pressure',
    category: 'Relationships',
    weight: (p) => (p.background === 'family_club' ? 8 : 3),
    beat: (p) => ({ text: `Family turns up in numbers to the next home game — the kind of crowd that expects a performance to match the name on your jersey.` }),
    choices: [
      {
        id: 'embrace_pressure',
        label: 'Embrace it, play for the name',
        effects: (p) => { p.form += 6; p.reputation += 3; },
        outcome: () => `You feed off it. The old name on your back feels less like weight and more like fuel, for once.`
      },
      {
        id: 'block_it_out',
        label: 'Block it out, play your own game',
        effects: (p) => { p.form += 2; p.relationships.family = (p.relationships.family || 0) - 3; },
        outcome: () => `You keep it strictly business and play a solid, unremarkable eighty minutes. Not everyone in the stand is satisfied.`
      }
    ]
  },
  {
    id: 'retirement_contemplation',
    category: 'Career',
    weight: (p) => p.age >= 32 ? 10 : 0,
    beat: (p) => ({ text: `Pre-season medicals come back with the usual list of ongoing niggles. Your manager asks, plainly, how many more years you think you've got in you.` }),
    choices: [
      {
        id: 'play_on',
        label: 'Sign on for another season',
        effects: (p) => { p.stats.fitness = clamp(p.stats.fitness - 4, 10, 100); p.contractYearsLeft = Math.max(p.contractYearsLeft, 1); },
        outcome: () => `You sign on. Your body notices the decision before your form does.`
      },
      {
        id: 'retire_now',
        label: 'Call it — retire at the end of this season',
        effects: (p) => { p.flags.plannedRetirement = true; },
        outcome: () => `You tell your manager first, then the coach. Word gets around the club within a day.`
      }
    ]
  }
];

// ---------- Match simulation (deterministic) ----------

function simulateMatch(player) {
  const opponentPool = CLUBS.filter(c => c.id !== player.club);
  const isRivalRound = player.round % 6 === 0;
  const opponent = isRivalRound
    ? CLUBS.find(c => c.id === RIVALS[player.club]) || pick(opponentPool)
    : pick(opponentPool);

  const formFactor = player.form / 100; // -1..1
  const skill = (player.stats.attack + player.stats.defense + player.stats.kicking) / 3;
  const playerImpact = clamp(skill * 0.5 + formFactor * 15 + (Math.random() - 0.5) * 20, -10, 40);

  const ownTeamBase = 12 + Math.random() * 14;
  const oppBase = 8 + opponent.tier * 1.6 + Math.random() * 14;

  let ownScore = Math.round(ownTeamBase + playerImpact * 0.6);
  let oppScore = Math.round(oppBase);
  ownScore = clamp(ownScore, 0, 60);
  oppScore = clamp(oppScore, 0, 60);
  // round to plausible try/goal scorelines
  ownScore = Math.round(ownScore / 2) * 2;
  oppScore = Math.round(oppScore / 2) * 2;

  const won = ownScore > oppScore;
  const margin = ownScore - oppScore;

  const rating = clamp(5 + playerImpact / 6 + (won ? 1 : -0.5), 1, 10);

  const moments = [];
  if (playerImpact > 20) moments.push({ minute: Math.floor(10 + Math.random() * 60), type: 'try_assist', tag: 'try involvement, dominant' });
  else if (playerImpact > 8) moments.push({ minute: Math.floor(10 + Math.random() * 60), type: 'good_play', tag: 'strong individual moment' });
  if (playerImpact < -5) moments.push({ minute: Math.floor(10 + Math.random() * 70), type: 'error', tag: 'costly error under pressure' });
  moments.push({ minute: Math.floor(50 + Math.random() * 30), type: won ? 'clutch' : 'fightback', tag: won ? 'held the lead late' : 'chased the game late' });
  moments.sort((a, b) => a.minute - b.minute);

  // injury chance, lower fitness = higher risk
  const injuryRoll = Math.random();
  const injuryThreshold = 0.05 + (100 - player.stats.fitness) / 100 * 0.06;
  const injured = injuryRoll < injuryThreshold;
  const injuryWeeks = injured ? (1 + Math.floor(Math.random() * 4)) : 0;

  return { opponent, ownScore, oppScore, won, margin, rating, moments, isRivalRound, injured, injuryWeeks };
}

// ---------- Player init ----------

function createPlayer(form) {
  const bg = BACKGROUNDS[form.background];
  return {
    name: form.name || 'Your player',
    position: form.position,
    background: form.background,
    club: form.club,
    age: parseInt(form.age, 10),
    season: 1,
    round: 1,
    phase: 'inseason',
    stats: {
      attack: 45 + bg.statBonus.attack,
      defense: 45 + bg.statBonus.defense,
      kicking: 40 + bg.statBonus.kicking,
      fitness: 70 + bg.statBonus.fitness
    },
    form: 0,
    reputation: bg.repStart,
    salary: 75000,
    cash: 8000,
    contractYearsLeft: 2,
    relationships: { coach: 0, teammates: 0, media: 0, family: 0 },
    partner: null,
    injuryWeeksLeft: 0,
    careerStats: { matches: 0, tries: 0, seasons: 0 },
    flags: {},
    lastTemplateId: null,
    log: [],
    ended: false,
    endingText: null
  };
}

function applyEffectsSafe(p, fn, vars) {
  try { fn(p, vars); } catch (e) { console.error('effect error', e); }
  p.form = clamp(p.form, -100, 100);
  p.reputation = clamp(p.reputation, 0, 100);
  p.stats.attack = clamp(p.stats.attack, 10, 100);
  p.stats.defense = clamp(p.stats.defense, 10, 100);
  p.stats.kicking = clamp(p.stats.kicking, 10, 100);
  p.stats.fitness = clamp(p.stats.fitness, 10, 100);
  p.relationships.coach = clamp(p.relationships.coach, -100, 100);
  p.relationships.teammates = clamp(p.relationships.teammates, -100, 100);
  p.relationships.media = clamp(p.relationships.media, -100, 100);
  if (p.partner) p.partner.value = clamp(p.partner.value, -100, 100);
  p.cash = Math.round(p.cash);
  p.salary = Math.round(p.salary);
}

function addLog(p, entry) {
  p.log.push(entry);
  if (p.log.length > 60) p.log.shift();
}

// ---------- Claude API ----------

function getApiKey() {
  return sessionStorage.getItem(KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || '';
}

async function callClaude(system, user, maxTokens = 300) {
  const key = getApiKey();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

function playerSnapshotForPrompt(p) {
  return {
    name: p.name, position: p.position, age: p.age, club: clubName(p.club),
    season: p.season, round: p.round, form: p.form, reputation: p.reputation,
    coachRelationship: p.relationships.coach, teammateRelationship: p.relationships.teammates,
    isCaptain: !!p.flags.isCaptain, partner: p.partner ? p.partner.name : null
  };
}

async function narrateEventOpening(template, vars, p) {
  const system = `You are the narrator for LAST TACKLE, a text-based rugby league career sim. You are given a fixed situation ("beat") that has already been decided by the game engine — you do not invent outcomes, stats, or choices, you only bring the moment to life. Write 2-4 short sentences, second person ("you"), grounded and understated rather than melodramatic — think of a good sports novel, not a movie trailer. No dialogue tags like 'the narrator says'. Do not mention game mechanics, numbers, or stats directly. Output only the narration, no preamble.`;
  const user = `Player: ${JSON.stringify(playerSnapshotForPrompt(p))}\nSituation: ${vars.text}`;
  return callClaude(system, user, 220);
}

async function narrateMatch(p, result) {
  const system = `You are the commentary and recap writer for LAST TACKLE, a text rugby league career sim. You are given the final match facts already decided by the game engine — never invent a different score, scorer, or outcome. Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{"commentary": ["line 1", "line 2", "line 3"], "recap": "2-3 sentence recap"}
Each commentary line is under 20 words, present tense, broadcast style, one per key moment given, in order. The recap is second person, understated, references how the player's moments shaped the result.`;
  const user = `Player: ${JSON.stringify(playerSnapshotForPrompt(p))}
Opponent: ${result.opponent.name}${result.isRivalRound ? ' (rivalry match)' : ''}
Final score: ${clubName(p.club)} ${result.ownScore} — ${result.opponent.name} ${result.oppScore}
Result: ${result.won ? 'win' : 'loss'}
Player rating (1-10): ${result.rating.toFixed(1)}
Key moments in order: ${result.moments.map(m => `minute ${m.minute}: ${m.tag}`).join('; ')}`;
  const raw = await callClaude(system, user, 400);
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return {
      commentary: result.moments.map(m => `${m.minute}': ${m.tag}.`),
      recap: result.won
        ? `A solid win. Your performance graded ${result.rating.toFixed(1)}/10 on the day.`
        : `A tough loss to take. Your performance graded ${result.rating.toFixed(1)}/10 on the day.`
    };
  }
}

// ---------- Static (no-AI) recovery week lines, cached to save calls ----------

const RECOVERY_LINES = [
  'Rehab is repetition. Ice, stretch, repeat — the injury clock ticks down slower than the season does.',
  'You spend the week on the sideline in a training bib, watching a game you can\'t play in yet.',
  'The physio says the same thing she said last week: progressing, not rushing. You believe her, mostly.',
  'A quiet week. You do the boring work nobody posts about and try not to think about the ladder.'
];

// ---------- State machine ----------

let player = null;
let uiBusy = false;

function eligibleTemplates(p) {
  return EVENT_TEMPLATES
    .filter(t => t.id !== p.lastTemplateId)
    .map(t => ({ t, weight: t.weight(p) }))
    .filter(x => x.weight > 0);
}

async function advanceWeek() {
  if (uiBusy || !player || player.ended) return;

  // Injury recovery
  if (player.injuryWeeksLeft > 0) {
    player.injuryWeeksLeft -= 1;
    player.round += 1;
    renderRecoveryWeek();
    save();
    if (player.round > ROUNDS_PER_SEASON) return handleOffseasonEntry();
    return;
  }

  // Off-season boundary
  if (player.round > ROUNDS_PER_SEASON) return handleOffseasonEntry();

  const eligible = eligibleTemplates(player);
  const doEvent = eligible.length > 0 && Math.random() < EVENT_CHANCE;

  if (doEvent) {
    const chosen = weightedPick(eligible).t;
    player.lastTemplateId = chosen.id;
    await runEvent(chosen);
  } else {
    await runMatch();
  }
}

async function runEvent(template) {
  setBusy(true);
  const vars = template.beat(player);
  renderLoading(`${template.category} · ${clubName(player.club)}`);
  try {
    const text = await narrateEventOpening(template, vars, player);
    renderEventScreen(template, vars, text);
  } catch (e) {
    renderApiError(e, () => runEvent(template));
  }
  setBusy(false);
}

function chooseOption(template, vars, choice) {
  if (uiBusy) return;
  applyEffectsSafe(player, choice.effects, vars);
  const outcomeText = typeof choice.outcome === 'function' ? choice.outcome(player, vars) : '';
  addLog(player, { season: player.season, round: player.round, headline: template.category, text: outcomeText });
  player.round += 1;
  renderOutcome(template, choice, outcomeText);
  save();
}

async function runMatch() {
  setBusy(true);
  const result = simulateMatch(player);
  renderLoading('Match day');
  try {
    const narration = await narrateMatch(player, result);
    finalizeMatch(result, narration);
  } catch (e) {
    renderApiError(e, () => runMatch());
    setBusy(false);
    return;
  }
  setBusy(false);
}

function finalizeMatch(result, narration) {
  player.careerStats.matches += 1;
  if (result.moments.some(m => m.type === 'try_assist')) player.careerStats.tries += 1;
  player.form += result.won ? 6 : -6;
  player.form += (result.rating - 5.5) * 2;
  player.reputation += result.won ? 1 : 0;
  if (result.isRivalRound) player.reputation += result.won ? 3 : -1;
  if (result.injured) {
    player.injuryWeeksLeft = result.injuryWeeks;
  }
  player.round += 1;
  applyEffectsSafe(player, () => {});
  addLog(player, { season: player.season, round: player.round - 1, headline: 'Match', text: narration.recap });
  renderMatchScreen(result, narration);
  save();
}

function handleOffseasonEntry() {
  player.careerStats.seasons += 1;
  player.contractYearsLeft = Math.max(0, player.contractYearsLeft - 1);

  if (player.flags.plannedRetirement || player.age >= 37 || player.contractYearsLeft <= 0 && player.age >= 34) {
    return endCareer();
  }

  player.season += 1;
  player.round = 1;
  player.age += 1;
  save();
  renderSeasonBreak();
}

function endCareer() {
  player.ended = true;
  const totalTries = player.careerStats.tries;
  const seasons = player.careerStats.seasons;
  player.endingText = `${player.name} played ${seasons} season${seasons === 1 ? '' : 's'} in the top grade, finishing at ${clubName(player.club)} with a reputation built as much on what happened off the field as on it. ${player.flags.isCaptain ? 'You led the side as captain before you were done.' : ''} ${totalTries > 0 ? `The team sheet will remember the tries; the sheds will remember something else entirely.` : ''}`.replace(/\s+/g, ' ').trim();
  save();
  renderEnding();
}

// ---------- Rendering ----------

const stage = document.getElementById('stage');
const sheetInner = document.getElementById('sheetInner');
const topbarMeta = document.getElementById('topbarMeta');
const toastEl = document.getElementById('toast');

function setBusy(v) { uiBusy = v; }

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function renderTopbar() {
  if (!player) return;
  topbarMeta.textContent = `Season ${player.season} · Round ${Math.min(player.round, ROUNDS_PER_SEASON)} · ${clubName(player.club)}`;
}

function renderSheet() {
  if (!player) return;
  const p = player;
  const formLabel = p.form > 25 ? 'Hot' : p.form > 5 ? 'Good' : p.form > -5 ? 'Steady' : p.form > -25 ? 'Cold' : 'Struggling';
  sheetInner.innerHTML = `
    <div class="sheet-block">
      <div class="sheet-headline">${escapeHtml(p.name)}</div>
      <div class="sheet-subline">${p.position} · Age ${p.age} · ${clubName(p.club)}${p.flags.isCaptain ? ' (C)' : ''}</div>
      <div class="tag-row">
        ${p.injuryWeeksLeft > 0 ? `<span class="tag warn">Injured · ${p.injuryWeeksLeft}wk</span>` : ''}
        <span class="tag ${p.form > 5 ? 'good' : ''}">${formLabel}</span>
        ${p.partner ? `<span class="tag">With ${escapeHtml(p.partner.name)}</span>` : ''}
      </div>
    </div>
    <div class="sheet-block">
      <div class="sheet-label">CAREER</div>
      <div class="stat-row"><span>Reputation</span><span class="v">${Math.round(p.reputation)}</span></div>
      <div class="stat-row"><span>Salary</span><span class="v">$${p.salary.toLocaleString()}</span></div>
      <div class="stat-row"><span>Savings</span><span class="v">$${p.cash.toLocaleString()}</span></div>
      <div class="stat-row"><span>Contract</span><span class="v">${p.contractYearsLeft} yr left</span></div>
      <div class="stat-row"><span>Matches</span><span class="v">${p.careerStats.matches}</span></div>
    </div>
    <div class="sheet-block">
      <div class="sheet-label">ATTRIBUTES</div>
      <div class="stat-row"><span>Attack</span><span class="v">${Math.round(p.stats.attack)}</span></div>
      <div class="stat-row"><span>Defense</span><span class="v">${Math.round(p.stats.defense)}</span></div>
      <div class="stat-row"><span>Kicking</span><span class="v">${Math.round(p.stats.kicking)}</span></div>
      <div class="stat-row"><span>Fitness</span><span class="v">${Math.round(p.stats.fitness)}</span></div>
    </div>
    <div class="sheet-block">
      <div class="sheet-label">RELATIONSHIPS</div>
      <div class="stat-row"><span>Coach</span><span class="v">${relLabel(p.relationships.coach)}</span></div>
      <div class="stat-row"><span>Teammates</span><span class="v">${relLabel(p.relationships.teammates)}</span></div>
      <div class="stat-row"><span>Media</span><span class="v">${relLabel(p.relationships.media)}</span></div>
      ${p.partner ? `<div class="stat-row"><span>${escapeHtml(p.partner.name)}</span><span class="v">${relLabel(p.partner.value)}</span></div>` : ''}
    </div>
    <button class="btn btn-ghost sheet-reset" id="resetBtn">Abandon career</button>
  `;
  document.getElementById('resetBtn').addEventListener('click', confirmReset);
}

function relLabel(v) {
  if (v > 40) return 'Strong';
  if (v > 10) return 'Good';
  if (v > -10) return 'Neutral';
  if (v > -40) return 'Strained';
  return 'Broken';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLoading(label) {
  stage.innerHTML = `<div class="week-tag">${escapeHtml(label)}</div><p class="loading-line">Writing the next chapter…</p>`;
}

function renderApiError(err, retryFn) {
  console.error(err);
  stage.innerHTML = `
    <div class="week-tag">Connection problem</div>
    <p class="narrative">The game couldn't reach the Claude API. Check your API key and that your Anthropic account has credit, then try again.<br><br><span style="opacity:.6;font-size:13px">${escapeHtml(err.message || String(err))}</span></p>
    <button class="btn btn-primary" id="retryBtn">Try again</button>
  `;
  document.getElementById('retryBtn').addEventListener('click', retryFn);
}

function renderEventScreen(template, vars, text) {
  renderTopbar();
  const choicesHtml = template.choices.map((c, i) => `
    <button class="choice-btn" data-idx="${i}">${escapeHtml(c.label)}</button>
  `).join('');
  stage.innerHTML = `
    <div class="week-tag">${template.category} · Season ${player.season}, Round ${player.round}</div>
    <div class="narrative">${escapeHtml(text).split(/\n+/).map(p => `<p>${p}</p>`).join('')}</div>
    <div class="choices">${choicesHtml}</div>
    ${renderLogHtml()}
  `;
  stage.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => chooseOption(template, vars, template.choices[parseInt(btn.dataset.idx, 10)]));
  });
  renderSheet();
}

function renderOutcome(template, choice, outcomeText) {
  renderTopbar();
  stage.innerHTML = `
    <div class="week-tag">${template.category} · Season ${player.season}</div>
    <div class="narrative"><p>${escapeHtml(outcomeText)}</p></div>
    <div class="continue-row"><button class="btn btn-primary" id="continueBtn">Continue</button></div>
    ${renderLogHtml()}
  `;
  document.getElementById('continueBtn').addEventListener('click', advanceWeek);
  renderSheet();
}

function renderRecoveryWeek() {
  renderTopbar();
  const line = RECOVERY_LINES[Math.floor(Math.random() * RECOVERY_LINES.length)];
  stage.innerHTML = `
    <div class="week-tag">Injured · Season ${player.season}, Round ${Math.min(player.round, ROUNDS_PER_SEASON)}</div>
    <div class="narrative"><p>${escapeHtml(line)}</p><p style="opacity:.6;font-size:14px">${player.injuryWeeksLeft > 0 ? `${player.injuryWeeksLeft} week${player.injuryWeeksLeft === 1 ? '' : 's'} until you're expected back.` : `Cleared to play again.`}</p></div>
    <div class="continue-row"><button class="btn btn-primary" id="continueBtn">Continue</button></div>
    ${renderLogHtml()}
  `;
  document.getElementById('continueBtn').addEventListener('click', advanceWeek);
  renderSheet();
}

function renderMatchScreen(result, narration) {
  renderTopbar();
  const momentsHtml = result.moments.map((m, i) => `
    <li class="moment"><span class="moment-min">${m.minute}'</span><span>${escapeHtml(narration.commentary[i] || m.tag)}</span></li>
  `).join('');
  stage.innerHTML = `
    <div class="week-tag">${result.isRivalRound ? 'Rivalry match' : 'Match day'} · Season ${player.season}, Round ${player.round - 1}</div>
    <div class="scoreboard">
      <div class="scoreboard-teams">
        <span class="scoreboard-team">${escapeHtml(clubName(player.club))}</span>
        <span class="scoreboard-score">${result.ownScore}</span>
        <span class="scoreboard-vs">v</span>
        <span class="scoreboard-score">${result.oppScore}</span>
        <span class="scoreboard-team">${escapeHtml(result.opponent.name)}</span>
      </div>
      <div class="scoreboard-ft">FULL TIME · ${result.won ? 'WIN' : 'LOSS'} · RATED ${result.rating.toFixed(1)}/10</div>
    </div>
    <ul class="moments">${momentsHtml}</ul>
    <div class="narrative"><p>${escapeHtml(narration.recap)}</p>${result.injured ? `<p style="color:var(--blood)">You're going off with an injury — expect ${result.injuryWeeks} week${result.injuryWeeks === 1 ? '' : 's'} on the sideline.</p>` : ''}</div>
    <div class="continue-row"><button class="btn btn-primary" id="continueBtn">Continue</button></div>
    ${renderLogHtml()}
  `;
  document.getElementById('continueBtn').addEventListener('click', advanceWeek);
  renderSheet();
}

function renderSeasonBreak() {
  renderTopbar();
  stage.innerHTML = `
    <div class="week-tag">Off-season · Season ${player.season - 1} complete</div>
    <div class="event-title">Pre-season</div>
    <div class="narrative"><p>The off-season passes in a blur of gym sessions and review meetings. You're a year older, contract clock ticking, and Season ${player.season} is about to start.</p></div>
    <div class="continue-row"><button class="btn btn-primary" id="continueBtn">Start the season</button></div>
    ${renderLogHtml()}
  `;
  document.getElementById('continueBtn').addEventListener('click', advanceWeek);
  renderSheet();
}

function renderEnding() {
  renderTopbar();
  stage.innerHTML = `
    <div class="week-tag">Career over</div>
    <div class="event-title">Final whistle</div>
    <div class="narrative"><p>${escapeHtml(player.endingText)}</p></div>
    <div class="continue-row"><button class="btn btn-primary" id="newCareerBtn">Start a new career</button></div>
  `;
  document.getElementById('newCareerBtn').addEventListener('click', () => { clearSave(); location.reload(); });
  renderSheet();
}

function renderLogHtml() {
  if (!player.log.length) return '';
  const recent = player.log.slice(-4).reverse();
  return `<div style="margin-top:26px">${recent.map(e => `
    <div class="log-entry">
      <div class="week-tag">S${e.season} R${e.round} · ${escapeHtml(e.headline)}</div>
      <div class="narrative" style="margin-bottom:0"><p>${escapeHtml(e.text || '')}</p></div>
    </div>
  `).join('')}</div>`;
}

function confirmReset() {
  if (confirm('Abandon this career? This cannot be undone.')) {
    clearSave();
    location.reload();
  }
}

// ---------- Save / load ----------

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(player)); } catch (e) { console.error(e); }
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSave() {
  localStorage.removeItem(SAVE_KEY);
}

// ---------- Setup wiring ----------

function populateSelects() {
  const posSel = document.getElementById('pPosition');
  POSITIONS.forEach(p => posSel.add(new Option(p, p)));
  const clubSel = document.getElementById('pClub');
  CLUBS.forEach(c => clubSel.add(new Option(c.name, c.id)));
}

function initSetup() {
  populateSelects();

  const savedKey = localStorage.getItem(KEY_STORAGE);
  if (savedKey) {
    document.getElementById('apiKey').value = savedKey;
    document.getElementById('rememberKey').checked = true;
  }

  const existing = loadSave();
  if (existing && !existing.ended) {
    document.getElementById('resumeCard').hidden = false;
    document.getElementById('resumeSummary').innerHTML =
      `<b>${escapeHtml(existing.name)}</b> — ${existing.position}, ${clubName(existing.club)}. Season ${existing.season}, Round ${Math.min(existing.round, ROUNDS_PER_SEASON)}.`;
    document.getElementById('createCard').hidden = true;
  }

  document.getElementById('resumeBtn').addEventListener('click', () => {
    if (!captureKey()) return;
    player = existing;
    startGame();
  });
  document.getElementById('newInsteadBtn').addEventListener('click', () => {
    document.getElementById('resumeCard').hidden = true;
    document.getElementById('createCard').hidden = false;
  });

  document.getElementById('beginBtn').addEventListener('click', () => {
    if (!captureKey()) return;
    const name = document.getElementById('pName').value.trim();
    if (!name) { toast('Give your player a name first.'); return; }
    const form = {
      name,
      position: document.getElementById('pPosition').value,
      club: document.getElementById('pClub').value,
      age: document.getElementById('pAge').value,
      background: document.getElementById('pBackground').value
    };
    player = createPlayer(form);
    save();
    startGame();
  });
}

function captureKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) { toast('Enter your Anthropic API key first.'); return false; }
  sessionStorage.setItem(KEY_STORAGE, key);
  if (document.getElementById('rememberKey').checked) {
    localStorage.setItem(KEY_STORAGE, key);
  } else {
    localStorage.removeItem(KEY_STORAGE);
  }
  return true;
}

function startGame() {
  document.getElementById('setup').hidden = true;
  document.getElementById('game').hidden = false;
  renderTopbar();
  renderSheet();
  advanceWeek();
}

function initSheetToggle() {
  const toggle = document.getElementById('sheetToggle');
  const sheet = document.getElementById('sheet');
  const glyph = document.getElementById('sheetToggleGlyph');
  toggle.addEventListener('click', () => {
    const open = sheet.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    glyph.textContent = open ? '▴' : '▾';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  initSheetToggle();
});
