// ============================================================
// LAST TACKLE — prototype
// Engine owns every number, including the dice. The player types
// what they do; the engine deterministically picks which attribute
// is being tested and how bold the approach is, rolls a d20 against
// it, and only THEN asks the AI to narrate what already happened.
// See README for the full split.
// ============================================================

const MODEL = 'claude-sonnet-4-6';
const SAVE_KEY = 'lastTackle.save.v2';
const KEY_STORAGE = 'lastTackle.apiKey';
const ROUNDS_PER_SEASON = 18;
const EVENT_CHANCE = 0.4;
const NEGLECT_THRESHOLD = 3; // weeks of silence before a relationship starts to slide

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

// Six D&D-style attributes. Power/Steel/Boot/Fitness are physical,
// Charisma/Composure are social and mental — free-text actions need
// both, since not every scene on this game is decided on the field.
const ATTRS = ['power', 'steel', 'boot', 'fitness', 'charisma', 'composure'];
const ATTR_LABELS = { power: 'Power', steel: 'Steel', boot: 'Boot', fitness: 'Fitness', charisma: 'Charisma', composure: 'Composure' };

const BACKGROUNDS = {
  junior_star: {
    label: 'Junior rep star, expected to shine',
    statBonus: { power: 6, steel: 2, boot: 2, fitness: 0, charisma: 4, composure: -2 },
    repStart: 35,
    intro: 'the rep-team hype that followed you into first grade'
  },
  battler: {
    label: 'Battler who fought for this contract',
    statBonus: { power: 0, steel: 4, boot: 0, fitness: 6, charisma: 0, composure: 6 },
    repStart: 10,
    intro: 'the long, unglamorous road here — trials, cuts, one last shot that finally landed'
  },
  family_club: {
    label: 'Following family into the club',
    statBonus: { power: 2, steel: 2, boot: 2, fitness: 2, charisma: 2, composure: 2 },
    repStart: 25,
    intro: 'a family name the fans already know, for better or worse'
  },
  import: {
    label: 'Moved cities alone to get this shot',
    statBonus: { power: 4, steel: 4, boot: 0, fitness: 2, charisma: -2, composure: 0 },
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

// ---------- Dice & free-text classification (all deterministic JS — ----------
// ---------- the AI never touches the roll or the classification)    ----------

function modifier(statValue) { return Math.round((statValue - 50) / 10); } // ~ -4..+5

function rollCheck(statValue, baseDC, boldness) {
  const dc = baseDC + (boldness === 'cautious' ? -2 : boldness === 'bold' ? 3 : 0);
  const d20 = 1 + Math.floor(Math.random() * 20);
  const mod = modifier(statValue);
  const total = d20 + mod;
  let degree;
  if (d20 === 20) degree = 'critSuccess';
  else if (d20 === 1) degree = 'critFail';
  else if (boldness === 'cautious') degree = total >= dc ? 'success' : 'fail';
  else if (boldness === 'bold') degree = total >= dc ? 'critSuccess' : 'critFail';
  else {
    if (total >= dc + 8) degree = 'critSuccess';
    else if (total >= dc) degree = 'success';
    else if (total >= dc - 8) degree = 'fail';
    else degree = 'critFail';
  }
  return { d20, mod, total, dc, boldness, degree };
}

const SKILL_KEYWORDS = {
  charisma: ['talk', 'charm', 'joke', 'laugh', 'explain', 'persuade', 'chat', 'smile', 'compliment', 'apolog', 'win them over', 'disarm', 'flirt'],
  composure: ['calm', 'breathe', 'focus', 'ignore', 'hold', 'patient', 'quiet', 'steady', 'professional', 'walk away', 'let it go', 'block it out', 'block out'],
  power: ['push', 'aggress', 'confront', 'shove', 'force', 'go hard', 'physical'],
  steel: ['stand my ground', 'stand ground', 'defend', 'brace', 'hold firm', 'stay strong', 'firm', 'tough it out'],
  boot: ['kick', 'boot'],
  fitness: ['run', 'train', 'grind', 'push through', 'work harder', 'extra session']
};

function classifySkill(text, allowedSkills) {
  const lower = text.toLowerCase();
  for (const skill of allowedSkills) {
    const kws = SKILL_KEYWORDS[skill] || [];
    if (kws.some(k => lower.includes(k))) return skill;
  }
  return allowedSkills[0];
}

const BOLD_WORDS = ['all in', 'go big', 'risk it', 'all out', 'no matter what', 'everything', 'full send', 'go for it', 'balls to the wall', 'all-in'];
const CAUTIOUS_WORDS = ['carefully', 'quietly', 'small', 'safe', 'a little', 'gently', 'low-key', 'just a', 'play it safe', 'cautious'];

function classifyBoldness(text) {
  const lower = text.toLowerCase();
  if (BOLD_WORDS.some(w => lower.includes(w))) return 'bold';
  if (CAUTIOUS_WORDS.some(w => lower.includes(w))) return 'cautious';
  return 'standard';
}

function classifyBranch(text, branches) {
  const lower = text.toLowerCase();
  for (const b of branches) {
    if (b.matchWords.some(w => lower.includes(w))) return b;
  }
  return branches.find(b => b.default) || branches[0];
}

// ---------- Event templates ----------
// mode: 'check' — free text is classified into one of primarySkills, a
//   boldness, then resolved with a real dice roll against outcomeTable.
// mode: 'choice' — free text is classified into one of a few fixed
//   branches (a decision, not a skill attempt) — no roll, no chance
//   involved, just "which way did you go."
// Every outcomeTable/branch entry sets effects(p, vars) — deterministic —
// and a hint — a plain-English fact the AI is given to narrate, never to
// invent or contradict.

const EVENT_TEMPLATES = [
  // ---------------- CHECK (dice) events ----------------
  {
    id: 'coach_tactical_clash',
    category: 'Career',
    mode: 'check',
    touches: ['coach'],
    weight: (p) => p.relationships.coach < 25 ? 10 : 4,
    primarySkills: ['composure', 'steel'],
    baseDC: 13,
    beat: () => ({ text: `The coach pulls you aside after review. He wants you playing a tighter, more structured role — less of the ad-lib you've built your name on. What do you say to him?` }),
    suggestions: ['I push back and tell him I play better my own way', 'I hear him out and agree to tighten up', 'I try to find a middle ground with him'],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.relationships.coach += 20; p.form += 10; p.reputation += 2; }, hint: 'You make your case so convincingly he not only backs off, he sounds a little impressed.' },
      success:     { effects: (p) => { p.relationships.coach += 8; p.form += 3; }, hint: `You hold a reasonable middle ground. Nobody's fully happy, but nobody's fully unhappy either.` },
      fail:        { effects: (p) => { p.relationships.coach -= 10; p.form -= 5; }, hint: 'It comes out clumsier than you meant. He hears defiance where you meant confidence.' },
      critFail:    { effects: (p) => { p.relationships.coach -= 20; p.form -= 8; p.reputation -= 2; }, hint: 'It turns into a real argument. Word of it reaches the rest of the sheds by afternoon training.' }
    }
  },
  {
    id: 'night_out_before_match',
    category: 'Nightlife',
    mode: 'check',
    touches: ['teammates'],
    weight: () => 7,
    primarySkills: ['composure', 'fitness'],
    baseDC: 12,
    beat: () => ({ text: `Thursday night, a few of the boys are heading out. Captain's run is 9am tomorrow, then a match Saturday. What's your move?` }),
    suggestions: ['I go big and worry about tomorrow later', 'I go for one or two, nothing crazy', 'I stay home and protect the week'],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.relationships.teammates += 12; p.form += 4; }, hint: 'You strike the balance perfectly — good time, no damage, the boys respect it.' },
      success:     { effects: (p) => { p.relationships.teammates += 6; p.form += 1; }, hint: `A solid, unremarkable night. You're there, you're sharp enough for the run.` },
      fail:        { effects: (p) => { p.form -= 8; p.relationships.coach -= 4; }, hint: `It runs later than planned. The captain's run the next morning is not kind to you.` },
      critFail:    { effects: (p) => { p.form -= 15; p.stats.fitness -= 4; p.relationships.coach -= 8; }, hint: `It's a big one, bigger than intended. You're a passenger at training and everyone can tell.` }
    }
  },
  {
    id: 'media_scandal',
    category: 'Reputation',
    mode: 'check',
    touches: ['media'],
    weight: (p) => p.relationships.media < 0 ? 9 : 2,
    primarySkills: ['charisma', 'composure'],
    baseDC: 14,
    beat: () => ({ text: `A tabloid has run a story built on a half-true version of your night out last week, sourced from "a club insider." How do you handle it?` }),
    suggestions: ['I put out a sharp, honest statement myself', 'I say absolutely nothing and let it blow over', `I let the club's media team handle it`],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.relationships.media += 15; p.reputation += 5; }, hint: 'Your response is measured and disarming. It ends the story instead of feeding it.' },
      success:     { effects: (p) => { p.relationships.media += 5; }, hint: 'It\'s handled adequately. The story fades out over a few days, the way most of these do.' },
      fail:        { effects: (p) => { p.relationships.media -= 10; p.reputation -= 3; }, hint: 'It comes across defensive. The story gets a second life instead of dying quietly.' },
      critFail:    { effects: (p) => { p.relationships.media -= 20; p.reputation -= 6; p.relationships.teammates -= 5; }, hint: 'It backfires badly — a line gets clipped out of context and goes everywhere.' }
    }
  },
  {
    id: 'teammate_conflict',
    category: 'Relationships',
    mode: 'check',
    touches: ['teammates'],
    weight: (p) => p.relationships.teammates < 0 ? 10 : 3,
    primarySkills: ['composure', 'steel'],
    baseDC: 12,
    beat: () => ({ text: `Words in the sheds after a loss. A senior teammate says, loudly, that your positioning cost the team the game. What do you do?` }),
    suggestions: ['I confront him about it directly', 'I let it go and prove it on the field instead', 'I try to defuse it with a joke'],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.relationships.teammates += 15; p.form += 5; }, hint: 'You handle it with a mix of steel and grace that actually earns his respect.' },
      success:     { effects: (p) => { p.relationships.teammates += 5; }, hint: `It's tense but you get through it without it becoming a bigger issue.` },
      fail:        { effects: (p) => { p.relationships.teammates -= 8; p.form -= 3; }, hint: 'It escalates further than it needed to before someone steps between you.' },
      critFail:    { effects: (p) => { p.relationships.teammates -= 18; p.relationships.coach -= 5; }, hint: `It turns into a proper blow-up. The coach hears about it before you've even showered.` }
    }
  },
  {
    id: 'partner_date_night',
    category: 'Relationships',
    mode: 'check',
    touches: ['partner'],
    weight: (p) => (p.partner ? 10 : 0),
    primarySkills: ['charisma', 'composure'],
    baseDC: 11,
    beat: (p) => ({ text: `${p.partner.name} books a table somewhere neither of you have been, no real occasion, just a night you're both free. How do you show up for it?` }),
    suggestions: ['I put my phone away completely and focus on them', `I go, but I'll probably check the group chat`, 'I try to make it a really big, memorable night'],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.partner.value += 18; p.form += 4; }, hint: `It's one of the best nights you've had in ages, and it isn't close.` },
      success:     { effects: (p) => { p.partner.value += 8; }, hint: 'A good, simple night together. Nothing dramatic, just present.' },
      fail:        { effects: (p) => { p.partner.value -= 6; }, hint: `You're there, but you're not really there, and they notice.` },
      critFail:    { effects: (p) => { p.partner.value -= 14; p.form -= 3; }, hint: 'The phone checks turn into a real argument halfway through dinner.' }
    }
  },
  {
    id: 'partner_distance_strain',
    category: 'Relationships',
    mode: 'check',
    touches: ['partner'],
    weight: (p) => (p.partner && p.partner.value < 25 ? 11 : 3),
    primarySkills: ['composure', 'charisma'],
    baseDC: 13,
    beat: (p) => ({ text: `Training, recovery, review, repeat — ${p.partner.name} points out you've eaten dinner together twice this month. What do you say?` }),
    suggestions: ['I clear proper time for us this week, no excuses', 'I explain honestly how demanding the season is right now', `I promise it'll ease up after finals`],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.partner.value += 20; }, hint: `You actually follow through, and it's exactly what was needed.` },
      success:     { effects: (p) => { p.partner.value += 8; }, hint: 'It\'s a fair conversation. Things ease, a little.' },
      fail:        { effects: (p) => { p.partner.value -= 8; }, hint: `It's the same conversation you've half-had before. Nothing really changes.` },
      critFail:    { effects: (p) => { p.partner.value -= 18; }, hint: `It lands badly. The promise sounds hollow even as you're saying it.` }
    }
  },
  {
    id: 'family_pressure',
    category: 'Relationships',
    mode: 'check',
    touches: [],
    weight: (p) => (p.background === 'family_club' ? 8 : 3),
    primarySkills: ['composure'],
    baseDC: 12,
    beat: () => ({ text: `Family turns up in numbers to the next home game — the kind of crowd that expects a performance to match the name on your jersey. How do you carry that?` }),
    suggestions: ['I embrace it and play for the name', 'I block it out and just play my own game', `I try not to think about it at all`],
    outcomeTable: {
      critSuccess: { effects: (p) => { p.form += 10; p.reputation += 4; }, hint: `You feed off it completely. It's one of those days everything just clicks.` },
      success:     { effects: (p) => { p.form += 4; }, hint: 'A solid, professional performance. You get through it fine.' },
      fail:        { effects: (p) => { p.form -= 4; }, hint: `The weight of it gets into your head more than you'd like to admit.` },
      critFail:    { effects: (p) => { p.form -= 10; p.reputation -= 2; }, hint: `It visibly rattles you. Not your day, and everyone in the stand can see why.` }
    }
  },

  // ---------------- CHOICE (decision, no roll) events ----------------
  {
    id: 'contract_offer_rival',
    category: 'Career',
    mode: 'choice',
    touches: ['coach'],
    weight: (p) => (p.contractYearsLeft <= 1 && p.age >= 20) ? 14 : 0,
    beat: (p) => {
      const rivalPool = CLUBS.filter(c => c.id !== p.club);
      const rival = pick(rivalPool);
      const offer = Math.round(p.salary * (1 + Math.random() * 0.5 + 0.1));
      return { rival, offer, text: `${rival.name} have approached your management with a ${p.contractYearsLeft + 1}-year offer worth $${offer.toLocaleString()} a season, well above what ${clubName(p.club)} are paying you now. What do you do?` };
    },
    suggestions: ['Sign with the rivals', 'Stay loyal to my club', 'Use it to renegotiate here'],
    branches: [
      {
        id: 'accept', matchWords: ['sign', 'accept', 'go', 'leave', 'join', 'rivals'],
        effects: (p, v) => { p.relationships.teammates -= 15; p.relationships.coach -= 25; p.club = v.rival.id; p.salary = v.offer; p.contractYearsLeft = 3; p.reputation += 4; },
        hint: (v) => `You sign. ${v.rival.name} announce it within the hour — and your old dressing room finds out from the same press release you did.`
      },
      {
        id: 'decline', matchWords: ['stay', 'loyal', 'decline', 'remain', 'no'], default: true,
        effects: (p) => { p.relationships.teammates += 10; p.relationships.coach += 15; p.reputation += 2; p.contractYearsLeft = 2; },
        hint: () => `You knock it back without much fanfare. The club never officially thanks you for it, but the coach starts talking to you differently.`
      },
      {
        id: 'leverage', matchWords: ['leverage', 'renegotiate', 'use it', 'more money', 'push for'],
        effects: (p) => { p.relationships.coach -= 10; p.salary = Math.round(p.salary * 1.2); p.contractYearsLeft = 2; p.flags.usedLeverage = true; },
        hint: () => `Management matches most of it to keep you. The coach signs off on the numbers but doesn't love how you got there.`
      }
    ]
  },
  {
    id: 'captaincy_offer',
    category: 'Career',
    mode: 'choice',
    touches: ['coach'],
    weight: (p) => (p.reputation >= 55 && p.age >= 24 && !p.flags.isCaptain) ? 9 : 0,
    beat: () => ({ text: `With the leadership group thin this year, the coach floats the idea of handing you the captaincy. What do you tell him?` }),
    suggestions: ['I accept the armband', `I'm not ready for that kind of scrutiny`],
    branches: [
      { id: 'accept', matchWords: ['yes', 'accept', 'take it', 'armband', 'honoured', 'honored'], default: true,
        effects: (p) => { p.flags.isCaptain = true; p.reputation += 10; p.relationships.media += 10; p.salary = Math.round(p.salary * 1.1); },
        hint: () => `You take it. The number on your jersey doesn't change, but everything else around you does.` },
      { id: 'decline', matchWords: ['no', 'decline', 'not ready', 'pass'],
        effects: (p) => { p.form += 5; p.relationships.coach -= 5; },
        hint: () => `You turn it down. The coach respects the honesty, even if he'd hoped for a different answer.` }
    ]
  },
  {
    id: 'sponsorship_deal',
    category: 'Finance',
    mode: 'choice',
    touches: ['media'],
    weight: (p) => p.reputation >= 30 ? 8 : 2,
    beat: (p) => {
      const brand = pick(['a regional car dealership', 'a supplement brand', 'a local pub chain', 'a streetwear label']);
      const amount = Math.round(1000 + p.reputation * 80 + Math.random() * 4000);
      return { brand, amount, text: `${brand.charAt(0).toUpperCase() + brand.slice(1)} wants your face on their next campaign — $${amount.toLocaleString()}, six months, moderate demands on your time. Interested?` };
    },
    suggestions: ['Sign the deal', 'Pass — keep the focus on football'],
    branches: [
      { id: 'sign', matchWords: ['sign', 'yes', 'take', 'deal', 'do it'], default: true,
        effects: (p, v) => { p.cash += v.amount; p.relationships.media += 5; p.form -= 2; },
        hint: (v) => `Done. The ${v.brand} money lands in your account, and your face lands on a billboard you didn't expect to see on the way to training.` },
      { id: 'pass', matchWords: ['pass', 'no', 'skip', 'not interested'],
        effects: (p) => { p.form += 3; },
        hint: () => `You pass. Your manager isn't thrilled, but your week stays simple.` }
    ]
  },
  {
    id: 'investment_tip',
    category: 'Finance',
    mode: 'choice',
    touches: [],
    weight: (p) => p.age >= 20 ? 6 : 0,
    beat: (p) => ({ text: `A teammate's cousin is raising money for a property flip and swears it's a sure thing. He's asking $${(5000 + Math.round(p.reputation * 30)).toLocaleString()} in. Are you putting money in?` }),
    suggestions: ['Put the money in', `Keep my money where it is`],
    branches: [
      { id: 'invest', matchWords: ['invest', 'put', 'yes', 'in', 'do it'],
        effects: (p) => {
          const amount = 5000 + Math.round(p.reputation * 30);
          const win = Math.random() < 0.45;
          p.cash += win ? Math.round(amount * (0.5 + Math.random())) : -amount;
          p.flags.lastInvestOutcome = win ? 'win' : 'loss';
        },
        hint: (v, p) => p.flags.lastInvestOutcome === 'win' ? `It actually comes off. Not life-changing money, but a nice surprise a few months later.` : `It falls over inside a year. The cousin stops returning calls.` },
      { id: 'skip', matchWords: ['no', 'skip', 'pass', 'keep'], default: true,
        effects: () => {},
        hint: () => `You wish him luck and keep your hands off your own savings.` }
    ]
  },
  {
    id: 'charity_appearance',
    category: 'Reputation',
    mode: 'choice',
    touches: ['media'],
    weight: () => 6,
    beat: () => ({ text: `The club asks if you'll spend a Wednesday afternoon visiting the children's hospital as part of the community program. Are you going?` }),
    suggestions: ['Go, and mean it', `Send apologies, too much on this week`],
    branches: [
      { id: 'go', matchWords: ['go', 'yes', 'attend', 'sure'], default: true,
        effects: (p) => { p.reputation += 8; p.relationships.media += 6; p.form += 2; },
        hint: () => `It's a better afternoon than you expected. One kid asks for your headgear and you give it to him on the spot.` },
      { id: 'skip', matchWords: ['no', 'skip', 'busy', 'apolog'],
        effects: (p) => { p.reputation -= 3; },
        hint: () => `You skip it. Nobody says anything, but the community manager's next email is a little cooler than usual.` }
    ]
  },
  {
    id: 'new_relationship',
    category: 'Relationships',
    mode: 'choice',
    touches: ['partner'],
    weight: (p) => (!p.partner && p.age >= 19) ? 8 : 0,
    beat: () => ({ text: `Someone keeps coming up in conversation with your mates — a friend of a friend, no connection to the club or the game. Do you do anything about it?` }),
    suggestions: ['Ask them out', 'Not the right time'],
    branches: [
      { id: 'pursue', matchWords: ['ask', 'yes', 'pursue', 'go for it', 'do it'], default: true,
        effects: (p) => { p.partner = { name: pick(['Alex', 'Maya', 'Jordan', 'Sam', 'Riley', 'Casey']), value: 20 }; p.form += 5; },
        hint: () => `You go for it. It's early days, but it's good — someone in your corner who couldn't care less what round it is.` },
      { id: 'skip', matchWords: ['no', 'not', 'skip', 'later'],
        effects: () => {},
        hint: () => `You keep things as they are. There'll be other Saturdays.` }
    ]
  },
  {
    id: 'partner_moving_in',
    category: 'Relationships',
    mode: 'choice',
    touches: ['partner'],
    weight: (p) => (p.partner && p.partner.value > 30 && p.season >= 2 && !p.flags.movedIn ? 9 : 0),
    beat: (p) => ({ text: `${p.partner.name} raises it carefully, like they've been rehearsing it: maybe it's time you both got a place together. What do you say?` }),
    suggestions: ['Say yes', 'Ask for more time'],
    branches: [
      { id: 'yes', matchWords: ['yes', 'say yes', 'sure', 'do it'], default: true,
        effects: (p) => { p.flags.movedIn = true; p.partner.value += 18; p.cash -= 3000; p.form += 4; },
        hint: (v, p) => `You say yes. Moving boxes into a place that's actually both of yours feels bigger than any win so far this season.` },
      { id: 'wait', matchWords: ['more time', 'not yet', 'wait', 'no'],
        effects: (p) => { p.partner.value -= 10; },
        hint: (v, p) => `You ask for more time. ${p.partner.name} says that's fine, in a tone that means it isn't, quite.` }
    ]
  },
  {
    id: 'partner_proposal',
    category: 'Relationships',
    mode: 'choice',
    touches: ['partner'],
    weight: (p) => (p.partner && p.partner.value > 60 && p.season >= 3 && !p.flags.engaged ? 8 : 0),
    beat: (p) => ({ text: `You've been turning the idea over for weeks. ${p.partner.name} has no idea tonight is any different from any other. Do you ask?` }),
    suggestions: ['Ask them to marry you', 'Not yet — wait for the right moment'],
    branches: [
      { id: 'propose', matchWords: ['yes', 'ask', 'propose', 'marry', 'do it'], default: true,
        effects: (p) => { p.flags.engaged = true; p.partner.value += 15; p.reputation += 5; p.relationships.media += 8; },
        hint: (v, p) => `${p.partner.name} says yes before you've finished the sentence. The club finds out before your parents do.` },
      { id: 'wait', matchWords: ['no', 'not yet', 'wait'],
        effects: () => {},
        hint: () => `You put the ring back in the drawer. There'll be another night for it.` }
    ]
  },
  {
    id: 'partner_ultimatum',
    category: 'Relationships',
    mode: 'choice',
    touches: ['partner'],
    weight: (p) => (p.partner && p.partner.value < -20) ? 14 : 0,
    beat: (p) => ({ text: `${p.partner.name} sits you down. The football is taking every week, every weekend, every ounce of attention you have left. How do you respond?` }),
    suggestions: ['I recommit and make the time', 'I\'m honest that football comes first right now'],
    branches: [
      { id: 'recommit', matchWords: ['recommit', 'make time', 'sorry', 'yes', 'change'], default: true,
        effects: (p) => { p.partner.value += 25; p.form -= 4; p.relationships.coach -= 3; },
        hint: () => `You mean it, and for a while you follow through. Training takes a small, deliberate back seat.` },
      { id: 'football_first', matchWords: ['football first', 'honest', 'no', 'priority'],
        effects: (p) => {
          const stay = Math.random() < 0.3;
          if (!stay) { p.partner = null; p.form -= 8; p.reputation -= 2; } else { p.partner.value = -5; }
          p.flags.chosePlayingCareer = true;
        },
        hint: (v, p) => p.partner ? `It's a hard conversation, but you're honest, and somehow it holds.` : `The honesty costs you the relationship. It's a quiet few weeks after.` }
    ]
  },
  {
    id: 'retirement_contemplation',
    category: 'Career',
    mode: 'choice',
    touches: ['coach'],
    weight: (p) => p.age >= 32 ? 10 : 0,
    beat: () => ({ text: `Pre-season medicals come back with the usual list of ongoing niggles. Your manager asks, plainly, how many more years you think you've got in you.` }),
    suggestions: ['Sign on for another season', 'Call it — retire at the end of this season'],
    branches: [
      { id: 'play_on', matchWords: ['sign on', 'another season', 'play on', 'yes', 'continue'], default: true,
        effects: (p) => { p.stats.fitness = clamp(p.stats.fitness - 4, 10, 100); p.contractYearsLeft = Math.max(p.contractYearsLeft, 1); },
        hint: () => `You sign on. Your body notices the decision before your form does.` },
      { id: 'retire', matchWords: ['retire', 'call it', 'done', 'finish'],
        effects: (p) => { p.flags.plannedRetirement = true; },
        hint: () => `You tell your manager first, then the coach. Word gets around the club within a day.` }
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

  // Experience dampens variance and raises the ceiling — a debutant with
  // no games and modest stats should mostly post ordinary, forgettable
  // performances, not 9s and 10s.
  const experience = clamp(player.careerStats.matches / 30, 0, 1); // 0 debut -> 1 veteran (30+ games)
  const skill = (player.stats.power + player.stats.steel + player.stats.boot) / 3; // ~10-100
  const skillNorm = clamp((skill - 30) / 55, 0, 1);
  const formNorm = player.form / 100; // -1..1
  const spread = 2.6 - experience * 1.3;
  const luck = (Math.random() + Math.random() - 1) * spread;

  let rating = 4 + skillNorm * 2.6 + formNorm * 1.3 + experience * 0.6 + luck;
  rating = clamp(rating, 1, 10);

  const playerImpact = clamp((rating - 5.5) * 8, -22, 34);

  const ownTeamBase = 12 + Math.random() * 14;
  const oppBase = 8 + opponent.tier * 1.6 + Math.random() * 14;

  let ownScore = Math.round(ownTeamBase + playerImpact * 0.55);
  let oppScore = Math.round(oppBase);
  ownScore = clamp(ownScore, 0, 60);
  oppScore = clamp(oppScore, 0, 60);
  ownScore = Math.round(ownScore / 2) * 2;
  oppScore = Math.round(oppScore / 2) * 2;

  const won = ownScore > oppScore;
  const margin = ownScore - oppScore;

  const moments = [];
  if (rating >= 8.3) moments.push({ minute: Math.floor(10 + Math.random() * 60), type: 'try_assist', tag: 'try involvement, dominant' });
  else if (rating >= 6.5) moments.push({ minute: Math.floor(10 + Math.random() * 60), type: 'good_play', tag: 'strong individual moment' });
  if (rating <= 4) moments.push({ minute: Math.floor(10 + Math.random() * 70), type: 'error', tag: 'costly error under pressure' });
  moments.push({ minute: Math.floor(50 + Math.random() * 30), type: won ? 'clutch' : 'fightback', tag: won ? 'held the lead late' : 'chased the game late' });
  moments.sort((a, b) => a.minute - b.minute);

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
      power: 45 + bg.statBonus.power,
      steel: 45 + bg.statBonus.steel,
      boot: 40 + bg.statBonus.boot,
      fitness: 70 + bg.statBonus.fitness,
      charisma: 40 + bg.statBonus.charisma,
      composure: 45 + bg.statBonus.composure
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
    lastTemplateIds: [],
    totalWeeks: 0,
    lastInteraction: { partner: 0, coach: 0, teammates: 0, media: 0, training: 0 },
    log: [],
    ended: false,
    endingText: null
  };
}

