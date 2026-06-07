// Promo code extraction — ported from the original Python regex engine

const FILTER_WORDS = new Set([
  // Common English words
  'POST', 'UBER', 'EDIT', 'UPDATE', 'THAT', 'THIS', 'THEY', 'HAVE', 'BEEN',
  'WILL', 'JUST', 'FROM', 'WITH', 'WHAT', 'YOUR', 'WHEN', 'HERE', 'ABOUT',
  'WOULD', 'THEIR', 'WHICH', 'COULD', 'OTHER', 'THERE', 'THESE', 'THOSE',
  'SOME', 'THAN', 'THEM', 'THEN', 'WERE', 'EACH', 'MAKE', 'LIKE', 'MANY',
  'MOST', 'ONLY', 'OVER', 'SUCH', 'TAKE', 'VERY', 'FREE', 'DOES', 'ALSO',
  'INTO', 'BACK', 'EVEN', 'GOOD', 'MUCH', 'FOOD', 'SAME', 'LAST', 'LONG',
  'CAME', 'WORK', 'MADE', 'FIND', 'KNOW', 'WANT', 'GIVE', 'AREA', 'CODE',
  'BEING', 'BEFORE', 'AFTER', 'FIRST', 'EVERY', 'NEVER', 'ALWAYS', 'BOTH',
  'CANT', 'DONT', 'WONT', 'MORE', 'LESS', 'WELL', 'JUST', 'ONCE', 'SAME',
  'OPEN', 'CLOSE', 'START', 'SHARE', 'SUBMIT', 'CHECK', 'SAVE', 'SEND',
  'TOTAL', 'PRICE', 'ITEMS', 'ADDED', 'REMOVE', 'CHANGE', 'USING', 'WHILE',
  'SINCE', 'UNTIL', 'ABOVE', 'BELOW', 'PLACE', 'THOSE', 'UNDER', 'AGAIN',
  'COME', 'DOES', 'USED', 'MAKE', 'ALSO', 'ONLY', 'EACH', 'MUCH', 'OVER',
  'SUCH', 'AWAY', 'KEEP', 'PART', 'YEAR', 'CITY', 'NEXT', 'OKAY', 'ELSE',
  'THAN', 'THEN', 'THEM', 'WHEN', 'FROM', 'THIS', 'THAT', 'WITH', 'HAVE',
  'INTO', 'BEEN', 'THEY', 'WERE', 'WHAT', 'YOUR', 'WILL', 'ALSO',

  // Delivery / promo context
  'PROMO', 'CODES', 'ORDER', 'DELIVERY', 'POSTMATES', 'UBEREATS', 'REDDIT',
  'THREAD', 'MONTHLY', 'EXISTING', 'USER', 'COMMENT', 'REPLY', 'ANYONE',
  'WORKING', 'EXPIRED', 'APPLIED', 'ALREADY', 'ACCOUNT', 'HTTPS', 'REMOVED',
  'DELETED', 'STILL', 'NEED', 'HELP', 'THANKS', 'THANK', 'PLEASE', 'SORRY',
  'YEAH', 'NOPE', 'NONE', 'SURE', 'MINE', 'SAYS', 'SAID', 'TRIED', 'TRYING',
  'WORKS', 'WORKED', 'APPLY', 'CHECKOUT', 'ENTER', 'CLICK', 'ELIGIBLE',
  'AVAILABLE', 'VALID', 'INVALID', 'EXPIRES',

  // Subreddit rules / moderator language
  'ADDRESSES', 'ANYTHING', 'BANNED', 'CRITICISM', 'DEROGATORY', 'FINAL',
  'INSTEAD', 'LICENSE', 'MAINTAIN', 'MODERATORS', 'NSFW', 'PHONE',
  'POLITICS', 'REFERRAL', 'REMEMBER', 'TOLERANCE', 'WARNING', 'ZERO',
  'DOWNVOTE', 'UPVOTE', 'REPORT', 'BLOCK', 'RULES', 'RULE', 'REGION',
  'REGIONS', 'TARGETED', 'VIOLATION', 'VIOLATIONS', 'TEMPORARY', 'PERMANENT',
  'SUBREDDIT', 'MULTIPLE', 'POSTING', 'POSTS', 'MEMBER', 'MEMBERS',
  'AUTOMOD', 'AUTOMODERATOR', 'MODERATOR', 'MODERATION', 'SIDEBAR',
  'SPECIFIC', 'DUPLICATE', 'ANYWHERE', 'NOWHERE', 'SOMEWHERE', 'EVERYTHING',
  'NOTHING', 'SOMETHING', 'SOMEONE', 'EVERYONE', 'NOBODY', 'ANYBODY',
  'LISTED', 'LISTING', 'ALREADY', 'PLEASE', 'REPEAT', 'FOLLOW', 'POSTED',
  'ALLOWED', 'RESULT', 'RESULTS', 'REFERRALS', 'CONTAIN', 'CONTAINS',
  'INCLUDES', 'INCLUDED', 'RELATED', 'MAGICALLY', 'APPEAR', 'APPEARS',
  'HAPPENS', 'HAPPEN', 'UNLESS', 'ALWAYS', 'NEVER', 'AGAIN', 'ENOUGH',
  'OFFICIAL', 'CAPACITY', 'AFFILIATED', 'CURATED', 'FEATURES', 'DELIVERS',
  'RIGHT', 'WHEN', 'WANT', 'LOVE', 'TRIED', 'ALWAYS', 'SPOTS', 'LOCAL',

  // Time strings
  '11AM', '12PM', '10AM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM',
  '7PM', '8PM', '9PM', '10PM', '11PM', '12AM',

  // Tech / markup
  'NBSP', 'HTTP', 'HREF', 'TRUE', 'FALSE', 'NULL', 'NONE',
  'HTML', 'IMG', 'SRC', 'ONERROR', 'ONLOAD', 'ALERT', 'SCRIPT',
  'EDIT', 'NOTE', 'TLDR', 'TLDW',

  // Competitors / brands (not promo codes)
  'LYFT', 'DOORDASH', 'GRUBHUB', 'INSTACART', 'CAVIAR', 'AMAZON',
  'GOOGLE', 'APPLE', 'PAYPAL', 'VENMO', 'STRIPE',

  // Internet slang
  'LMAO', 'LMFAO', 'OMFG', 'HOLY', 'AFAIK', 'AFAICT', 'IMHO', 'FWIW',
  'YMMV', 'IIRC', 'TLDR', 'NSFW', 'NFSW',

  // US cities and regions that appear in "worked in X" / "tried in X" comments
  'ANGELES', 'FRANCISCO', 'FLAGSTAFF', 'VEGAS', 'HOUSTON', 'DALLAS',
  'DENVER', 'AUSTIN', 'SEATTLE', 'BOSTON', 'MIAMI', 'PORTLAND', 'CHICAGO',
  'ATLANTA', 'PHOENIX', 'TAMPA', 'BROOKLYN', 'MANHATTAN', 'QUEENS',
  'BRONX', 'JERSEY', 'DIEGO', 'ANTONIO', 'FRANCISCO', 'DETROIT',
  'MINNEAPOLIS', 'CLEVELAND', 'PITTSBURGH', 'CINCINNATI', 'MEMPHIS',
  'NASHVILLE', 'LOUISVILLE', 'BALTIMORE', 'CHARLOTTE', 'RALEIGH',
  'SACRAMENTO', 'FRESNO', 'OAKLAND', 'RIVERSIDE', 'ANAHEIM', 'IRVINE',
  'VIRGINIA', 'CAROLINA', 'ILLINOIS', 'ARIZONA', 'FLORIDA', 'TEXAS',
  'CALIFORNIA', 'GEORGIA', 'NEVADA', 'OREGON', 'WASHINGTON', 'COLORADO',
  'MIDWEST', 'NORTHEAST', 'SOUTHEAST', 'SOUTHWEST', 'SOCAL', 'NORCAL',

  // Common Title-case words reachable via Pattern 5 (standalone at line start)
  'TODAY', 'ENJOY', 'HAPPY', 'LUCKY', 'MAYBE', 'GREAT', 'OFFER', 'DEALS',
  'READY', 'SWEET', 'QUICK', 'CLEAN', 'FRESH', 'EXTRA', 'BONUS', 'HELLO',
  'BASICALLY', 'HONESTLY', 'ORDERING',

  // Common words that appear in comments but aren't codes
  'ANOTHER', 'MIGHT', 'SEEMS', 'MATES', 'CLAIMED', 'ASAP', 'PLUS',
  'BECAUSE', 'DOING', 'GOING', 'GETTING', 'LOOKING', 'TRYING', 'SEEING',
  'THINK', 'THOUGHT', 'JUST', 'SAME', 'ALSO', 'EVEN', 'STILL',
  'BACK', 'DOWN', 'TAKE', 'MAKE', 'KEEP', 'SHOW', 'KNOW', 'TELL',
  'FOUND', 'TRIED', 'USED', 'SAID', 'WENT', 'CAME', 'GAVE', 'MADE',
  'DOES', 'DIDN', 'WASN', 'HASN', 'HADN', 'WOULDN', 'SHOULDN', 'COULDN',
  'SAYING', 'ASKING', 'TELLING', 'SHOWING', 'GIVING', 'TAKING', 'MAKING',
  'COMING', 'GOING', 'BEING', 'HAVING', 'DOING', 'SEEING', 'KNOWING',

  // Holiday / event names
  'MOTHERSDAY', 'FATHERSDAY', 'HALLOWEEN', 'THANKSGIVING', 'CHRISTMAS',
  'NEWYEAR', 'VALENTINES', 'MEMORIAL', 'LABOR', 'INDEPENDENCE',
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'JUNE', 'JULY', 'AUGUST',
  'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',

  // Ordinals / numbers written out
  '11TH', '12TH', '13TH', '14TH', '15TH', '16TH', '17TH', '18TH', '19TH',
  '20TH', '21ST', '22ND', '23RD', '24TH', '25TH', '30TH', '31ST',
  'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH',
]);

