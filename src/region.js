// Region restriction detection.
//
// Many Postmates/UberEats promo codes are targeted to a single metro and won't
// apply elsewhere. The user has a configured home market (Settings → Home
// region, default Los Angeles); a code locked to anywhere else is useless to
// them. We read the Reddit comment a code came from, and the Postmates applied-
// promo location, and decide whether it's restricted to a non-home area.
//
// Detection from comments is deliberately conservative: we only flag when the
// text uses explicit restriction language ("vegas only", "only works in
// phoenix", "az-only") next to a non-home city. A bare "worked in Vegas"
// mention is NOT enough — that's just where one person tried it.

const settings = require('./settings');

// Non-home metros/states used to spot "<city> only" restrictions in comments.
const NON_HOME = '(las vegas|vegas|\\blv\\b|nevada|\\bnv\\b|phoenix|scottsdale|tucson|arizona|\\baz\\b|chicago|illinois|seattle|tacoma|dallas|houston|austin|san antonio|texas|\\btx\\b|miami|orlando|tampa|florida|atlanta|georgia|boston|massachusetts|new york|\\bnyc\\b|manhattan|brooklyn|queens|portland|oregon|denver|colorado|sacramento|san francisco|\\bsf\\b|bay area|norcal|oakland|san jose|san diego|detroit|michigan|nashville|memphis|philadelphia|philly|baltimore|charlotte|minneapolis|cleveland|pittsburgh|washington dc|\\bdc\\b)';

// National / statewide phrasings that are usable from anywhere in the US.
const NATIONAL_RE = /\b(nationwide|national|united states|\busa?\b|everywhere|all\s+locations?|anywhere|all\s+markets?|california|\bca\b)\b/i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the home matchers from the current settings each call. Apply runs and
// scans are infrequent, so re-reading settings here keeps changes live without
// a restart. Cached by the alias signature so repeated calls are cheap.
let _homeCache = { key: null, label: '', aliasRe: null };
function getHome() {
  const s = settings.load();
  const aliases = (s.homeAliases && s.homeAliases.length ? s.homeAliases : ['los angeles']);
  const key = aliases.join('|');
  if (_homeCache.key !== key) {
    const aliasRe = new RegExp('\\b(' + aliases.map(escapeRe).join('|') + ')\\b', 'i');
    _homeCache = { key, label: s.homeRegion || 'home', aliasRe };
  } else {
    _homeCache.label = s.homeRegion || _homeCache.label;
  }
  return _homeCache;
}

const UPPER = new Set(['lv', 'nv', 'az', 'sf', 'tx', 'nyc', 'dc']);

function titleCase(s) {
  const lower = String(s).trim().toLowerCase();
  if (UPPER.has(lower)) return lower.toUpperCase();
  return lower.replace(/\b\w/g, c => c.toUpperCase());
}

// Returns { region, restricted, note } or null when there's no region signal.
//   restricted: true  → locked to a region OTHER than home
//   restricted: false → confirmed working in / limited to home (usable)
function detectRegionRestriction(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const { label, aliasRe } = getHome();

  // Restriction phrasings, each capturing the city group ($1).
  const restrictionPatterns = [
    new RegExp(NON_HOME + '\\s*[- ]?\\s*only\\b', 'i'),
    new RegExp('\\bonly\\s+(?:works?|valid|good|available|usable)?\\s*(?:in|for|near)\\s+' + NON_HOME, 'i'),
    new RegExp('\\b(?:exclusive|targeted|limited|restricted)\\s+(?:to\\s+)?' + NON_HOME, 'i'),
    new RegExp(NON_HOME + '\\s+(?:residents|users|accounts|market|area)\\s+only\\b', 'i'),
  ];

  // Confirmed working in the home market → usable regardless of other mentions.
  const homeConfirmed = [
    new RegExp('\\b(?:works?|worked|valid|good|confirmed|used\\s+it)\\b[^.]{0,30}' + aliasRe.source, 'i'),
    new RegExp(aliasRe.source + '[^.]{0,25}\\b(?:works?|worked|valid|confirmed|here)\\b', 'i'),
    new RegExp(aliasRe.source + '\\s*[- ]?\\s*only\\b', 'i'),
  ];
  if (homeConfirmed.some(re => re.test(t))) {
    return { region: label, restricted: false, note: `Reported working in ${label}` };
  }

  for (const pat of restrictionPatterns) {
    const m = t.match(pat);
    if (m && m[1]) {
      // If the matched "non-home" city is actually a home alias, it's fine.
      if (aliasRe.test(m[1])) continue;
      const city = titleCase(m[1].trim());
      return { region: city, restricted: true, note: `${city}-only — not valid in ${label}` };
    }
  }

  return null;
}

// True when an applied promo's location belongs to the user's home market.
function isHomeRegion(loc) {
  if (!loc) return false;
  return getHome().aliasRe.test(String(loc));
}

// Decide whether an applied promo's location is usable for the user.
// No location shown → national/usable. National/statewide → usable. Home →
// usable. A specific other locality (Las Vegas, Phoenix, SF, San Diego…) → not.
function isUsableLocation(loc) {
  if (!loc) return true;
  const s = String(loc).toLowerCase().trim();
  if (NATIONAL_RE.test(s)) return true;
  return getHome().aliasRe.test(s);
}

// Parse the "Location:" field Postmates shows on an applied promo's detail
// sheet (modal text arrives lowercased). Returns the location string or null.
function extractAppliedLocation(text) {
  const m = String(text || '').match(/\blocation\b\s*[:\n]\s*([a-z][a-z .'\-]{1,40})/i);
  if (!m) return null;
  const loc = m[1].split('\n')[0].replace(/\s+/g, ' ').trim();
  return loc.length <= 40 ? loc : null;
}

module.exports = { detectRegionRestriction, isHomeRegion, isUsableLocation, extractAppliedLocation, formatRegion: titleCase };