function consumeWeek() {
  player.round += 1;
  player.totalWeeks += 1;
  applyNeglectDecay();
}

function touch(cat) { player.lastInteraction[cat] = player.totalWeeks; }

function applyNeglectDecay() {
  const p = player;
  if (p.totalWeeks - p.lastInteraction.coach > NEGLECT_THRESHOLD) p.relationships.coach = clamp(p.relationships.coach - 2, -100, 100);
  if (p.totalWeeks - p.lastInteraction.teammates > NEGLECT_THRESHOLD) p.relationships.teammates = clamp(p.relationships.teammates - 1, -100, 100);
  if (p.totalWeeks - p.lastInteraction.media > NEGLECT_THRESHOLD) p.relationships.media = clamp(p.relationships.media - 1, -100, 100);
  if (p.partner && p.totalWeeks - p.lastInteraction.partner > NEGLECT_THRESHOLD) {
    p.partner.value = clamp(p.partner.value - 3, -100, 100);
    if (p.partner.value <= -55 && Math.random() < 0.2) {
      const name = p.partner.name;
      addLog(p, { season: p.season, round: p.round, headline: 'Relationship', text: `${name} ends it. Weeks without a real conversation finally caught up with you both.` });
      p.partner = null;
    }
  }
}

function applyEffectsSafe(p, fn, vars) {
  try { fn(p, vars); } catch (e) { console.error('effect error', e); }
  p.form = clamp(p.form, -100, 100);
  p.reputation = clamp(p.reputation, 0, 100);
  ATTRS.forEach(a => { p.stats[a] = clamp(p.stats[a], 10, 100); });
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
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
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
  const system = `You are the narrator for LAST TACKLE, a rugby league career sim played like a tabletop RPG scene. You are given a fixed situation ("beat") already decided by the game engine — you do not invent outcomes or choices. Write 2-4 short sentences, second person ("you"), grounded and understated — think of a good sports novel, not a movie trailer. End by making clear the player needs to decide what to do (the game will ask them to type their own action, so don't list options yourself). No dialogue tags. Output only the narration, no preamble.`;
  const user = `Player: ${JSON.stringify(playerSnapshotForPrompt(p))}\nSituation: ${vars.text}`;
  return callClaude(system, user, 220);
}

