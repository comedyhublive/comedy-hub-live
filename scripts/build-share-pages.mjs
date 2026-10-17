/**
 * Builds one small page per show at /s/<id>/ so that a shared link previews
 * with THAT show's flyer, name and time instead of the site-wide logo.
 *
 * A single-page site can only carry one set of Open Graph tags, and a #hash
 * cannot change them - every share looked identical. These pages fix that:
 * crawlers read the per-show tags, humans are bounced straight to the right
 * card on the main page.
 *
 * index.html stays the single source of truth: scheduleData is parsed out of
 * it, so showtimes can never drift between the site and its share cards.
 *
 * Needs Node 18+. No npm install.
 *   node scripts/build-share-pages.mjs
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const SITE = 'https://comedyhublive.com';
const OUT_DIR = 's';
const INDEX = 'index.html';

const DAY_PLURAL = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];
const DAY_SINGULAR = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function die(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

/** Pull the scheduleData array out of index.html and evaluate it. */
function extractShows(html) {
  const startMarker = 'const scheduleData = [';
  const start = html.indexOf(startMarker);
  if (start === -1) die('could not find scheduleData in ' + INDEX);

  // Walk the brackets so a "]" inside a string or comment cannot end it early.
  let i = start + startMarker.length - 1;
  let depth = 0, end = -1;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) die('scheduleData array is not closed');

  const literal = html.slice(start + startMarker.length - 1, end + 1);
  try {
    return new Function('return ' + literal + ';')();
  } catch (err) {
    die('could not parse scheduleData: ' + err.message);
  }
}

function ptLabel(show) {
  const h = show.hour % 12 === 0 ? 12 : show.hour % 12;
  const ampm = show.hour < 12 ? 'AM' : 'PM';
  return `${h}:${String(show.minute).padStart(2, '0')} ${ampm} PT`;
}

/** Mirrors whenPhrase() in index.html. */
function whenPhrase(show) {
  if (show.freq === 'tba') return 'New date coming soon';
  if (show.freq === 'once' && show.date) {
    const [y, m, d] = show.date.split('-').map(Number);
    const when = new Date(Date.UTC(y, m - 1, d, 12));
    const pretty = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
    }).format(when);
    return `${pretty} at ${ptLabel(show)}`;
  }
  if (show.freq === 'monthlyFirst') {
    return `the first ${DAY_SINGULAR[show.dayIndex]} of every month at ${ptLabel(show)}`;
  }
  return `${DAY_PLURAL[show.dayIndex]} at ${ptLabel(show)}`;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function pageFor(show) {
  const title = `${show.title} | Comedy Hub`;
  const where = show.type === 'twitch'
    ? 'Streaming live on Comedy Hub.'
    : 'Live on Comedy Hub - watch on Twitch or join the Zoom audience.';
  const description = `${whenPhrase(show)}. ${where}`;
  const target = `${SITE}/#show-${show.id}`;
  const ogImage = `${SITE}/og/${show.id}.jpg`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/">
<link rel="icon" href="${SITE}/favicon-32.png" sizes="32x32">
<meta name="theme-color" content="#050505">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Comedy Hub">
<meta property="og:url" content="${SITE}/s/${show.id}/">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(show.title)} flyer">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@ComedyHubLive">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ogImage}">

<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#050505; color:#fff; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         text-align:center; padding:24px; }
  .card { max-width:460px; }
  img { width:100%; height:auto; border-radius:10px; border:1px solid rgba(255,255,255,.1); }
  h1 { font-size:1.4rem; margin:20px 0 6px; }
  p  { color:#9ca3af; margin:0 0 20px; line-height:1.5; }
  a.go { display:inline-block; background:#9146FF; color:#fff; text-decoration:none;
         font-weight:700; padding:12px 22px; border-radius:6px; }
  a.go:hover { background:#7c2dff; }
</style>

<script>
  // Crawlers do not run JS, so they stay here and read the tags above.
  // Everyone else goes straight to the show. replace() keeps the back
  // button working - it returns to wherever the link was clicked.
  location.replace(${JSON.stringify(target)});
</script>
</head>
<body>
  <div class="card">
    <img src="${SITE}/og/${show.id}.jpg" alt="${esc(show.title)} flyer">
    <h1>${esc(show.title)}</h1>
    <p>${esc(description)}</p>
    <a class="go" href="${target}">Continue to Comedy Hub</a>
  </div>
</body>
</html>
`;
}

async function main() {
  const html = await readFile(INDEX, 'utf8').catch(() => die(`cannot read ${INDEX}`));
  const shows = extractShows(html).filter((s) => s && s.id);
  if (!shows.length) die('no shows found');

  await rm(OUT_DIR, { recursive: true, force: true });

  for (const show of shows) {
    const dir = `${OUT_DIR}/${show.id}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/index.html`, pageFor(show), 'utf8');
    console.log(`  /s/${show.id}/`.padEnd(26) + show.title);
  }

  console.log(`\nBuilt ${shows.length} share pages in /${OUT_DIR}/.`);
  console.log('Each needs a matching card at /og/<id>.jpg (built by scratch/make_og.py).');
}

main();
