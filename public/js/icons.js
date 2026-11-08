// Activity icons: suggest an emoji from the event title, and the picker's choices.
// An event's stored icon wins; '-' means "no icon"; nothing stored means "use the suggestion".

const RULES = [
  [/\b(soccer|football practice|futbol|fútbol)\b/, '⚽'], [/\bbasketball|hoops\b/, '🏀'], [/\bbaseball|softball|little league\b/, '⚾'],
  [/\b(football|nfl|super bowl)\b/, '🏈'], [/\btennis|pickleball\b/, '🎾'], [/\bvolleyball\b/, '🏐'], [/\bhockey|skating|skate\b/, '🏒'],
  [/\bswim|swimming|pool\b/, '🏊'], [/\bgolf\b/, '⛳'], [/\bski|skiing|snowboard/, '⛷️'], [/\bgym|workout|crossfit|weights|training\b/, '🏋️'],
  [/\byoga|pilates\b/, '🧘'], [/\brun|running|jog|5k|10k|marathon|race\b/, '🏃'], [/\bbike|cycling|bicycle|spin class\b/, '🚴'],
  [/\bhike|hiking|trail\b/, '🥾'], [/\bdance|ballet|recital\b/, '💃'], [/\bkarate|taekwondo|judo|martial\b/, '🥋'], [/\bgymnastics\b/, '🤸'],
  [/\bpiano\b/, '🎹'], [/\bguitar\b/, '🎸'], [/\bviolin|cello|orchestra\b/, '🎻'], [/\bdrum/, '🥁'], [/\bchoir|sing|singing|voice lesson\b/, '🎤'],
  [/\bmusic|band|concert\b/, '🎵'], [/\bart class|painting|drawing|craft/, '🎨'], [/\btheat(er|re)|play rehearsal|musical\b/, '🎭'],
  [/\bmovie|cinema|film\b/, '🎬'], [/\bbirthday|bday|b-day\b/, '🎂'], [/\bparty|celebration\b/, '🎉'], [/\bwedding\b/, '💒'],
  [/\banniversary\b/, '💍'], [/\bbaby shower\b/, '🍼'], [/\bdate night\b/, '❤️'], [/\bchristmas|xmas\b/, '🎄'], [/\bthanksgiving\b/, '🦃'],
  [/\bhalloween|trick or treat\b/, '🎃'], [/\beaster\b/, '🐣'], [/\bhanukkah|chanukah\b/, '🕎'], [/\bnew year/, '🎆'],
  [/\bvalentine/, '💝'], [/\bfourth of july|4th of july|independence day\b/, '🎆'],
  [/\bdoctor|dr\.|checkup|check-up|physical|pediatric|clinic|appointment with dr\b/, '🩺'], [/\bdentist|dental|orthodont|braces\b/, '🦷'],
  [/\beye (exam|doctor)|optometr|glasses\b/, '👓'], [/\bhospital|surgery|er visit\b/, '🏥'], [/\bvaccine|shot|flu shot|vaccination\b/, '💉'],
  [/\btherap|counsel/, '🛋️'], [/\bpharmacy|prescription|meds\b/, '💊'], [/\bvet|veterinar/, '🐾'], [/\bdog|walk the dog|puppy\b/, '🐕'],
  [/\bcat\b/, '🐈'], [/\bhaircut|barber|salon|hair\b/, '💇'], [/\bnails|manicure|pedicure\b/, '💅'], [/\bspa|massage\b/, '💆'],
  [/\bschool|class|teacher|pta|parent-teacher|conference\b/, '🏫'], [/\bhomework|study|tutor|exam|test|quiz\b/, '📚'],
  [/\bgraduation\b/, '🎓'], [/\blibrary|book club|reading\b/, '📖'], [/\bdaycare|preschool|nursery\b/, '🧸'], [/\bcamp\b/, '🏕️'],
  [/\bbus\b/, '🚌'], [/\bpick ?up|drop ?off|carpool|school run\b/, '🚗'],
  [/\bwork|office|meeting|standup|call with|zoom|interview\b/, '💼'], [/\bdeadline|due\b/, '⏰'], [/\bconference|summit\b/, '🗣️'],
  [/\bflight|airport|fly to|plane\b/, '✈️'], [/\btrain\b/, '🚆'], [/\bvacation|holiday|trip|travel|getaway\b/, '🧳'], [/\bbeach\b/, '🏖️'],
  [/\bhotel|check-in|check in\b/, '🏨'], [/\bcar (service|repair)|oil change|mechanic|tires\b/, '🔧'], [/\bgas\b/, '⛽'],
  [/\bdinner|restaurant|brunch\b/, '🍽️'], [/\blunch\b/, '🥪'], [/\bbreakfast\b/, '🥞'], [/\bcoffee|café|cafe\b/, '☕'], [/\bpizza\b/, '🍕'],
  [/\bcook|baking|bake\b/, '👩‍🍳'], [/\bbbq|barbecue|cookout|picnic\b/, '🍖'], [/\bdrinks|happy hour|wine\b/, '🍷'],
  [/\bgrocer|supermarket|costco|trader joe|whole foods|shopping\b/, '🛒'], [/\bmall|clothes\b/, '🛍️'],
  [/\bclean|cleaning|chores|laundry|vacuum\b/, '🧹'], [/\btrash|garbage|recycling\b/, '🗑️'], [/\bgarden|yard|lawn|mow\b/, '🌱'],
  [/\bplumber|electrician|repair|contractor|handyman|maintenance\b/, '🛠️'], [/\bmove|moving\b/, '📦'], [/\bdelivery|package\b/, '📦'],
  [/\bbank|taxes|tax|bills?|pay rent|rent due|insurance\b/, '💰'], [/\bvote|voting|election\b/, '🗳️'],
  [/\bchurch|mass|service\b/, '⛪'], [/\bsynagogue|shabbat\b/, '🕍'], [/\bmosque|jummah\b/, '🕌'],
  [/\bvolunteer|charity|fundraiser\b/, '🤝'], [/\bplaydate|play date\b/, '🧸'], [/\bsleepover\b/, '🛌'], [/\bnap|bedtime\b/, '😴'],
  [/\bgame night|board game\b/, '🎲'], [/\bvideo game|gaming\b/, '🎮'], [/\bzoo\b/, '🦁'], [/\bmuseum\b/, '🏛️'], [/\bpark|playground\b/, '🛝'],
  [/\bfishing\b/, '🎣'], [/\bcamping\b/, '⛺'], [/\bvisit|grandma|grandpa|abuela|abuelo|family\b/, '👨‍👩‍👧'], [/\bcall\b/, '📞'],
];