async function narrateFreeformOutcome(template, vars, p, actionText, resolved) {
  const system = `You are narrating the outcome of a scene in LAST TACKLE, a rugby league career sim played like a tabletop RPG. The game engine has ALREADY decided exactly what happens — given to you as "outcome" — you only bring it to life in 2-4 sentences, second person, grounded and understated. Weave in what the player said they did, but do not quote it verbatim back at them. Do not change the outcome, invent a different result, or add consequences beyond what's given. No dialogue tags, no preamble, output only the narration.`;
  const rollLine = resolved.mode === 'check'
    ? `This was resolved as a ${ATTR_LABELS[resolved.skill]} check, played ${resolved.boldness}, result: ${resolved.tier === 'critSuccess' ? 'a clean, decisive success' : resolved.tier === 'success' ? 'a modest success' : resolved.tier === 'fail' ? 'a clear failure' : 'a disastrous failure'}.`
    : '';
  const user = `Player: ${JSON.stringify(playerSnapshotForPrompt(p))}
Situation: ${vars.text}
The player's stated action: "${actionText}"
${rollLine}
Outcome (what actually happened, do not contradict this): ${resolved.hint}`;
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
      recap: result.won ? `A solid win. Your performance graded ${result.rating.toFixed(1)}/10 on the day.` : `A tough loss to take. Your performance graded ${result.rating.toFixed(1)}/10 on the day.`
    };
  }
}

