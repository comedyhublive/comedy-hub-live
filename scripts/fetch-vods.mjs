/**
 * Builds vods.json - the most recent Twitch replay for each Comedy Hub show.
 *
 * Runs in GitHub Actions (see .github/workflows/twitch-vods.yml), never in the
 * browser: it needs the Twitch client secret, which must never ship to a page.
 *
 * Needs Node 18+ (uses built-in fetch). No npm install required.
 *
 * Env vars:
 *   TWITCH_CLIENT_ID      from https://dev.twitch.tv/console
 *   TWITCH_CLIENT_SECRET  same place - store as a GitHub Actions secret
 *   TWITCH_CHANNEL        optional, defaults to comedyhub
 */

import { writeFile } from 'node:fs/promises';

const CHANNEL = process.env.TWITCH_CHANNEL || 'comedyhub';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const OUT = process.env.VODS_OUT || 'vods.json';

// Skip false starts. A 19-second "KO Sunday" is not a replay worth linking.
const MIN_DURATION_SECONDS = 5 * 60;

/**
 * The `id` values MUST match the `id` fields in index.html's scheduleData.
 *
 * `match` is a list of lowercase substrings; a VOD belongs to a show if its
 * title contains ANY of them. Order matters within the list only for
 * readability - the newest qualifying VOD always wins.
 *
 * Keep the more specific show first when two could collide: "KO Comedy Friday"
 * contains "ko comedy", so ko-friday is matched on the day word, not on "ko".
 *
 * New Blerd Order is deliberately absent - it titles its VODs by the week's
 * topic ("LANTERNS Episode 3 DEEP DIVE"), so there is nothing stable to match.
 * index.html links that show straight to its YouTube channel instead.
 */
const SHOWS = [
  { id: 'chirping-bird', match: ['chirping bird'] },
  { id: 'kapfer',        match: ['kapfer'] },
  { id: 'fb4tb',         match: ['facebook for the blind', 'fb4tb'] },
  { id: 'jackie-mo',     match: ['jackie mo'] },
  { id: 'living-room',   match: ['living room'] },
  { id: 'ko-friday',     match: ['ko comedy friday', 'ko friday'] },
  { id: 'comedy-coffee', match: ['comedy coffee'] },
  { id: 'ko-sunday',     match: ['ko sunday'] },
];

function die(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

/** "1h28m06s" / "57m58s" / "45s" -> seconds */
function durationToSeconds(d) {
  if (!d) return 0;
  const m = d.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/** "1h28m06s" -> "1:28:06", "57m58s" -> "57:58" */
function prettyDuration(d) {
  const total = durationToSeconds(d);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function getAppToken() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) die(`token request failed (${res.status}). Check the Client ID and Secret.`);
  const json = await res.json();
  if (!json.access_token) die('token response had no access_token');
  return json.access_token;
}

async function helix(path, token) {
  const res = await fetch('https://api.twitch.tv/helix/' + path, {
    headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) die(`helix/${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    die('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set.');
  }

  const token = await getAppToken();

  const users = await helix(`users?login=${encodeURIComponent(CHANNEL)}`, token);
  const user = users.data && users.data[0];
  if (!user) die(`channel "${CHANNEL}" not found`);
  console.log(`Channel ${user.display_name} (id ${user.id})`);

  // 100 is the max per page and covers well beyond the 60-day retention window.
  const videos = await helix(`videos?user_id=${user.id}&type=archive&first=100`, token);
  const all = videos.data || [];
  console.log(`Fetched ${all.length} past broadcasts`);

  const longEnough = all.filter((v) => durationToSeconds(v.duration) >= MIN_DURATION_SECONDS);
  console.log(`${longEnough.length} are at least ${MIN_DURATION_SECONDS / 60} minutes`);

  // Newest first, so the first match per show is the one we want.
  longEnough.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const shows = {};
  const unmatched = [];

  for (const show of SHOWS) {
    const hit = longEnough.find((v) => {
      const title = (v.title || '').toLowerCase();
      return show.match.some((needle) => title.includes(needle));
    });
    if (hit) {
      shows[show.id] = {
        url: hit.url,
        title: hit.title,
        created_at: hit.created_at,
        duration: prettyDuration(hit.duration),
      };
      console.log(`  ${show.id.padEnd(14)} -> ${hit.created_at.slice(0, 10)}  ${hit.title}`);
    } else {
      unmatched.push(show.id);
      console.log(`  ${show.id.padEnd(14)} -> no replay found`);
    }
  }

  if (unmatched.length) {
    console.log(`\nNo replay for: ${unmatched.join(', ')}`);
    console.log('That is normal if the show did not air, or if the VOD title changed.');
    console.log('If a show is persistently missing, check its keywords in SHOWS above.');
  }

  const payload = {
    updated: new Date().toISOString(),
    channel: CHANNEL,
    shows,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${OUT} with ${Object.keys(shows).length} replay link(s).`);
}

main();