export function suggestIcon(title) {
  const t = String(title || '').toLowerCase();
  if (!t.trim()) return null;
  for (const [re, ic] of RULES) if (re.test(t)) return ic;
  return null;
}

// Icon to display for an event (stored choice, or a suggestion from the title).
export function eventIcon(ev) {
  if (!ev) return null;
  if (ev.icon === '-') return null;
  return ev.icon || suggestIcon(ev.title);
}

export const ICON_CHOICES = [
  '⚽', '🏀', '⚾', '🏈', '🎾', '🏊', '🏋️', '🧘', '🏃', '🚴', '🥾', '💃', '🥋', '🎹', '🎸', '🎵', '🎨', '🎭', '🎬',
  '🎂', '🎉', '❤️', '🎄', '🦃', '🎃', '🩺', '🦷', '💊', '🐾', '💇', '🏫', '📚', '🎓', '🧸', '🚗', '🚌', '💼', '⏰',
  '✈️', '🧳', '🏖️', '🍽️', '☕', '🛒', '🧹', '🗑️', '🌱', '🛠️', '📦', '💰', '⛪', '🤝', '🎲', '🏕️', '👨‍👩‍👧', '📞', '⭐',
];

// Emoji avatars offered for family profiles.
export const AVATAR_CHOICES = ['👩', '👨', '👧', '👦', '👶', '👵', '👴', '🧑', '👩‍🦱', '👨‍🦱', '👱‍♀️', '👱', '🐶', '🐱', '🦊', '🐻', '🐼', '🦁', '🐸', '🦄', '🦖', '🐙', '🌟', '🌈'];