// ---------- Static (no-AI) lines, cached to save calls ----------

const RECOVERY_LINES = [
  'Rehab is repetition. Ice, stretch, repeat — the injury clock ticks down slower than the season does.',
  `You spend the week on the sideline in a training bib, watching a game you can't play in yet.`,
  'The physio says the same thing she said last week: progressing, not rushing. You believe her, mostly.',
  `A quiet week. You do the boring work nobody posts about and try not to think about the ladder.`
];

const TAB_LINES = {
  partner: [
    'You call, no reason, just to hear how their day went. It runs long.',
    `You show up with dinner sorted so neither of you has to think about it.`,
    'You actually ask a follow-up question instead of talking about training.',
    `A dumb inside joke over text turns into twenty minutes of nothing important, and it's good.`
  ],
  coach: [
    'You catch him after the video session and ask what he actually wants from you this week.',
    'You stay back to run extra kicks with him watching. He notices the initiative.',
    `A short, honest chat in his office — no agenda, just where you both stand.`,
    'You ask directly what he thinks you need to work on. He appreciates being asked.'
  ],
  teammates: [
    'You buy the coffees before the video session. Small thing, lands well.',
    `You stick around after training to help the young fringe player with his kicking.`,
    `A round of golf with a few of the boys, no football talked about for once.`,
    `You check in on a teammate who's been quiet lately. Turns out he needed the ask.`
  ],
  media: [
    'You do a longer sit-down interview than you needed to, and it comes across well.',
    'You post something honest instead of the usual sponsor-approved nothing.',
    'You take five extra minutes for the local paper reporter who always gets ignored.',
    'A radio hit goes better than expected — you actually sound like yourself.'
  ]
};