function extractCodes(commentTexts) {
  const codes = new Set();

  for (const text of commentTexts) {
    if (!text || text.length < 3) continue;
    const cleaned = text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/<[^>]*>/g, ' ');

    // Pattern 1: All-caps words that look like promo codes
    // - Words with at least one digit are almost always codes → accept at 4+ chars
    // - Pure-letter words are often city names / English words → require 8+ chars
    //   OR require them to appear in explicit promo context (code:, try:, etc.)
    const capsMatches = cleaned.matchAll(/\b([A-Z][A-Z0-9]{3,})\b/g);
    const hasPromoContext = /\b(code|promo|use|try|apply|coupon|discount)\b[:\s]+/i.test(cleaned);
    for (const m of capsMatches) {
      const w = m[1];
      if (FILTER_WORDS.has(w)) continue;
      const hasDigit = /\d/.test(w);
      if (hasDigit) {
        codes.add(w); // digit present → very likely a code
      } else if (w.length >= 8 || hasPromoContext) {
        codes.add(w); // long enough to be intentional, or explicit promo context
      }
    }

    // Pattern 2: Mixed case with numbers (e.g., OneDay10, 1XPER, Waves25)
    const mixedAlphaNum = cleaned.matchAll(/\b([A-Za-z]+\d+[A-Za-z0-9]*)\b/g);
    for (const m of mixedAlphaNum) {
      if (m[1].length >= 4 && !FILTER_WORDS.has(m[1].toUpperCase())) {
        codes.add(m[1].toUpperCase());
      }
    }
    const mixedNumAlpha = cleaned.matchAll(/\b(\d+[A-Za-z]+[A-Za-z0-9]*)\b/g);
    for (const m of mixedNumAlpha) {
      if (m[1].length >= 4 && !FILTER_WORDS.has(m[1].toUpperCase())) {
        codes.add(m[1].toUpperCase());
      }
    }

    // Pattern 3: Word near "code:", "try:", "use:", "promo:" followed by $ or "off"
    const promoCtx = cleaned.matchAll(/(?:^|\n|code[:\s]+|try[:\s]+|use[:\s]+|promo[:\s]+)([A-Za-z]{4,})(?:\s+\$|\s+\d+%?\s*off)/gi);
    for (const m of promoCtx) {
      if (!FILTER_WORDS.has(m[1].toUpperCase())) codes.add(m[1].toUpperCase());
    }

    // Pattern 4: "WORD $X off" — word immediately before a dollar amount + off
    const dollarOff = cleaned.matchAll(/\b([A-Za-z]{4,})\s+\$\d+\s+off\b/gi);
    for (const m of dollarOff) {
      if (!FILTER_WORDS.has(m[1].toUpperCase())) codes.add(m[1].toUpperCase());
    }

    // Pattern 5: Standalone capitalized word on its own line in a promo-context comment
    if (/\$|off|promo|code|discount|coupon|deal/i.test(cleaned)) {
      const standalone = cleaned.matchAll(/(?:^|\n)\s*([A-Z][a-z]{3,})\s/g);
      for (const m of standalone) {
        if (!FILTER_WORDS.has(m[1].toUpperCase())) codes.add(m[1].toUpperCase());
      }
    }
  }

  return codes;
}

module.exports = { extractCodes };
