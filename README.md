# Friki Football — league page

A tiki-themed league site for our Sleeper fantasy football league.

It is **plain HTML, CSS and JavaScript**. There is no build step, no Node,
no Vercel, and no server. The page talks to Sleeper's public API directly
from the visitor's browser, so anyone can open the link and it just works —
on a phone, a laptop, whatever.

## The link

https://cliedorff22-cpu.github.io/frikki-football/

Share that with the league. Nothing to install, nothing to log into.

On a phone you can add it to the home screen (Share → Add to Home Screen)
and it opens like an app.

## What's on it

| Tab | What it shows |
| --- | --- |
| Home | Welcome text, season status, last season's recap, recent moves |
| Standings | Record, points for/against, point differential |
| Matchups | Week-by-week scoreboard plus that week's scoring leaderboard |
| Rosters | Starters and bench for every team, any season |
| Draft | Pick-by-pick board; fills in live on draft day |
| Moves | Every trade, waiver claim and free-agent pickup |
| History | Champions, final standings and playoff brackets for past seasons |
| Records | All-time highs, lows, blowouts, nail-biters, manager totals |
| Head to Head | All-time record of every manager against every other |
| Managers | Profiles, all-time records, favorite teams and players |

## Updating it

**Almost nothing needs updating.** Standings, scores, rosters, draft picks
and transactions all come from Sleeper live.

The one thing to change is **once a year**, when Sleeper creates a new
league for the new season. Open `config.js` and update:

```js
leagueId: "1389377629622120448",
```

Get the new ID from the Sleeper app URL: `sleeper.com/leagues/<THIS_NUMBER>/team`.

Past seasons are found automatically by following Sleeper's
`previous_league_id` chain, so the History and Records tabs keep growing
on their own. You never have to re-enter old data.

Everything else in `config.js` is optional flavor: league name, tagline,
homepage text, dues, and manager profiles (location, bio, photo, favorite
team, etc.). Leave a field out and it simply isn't displayed.

### Champions from before Sleeper

Sleeper only has this league from 2025 onward, so the 2023 and 2024 titles
are recorded by hand in `config.js`:

```js
pastChampions: [
  { season: "2024", manager: "Erin" },
  { season: "2023", manager: "Morgan" },
],
```

`manager` has to match the name in the managers list. `team` and `record`
are optional extras. These appear in the History tab's champions table and
count toward each manager's ring total. Everything from 2025 on is read
from Sleeper's playoff bracket automatically — don't add those here.

Those two seasons were played on ESPN Fantasy, so no standings, scores or
brackets exist for them anywhere Sleeper can reach. Only the champions
carried over. The explanation shown under the table lives in
`pastChampionsNote` in the same file; set it to `null` to hide it.

To add a manager photo, drop the image in `assets/managers/` and point
to it:

```js
photo: "assets/managers/collin.jpg",
```

## Files

```
index.html          page shell and navigation
config.js           league ID + manager profiles — the only file you edit
assets/style.css    the tiki theme
assets/app.js       all the logic: API calls, routing, rendering
data/players.json   trimmed player names (id -> [name, position, team])
```

The `assets/` and `data/` folders matter — `index.html` loads
`assets/style.css` and `assets/app.js` by those exact paths. If everything
gets flattened into the root (easy to do by uploading files individually
through GitHub's web UI), the page renders with no styling and no
JavaScript. Upload folders, not loose files.

`data/players.json` exists because Sleeper's full player endpoint is ~15 MB
— too heavy for a phone on every visit. The trimmed copy is ~230 KB. It is
refreshed automatically every Tuesday by
`.github/workflows/refresh-players.yml`, and you can also trigger that by
hand from the repo's Actions tab. If the file is ever missing, the page
falls back to fetching from Sleeper directly, so it degrades rather than
breaks.

## Running it locally

Any static file server works. From the repo root:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173.

(Opening `index.html` straight off the disk mostly works too, but browsers
block the local `players.json` fetch over `file://`, so player names fall
back to the slower Sleeper endpoint.)