const MEET_SUCCESS_LINES = [
  'You strike up a conversation that has no business going as well as it does.',
  `A mutual friend finally makes the introduction they've been threatening for months.`,
  `Something clicks over a conversation that starts about nothing and doesn't stop.`
];
const MEET_FAIL_LINES = [
  `Nothing this week. You put yourself out there and it just doesn't land.`,
  `A near-miss — good conversation, no follow-through. Maybe next time.`,
  'Training and recovery eat the week before anything has a chance to happen.'
];

const TRAINING_LINES = {
  power: ['Extra ball-work after the main session, the kind nobody\'s filming.', 'You drill the same play forty times until it stops feeling deliberate.'],
  steel: ['A brutal extra tackle-technique session with the conditioning coach.', 'You watch your own missed tackles back on loop until the fix is obvious.'],
  boot: ['An hour alone on an empty field, just you and a bag of balls.', 'You work the kicking tee until the angle stops needing thought.'],
  fitness: ['An extra recovery session — ice bath, stretching, the unglamorous stuff.', 'You take the rest day seriously for once instead of half-taking it.'],
  charisma: ['A media-training session on staying sharp in front of a camera.', 'You sit in on a sponsor meeting just to get more comfortable talking business.'],
  composure: ['An hour with the club\'s sports psychologist, working through the pressure moments.', 'You run through visualisation drills the way the older pros swear by.']
};

