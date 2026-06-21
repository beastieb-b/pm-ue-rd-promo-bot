// Region restriction detection.
//
// Many Postmates/UberEats promo codes posted on Reddit are targeted to a single
// metro and won't apply anywhere else. The user is in Los Angeles, so a code
// flagged "Vegas only" is useless to them. We read the comment text a code was
// found in and decide whether it's restricted to a region OTHER than LA.
//
// Detection is deliberately conservative: we only flag a code as restricted when
// the comment uses explicit restriction language ("vegas only", "only works in
// phoenix", "az-only") next to a non-home city. A bare "worked in Vegas" mention
// is NOT enough — that's just where one person tried it, not a restriction.

// The user's home market. A code limited to any of these still works for them.
const HOME = '(?:los angeles|\\bl\\.?a\\.?\\b|socal|so\\s?cal|southern california)';

// Non-home metros/states. If a code is restricted to one of these, it's no good
// in LA. (California as a whole, or SoCal, includes LA, so those are NOT here —
// but specific other-California metros like SF/San Diego/Sacramento are.)
const NON_HOME = '(las vegas|vegas|\\blv\\b|nevada|\\bnv\\b|phoenix|scottsdale|tucson|arizona|\\baz\\b|chicago|illinois|seattle|tacoma|dallas|houston|austin|san antonio|texas|\\btx\\b|miami|orlando|tampa|florida|atlanta|georgia|boston|massachusetts|new york|\\bnyc\\b|manhattan|brooklyn|queens|portland|oregon|denver|colorado|sacramento|san francisco|\\bsf\\b|bay area|norcal|oakland|san jose|san diego|detroit|michigan|nashville|memphis|philadelphia|philly|baltimore|charlotte|minneapolis|cleveland|pittsburgh|washington dc|\\bdc\\b)';

// Restriction phrasings, each capturing the city group ($1).
const RESTRICTION_PATTERNS = [
  new RegExp(NON_HOME + '\\s*[- ]?\\s*only\\b', 'i'),                                   // "vegas only", "az-only"
  new RegExp('\\bonly\\s+(?:works?|valid|good|available|usable)?\\s*(?:in|for|near)\\s+' + NON_HOME, 'i'), // "only works in phoenix"
  new RegExp('\\b(?:exclusive|targeted|limited|restricted)\\s+(?:to\\s+)?' + NON_HOME, 'i'), // "exclusive to seattle"
  new RegExp(NON_HOME + '\\s+(?:residents|users|accounts|market|area)\\s+only\\b', 'i'),  // "nyc users only"
];

// Phrasings that confirm a code works in the home market → never flag as restricted.
const HOME_CONFIRMED = [
  new RegExp('\\b(?:works?|worked|valid|good|confirmed|used\\s+it)\\b[^.]{0,30}' + HOME, 'i'),
  new RegExp(HOME + '[^.]{0,25}\\b(?:works?|worked|valid|confirmed|here)\\b', 'i'),
  new RegExp(HOME + '\\s*[- ]?\\s*only\\b', 'i'), // "LA only" — still fine for the user
];

// Abbreviations that should display fully uppercased rather than title-cased.
const UPPER = new Set(['lv', 'nv', 'az', 'sf', 'tx', 'nyc', 'dc']);

function titleCase(s) {
  const lower = String(s).trim().toLowerCase();
  if (UPPER.has(lower)) return lower.toUpperCase();
  return lower.replace(/\b\w/g, c => c.toUpperCase());
}

// Returns { region, restricted, note } or null when there's no region signal.
//   restricted: true  → code is locked to a region OTHER than Los Angeles
//   restricted: false → code is confirmed working in / limited to LA (usable)
function detectRegionRestriction(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();

  // If it's confirmed to work in LA, it's usable regardless of other mentions.
  if (HOME_CONFIRMED.some(re => re.test(t))) {
    return { region: 'Los Angeles', restricted: false, note: 'Reported working in Los Angeles' };
  }

  for (const pat of RESTRICTION_PATTERNS) {
    const m = t.match(pat);
    if (m && m[1]) {
      const city = titleCase(m[1].trim());
      return { region: city, restricted: true, note: `${city}-only — not valid in Los Angeles` };
    }
  }

  return null;
}

const HOME_RE = new RegExp(HOME, 'i');

// True when an applied promo's location belongs to the user's home market.
function isHomeRegion(loc) {
  return HOME_RE.test(String(loc || ''));
}

// Locations that are fine for an LA user: home market, California statewide, or
// national/nationwide promos. Anything else (a specific other metro/state) is
// not usable here.
const USABLE_LOC_RE = /\b(los angeles|socal|so\s?cal|southern california|california|\bca\b|nationwide|national|united states|\busa?\b|everywhere|all\s+locations?|anywhere|all\s+markets?)\b/i;
// California metros that are NOT LA — statewide language doesn't make these usable.
const NON_HOME_CA_RE = /\b(northern california|norcal|bay area|san francisco|san diego|sacramento|\boakland\b|san jose|fresno)\b/i;

// Decide whether an applied promo's location is usable for the LA user.
// No location shown → treat as national/usable. A specific non-SoCal locality
// (Las Vegas, Phoenix, SF, San Diego, …) → not usable.
function isUsableLocation(loc) {
  if (!loc) return true;
  const s = String(loc).toLowerCase().trim();
  if (NON_HOME_CA_RE.test(s)) return false;
  return USABLE_LOC_RE.test(s);
}

// Parse the "Location:" field Postmates shows on an applied promo's detail
// sheet (modal text arrives lowercased). Returns the location string or null.
// e.g. a sheet reading "Enjoy $10 Off … Location\nLas Vegas …" → "Las Vegas".
function extractAppliedLocation(text) {
  const m = String(text || '').match(/\blocation\b\s*[:\n]\s*([a-z][a-z .'\-]{1,40})/i);
  if (!m) return null;
  const loc = m[1].split('\n')[0].replace(/\s+/g, ' ').trim();
  // Guard against catching a sentence ("location of the restaurant…").
  return loc.length <= 40 ? loc : null;
}

module.exports = { detectRegionRestriction, isHomeRegion, isUsableLocation, extractAppliedLocation, formatRegion: titleCase };