function spendTime(cat) {
  if (!player || (cat === 'partner' && !player.partner)) return;
  if (player.lastInteraction[cat] === player.totalWeeks) { toast('Already spent time on that this week.'); return; }
  const gain = 4 + Math.floor(Math.random() * 5);
  if (cat === 'partner') player.partner.value = clamp(player.partner.value + gain, -100, 100);
  else player.relationships[cat] = clamp(player.relationships[cat] + gain, -100, 100);
  touch(cat);
  save();
  renderRelationshipTab(cat, pick(TAB_LINES[cat]));
  renderSheet();
}

function meetSomeone() {
  if (!player || player.partner) return;
  if (player.lastInteraction.partner === player.totalWeeks) { toast('Already tried this week.'); return; }
  touch('partner');
  const success = Math.random() < 0.4;
  if (success) player.partner = { name: pick(['Alex', 'Maya', 'Jordan', 'Sam', 'Riley', 'Casey']), value: 15 };
  save();
  renderRelationshipTab('partner', success ? pick(MEET_SUCCESS_LINES) : pick(MEET_FAIL_LINES));
  renderSheet();
}

function trainStat(stat) {
  if (!player) return;
  if (player.lastInteraction.training === player.totalWeeks) { toast('Already trained this week.'); return; }
  touch('training');
  if (stat === 'fitness') {
    player.stats.fitness = clamp(player.stats.fitness + 3 + Math.floor(Math.random() * 4), 10, 100);
  } else if (stat === 'charisma' || stat === 'composure') {
    player.stats[stat] = clamp(player.stats[stat] + 2 + Math.floor(Math.random() * 3), 10, 100);
  } else {
    player.stats[stat] = clamp(player.stats[stat] + 2 + Math.floor(Math.random() * 3), 10, 100);
    const overtrain = player.stats.fitness < 35 && Math.random() < 0.15;
    player.stats.fitness = clamp(player.stats.fitness - (2 + Math.floor(Math.random() * 4)), 10, 100);
    if (overtrain) player.injuryWeeksLeft = Math.max(player.injuryWeeksLeft, 1);
  }
  save();
  renderTrainingTab(pick(TRAINING_LINES[stat]));
  renderSheet();
}

// ---------- State machine ----------

let player = null;
let uiBusy = false;
let currentScreenRenderer = null;
let activeTab = 'overview';

function eligibleTemplates(p) {
  return EVENT_TEMPLATES
    .filter(t => !p.lastTemplateIds.includes(t.id))
    .map(t => ({ t, weight: t.weight(p) }))
    .filter(x => x.weight > 0);
}

async function advanceWeek() {
  if (uiBusy || !player || player.ended) return;

  if (player.injuryWeeksLeft > 0) {
    player.injuryWeeksLeft -= 1;
    consumeWeek();
    renderRecoveryWeek();
    save();
    if (player.round > ROUNDS_PER_SEASON) return handleOffseasonEntry();
    return;
  }

  if (player.round > ROUNDS_PER_SEASON) return handleOffseasonEntry();

  const eligible = eligibleTemplates(player);
  const doEvent = eligible.length > 0 && Math.random() < EVENT_CHANCE;

  if (doEvent) {
    const chosen = weightedPick(eligible).t;
    player.lastTemplateIds.push(chosen.id);
    if (player.lastTemplateIds.length > 3) player.lastTemplateIds.shift();
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

async function submitFreeformAction(template, vars, actionText) {
  if (uiBusy) return;
  const text = actionText.trim();
  if (text.length < 3) { toast('Type a bit more about what you do.'); return; }

  setBusy(true);
  let resolved;
  if (template.mode === 'check') {
    const skill = classifySkill(text, template.primarySkills);
    const boldness = classifyBoldness(text);
    const roll = rollCheck(player.stats[skill], template.baseDC, boldness);
    const tierData = template.outcomeTable[roll.degree];
    applyEffectsSafe(player, tierData.effects, vars);
    resolved = { mode: 'check', skill, boldness, roll, tier: roll.degree, hint: tierData.hint };
  } else {
    const branch = classifyBranch(text, template.branches);
    applyEffectsSafe(player, branch.effects, vars);
    resolved = { mode: 'choice', branch, hint: typeof branch.hint === 'function' ? branch.hint(vars, player) : branch.hint };
  }

  if (resolved.mode === 'check') {
    await renderDiceRollAnimation(resolved.skill, resolved.boldness, resolved.roll);
  }

  renderLoading(template.category);
  let narrative = resolved.hint;
  try {
    narrative = await narrateFreeformOutcome(template, vars, player, text, resolved);
  } catch (e) {
    console.error(e);
    toast('Could not reach the AI for narration — showing a short summary instead.');
  }

  addLog(player, { season: player.season, round: player.round, headline: template.category, text: narrative });
  consumeWeek();
  if (template.touches) template.touches.forEach(touch);
  renderFreeformOutcome(template, text, resolved, narrative);
  save();
  setBusy(false);
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
  player.reputation += (result.rating - 5.5) * 0.6;
  if (result.isRivalRound) player.reputation += result.won ? 3 : -1;
  if (result.injured) player.injuryWeeksLeft = result.injuryWeeks;
  consumeWeek();
  applyEffectsSafe(player, () => {});
  addLog(player, { season: player.season, round: player.round - 1, headline: 'Match', text: narration.recap });
  renderMatchScreen(result, narration);
  save();
}

function handleOffseasonEntry() {
  player.careerStats.seasons += 1;
  player.contractYearsLeft = Math.max(0, player.contractYearsLeft - 1);

  if (player.flags.plannedRetirement || player.age >= 37 || (player.contractYearsLeft <= 0 && player.age >= 34)) {
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
      ${ATTRS.map(a => `<div class="stat-row"><span>${ATTR_LABELS[a]}</span><span class="v">${Math.round(p.stats[a])}</span></div>`).join('')}
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

function renderDiceRollAnimation(skill, boldness, roll) {
  return new Promise(resolve => {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const boldNote = boldness !== 'standard' ? ` · played ${boldness}` : '';
    stage.innerHTML = `
      <div class="week-tag">${ATTR_LABELS[skill]} check${boldNote}</div>
      <div class="dice-roll-stage">
        <div class="d20-wrap" id="d20Wrap">
          <div class="d20-diamond"></div>
          <div class="d20-face" id="d20Face">?</div>
        </div>
        <div class="dice-roll-caption" id="diceCaption">Rolling…</div>
      </div>
    `;
    const face = document.getElementById('d20Face');
    const wrap = document.getElementById('d20Wrap');
    const caption = document.getElementById('diceCaption');

    const land = () => {
      face.textContent = roll.d20;
      if (roll.d20 === 20) { wrap.classList.add('crit-good'); caption.textContent = 'Natural 20!'; }
      else if (roll.d20 === 1) { wrap.classList.add('crit-bad'); caption.textContent = 'Natural 1…'; }
      else { caption.textContent = `${roll.d20} ${roll.mod >= 0 ? '+' : ''}${roll.mod} = ${roll.total} vs DC ${roll.dc}`; }
      setTimeout(resolve, 700);
    };

    if (reduceMotion) { land(); return; }

    let ticks = 0;
    const maxTicks = 14;
    const interval = setInterval(() => {
      ticks++;
      if (ticks >= maxTicks) { clearInterval(interval); land(); }
      else { face.textContent = 1 + Math.floor(Math.random() * 20); }
    }, 70);
  });
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
  const chips = (template.suggestions || []).map((s, i) => `<button class="chip" data-chip="${i}">${escapeHtml(s)}</button>`).join('');
  const hint = template.mode === 'check'
    ? `<p class="freeform-hint">Describe what you do — how you go about it decides which of your attributes gets tested, and how bold you play it changes the risk.</p>`
    : `<p class="freeform-hint">Describe what you do.</p>`;
  stage.innerHTML = `
    <div class="week-tag">${template.category} · Season ${player.season}, Round ${player.round}</div>
    <div class="narrative">${escapeHtml(text).split(/\n+/).map(p => `<p>${p}</p>`).join('')}</div>
    ${hint}
    <div class="chip-row">${chips}</div>
    <textarea class="freeform-box" id="freeformInput" placeholder="What do you do?" rows="2"></textarea>
    <div class="continue-row"><button class="btn btn-primary" id="submitActionBtn">${template.mode === 'check' ? 'Roll for it' : 'Do it'}</button></div>
    ${renderLogHtml()}
  `;
  const inputEl = document.getElementById('freeformInput');
  stage.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => { inputEl.value = template.suggestions[parseInt(btn.dataset.chip, 10)]; inputEl.focus(); });
  });
  document.getElementById('submitActionBtn').addEventListener('click', () => submitFreeformAction(template, vars, inputEl.value));
  renderSheet();
  currentScreenRenderer = () => renderEventScreen(template, vars, text);
  setActiveTab('overview', { skipRender: true });
}

const TIER_LABEL = { critSuccess: 'Critical success', success: 'Success', fail: 'Fail', critFail: 'Critical fail' };
const TIER_CLASS = { critSuccess: 'good', success: 'good', fail: 'warn', critFail: 'warn' };

function renderFreeformOutcome(template, actionText, resolved, narrative) {
  renderTopbar();
  let diceHtml = '';
  if (resolved.mode === 'check') {
    const r = resolved.roll;
    const boldNote = resolved.boldness !== 'standard' ? ` · played ${resolved.boldness}` : '';
    diceHtml = `
      <div class="dice-strip">
        <span class="tag ${TIER_CLASS[resolved.tier]}">${TIER_LABEL[resolved.tier]}</span>
        <span class="dice-detail">${ATTR_LABELS[resolved.skill]} check · d20 (${r.d20}) ${r.mod >= 0 ? '+' : ''}${r.mod} = ${r.total} vs DC ${r.dc}${boldNote}</span>
      </div>
    `;
  }
  stage.innerHTML = `
    <div class="week-tag">${template.category} · Season ${player.season}</div>
    <div class="action-echo">You: ${escapeHtml(actionText)}</div>
    ${diceHtml}
    <div class="narrative"><p>${escapeHtml(narrative)}</p></div>
    <div class="continue-row"><button class="btn btn-primary" id="continueBtn">Continue</button></div>
    ${renderLogHtml()}
  `;
  document.getElementById('continueBtn').addEventListener('click', advanceWeek);
  renderSheet();
  currentScreenRenderer = () => renderFreeformOutcome(template, actionText, resolved, narrative);
  setActiveTab('overview', { skipRender: true });
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
  currentScreenRenderer = renderRecoveryWeek;
  setActiveTab('overview', { skipRender: true });
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
  currentScreenRenderer = () => renderMatchScreen(result, narration);
  setActiveTab('overview', { skipRender: true });
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
  currentScreenRenderer = renderSeasonBreak;
  setActiveTab('overview', { skipRender: true });
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
  currentScreenRenderer = renderEnding;
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

// ---------- Tabs (Girlfriend / Coach / Team / Media / Training) ----------

const TAB_META = {
  partner: { label: 'Girlfriend', actionLabel: 'Spend time together' },
  coach: { label: 'Coach', actionLabel: 'Have a one-on-one' },
  teammates: { label: 'Team', actionLabel: 'Join the boys' },
  media: { label: 'Media', actionLabel: 'Do an interview' }
};

function setActiveTab(tab, opts = {}) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (opts.skipRender) return;
  if (tab === 'overview') { if (currentScreenRenderer) currentScreenRenderer(); return; }
  if (tab === 'training') { renderTrainingTab(); return; }
  renderRelationshipTab(tab);
}

function usedThisWeek(cat) { return player.lastInteraction[cat] === player.totalWeeks; }

function renderRelationshipTab(cat, resultLine) {
  if (uiBusy) return;
  const p = player;
  const meta = TAB_META[cat];
  const weeksSince = p.totalWeeks - p.lastInteraction[cat];
  let bodyHtml;

  if (cat === 'partner' && !p.partner) {
    const disabled = usedThisWeek('partner');
    bodyHtml = `
      <div class="narrative"><p>No one right now. Between training and travel, there hasn't been much room for it.</p></div>
      ${resultLine ? `<div class="narrative"><p>${escapeHtml(resultLine)}</p></div>` : ''}
      <div class="continue-row"><button class="btn btn-primary" id="tabActionBtn" ${disabled ? 'disabled' : ''}>Put yourself out there</button></div>
    `;
    stage.innerHTML = `<div class="week-tag">Girlfriend</div><div class="event-title">Nobody, for now</div>${bodyHtml}`;
    const btn = document.getElementById('tabActionBtn');
    if (btn) btn.addEventListener('click', meetSomeone);
  } else {
    const value = cat === 'partner' ? p.partner.value : p.relationships[cat];
    const name = cat === 'partner' ? p.partner.name : meta.label;
    const disabled = usedThisWeek(cat);
    const neglectNote = weeksSince > NEGLECT_THRESHOLD
      ? `<p style="color:var(--blood)">It's been ${weeksSince} weeks since you last made time for this. It's starting to show.</p>`
      : `<p style="opacity:.6">Last time you made an effort: ${p.lastInteraction[cat] === 0 ? 'not yet' : `${weeksSince} week${weeksSince === 1 ? '' : 's'} ago`}.</p>`;
    bodyHtml = `
      <div class="tag-row" style="margin-bottom:16px"><span class="tag ${value > 10 ? 'good' : value < -10 ? 'warn' : ''}">${relLabel(value)}</span></div>
      ${resultLine ? `<div class="narrative"><p>${escapeHtml(resultLine)}</p></div>` : `<div class="narrative">${neglectNote}</div>`}
      <div class="continue-row"><button class="btn btn-primary" id="tabActionBtn" ${disabled ? 'disabled' : ''}>${escapeHtml(meta.actionLabel)}</button></div>
    `;
    stage.innerHTML = `<div class="week-tag">${escapeHtml(meta.label)}</div><div class="event-title">${escapeHtml(name)}</div>${bodyHtml}`;
    const btn = document.getElementById('tabActionBtn');
    if (btn) btn.addEventListener('click', () => spendTime(cat));
  }
  renderSheet();
}

function renderTrainingTab(resultLine) {
  if (uiBusy) return;
  const p = player;
  const disabled = usedThisWeek('training');
  const rows = ATTRS.map(stat => `
    <div class="stat-row">
      <span>${ATTR_LABELS[stat]} — ${Math.round(p.stats[stat])}</span>
      <button class="btn" data-stat="${stat}" ${disabled ? 'disabled' : ''}>${stat === 'fitness' ? 'Recover' : 'Train'}</button>
    </div>
  `).join('');
  stage.innerHTML = `
    <div class="week-tag">Training</div>
    <div class="event-title">Extra sessions</div>
    <div class="narrative"><p>One extra session a week. Training Power, Steel or Boot costs a little fitness; Charisma and Composure sessions don't. Overtraining on low fitness risks a minor niggle.</p></div>
    ${resultLine ? `<div class="narrative"><p>${escapeHtml(resultLine)}</p></div>` : ''}
    <div class="sheet-block">${rows}</div>
  `;
  stage.querySelectorAll('[data-stat]').forEach(btn => {
    btn.addEventListener('click', () => trainStat(btn.dataset.stat));
  });
  renderSheet();
}

// ---------- Save / load ----------

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(player)); } catch (e) { console.error(e); }
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p.lastTemplateIds) p.lastTemplateIds = [];
    if (typeof p.totalWeeks !== 'number') p.totalWeeks = (p.season - 1) * ROUNDS_PER_SEASON + (p.round - 1);
    if (!p.lastInteraction) p.lastInteraction = { partner: p.totalWeeks, coach: p.totalWeeks, teammates: p.totalWeeks, media: p.totalWeeks, training: p.totalWeeks };
    if (!p.stats.power) {
      // migrate from the old attack/defense/kicking attribute names
      p.stats.power = p.stats.attack || 45;
      p.stats.steel = p.stats.defense || 45;
      p.stats.boot = p.stats.kicking || 40;
      p.stats.charisma = p.stats.charisma || 40;
      p.stats.composure = p.stats.composure || 45;
    }
    return p;
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

function initTabBar() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (uiBusy) { toast('Hang on for that to finish loading.'); return; }
      setActiveTab(btn.dataset.tab);
    });
  });
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
  initTabBar();
});
