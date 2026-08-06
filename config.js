/* ============================================================
   FRIKI FOOTBALL — SITE CONFIG
   This is the only file you normally need to edit.
   ============================================================ */

const CONFIG = {
  // Your CURRENT season's Sleeper league ID.
  // Find it in the Sleeper app URL: sleeper.com/leagues/<THIS_NUMBER>/team
  // Past seasons are discovered automatically, so you only update this once a year.
  leagueId: "1389377629622120448",

  // Shown in the header and browser tab.
  leagueName: "Friki Football",
  tagline: "Year 4 · Six teams · One trophy",

  // Homepage welcome text (basic HTML is allowed).
  homepageText: `
    <p>Welcome back, managers. Every draft pick matters. Every waiver claim counts.
    Every Sunday brings another chance to prove who's the smartest manager in the league.</p>
    <p>May your stars stay healthy, your sleepers break out, and your opponents forget
    to set their lineups. Trash talk is encouraged. Excuses are not.</p>
  `,

  // Optional: league dues, shown as a pill on the home page.
  // Set to a number (e.g. 100) to show it, or null to hide it.
  dues: null,

  /* ------------------------------------------------------------
     CHAMPIONS FROM BEFORE SLEEPER
     Sleeper only has this league from 2025 onward, so earlier
     titles have to be recorded by hand. They show up in History
     and count toward each manager's ring total.

     `manager` must match the name used in the managers list below.
     `team` and `record` are optional.
     ------------------------------------------------------------ */
  pastChampions: [
    { season: "2024", manager: "Erin" },
    { season: "2023", manager: "Morgan" },
  ],

  // Shown under the champions table to explain why the older seasons
  // have no standings or bracket. Set to null to hide it.
  pastChampionsNote:
    "The 2023 and 2024 seasons were played on ESPN Fantasy, which doesn't " +
    "carry over to Sleeper. Those champions are recorded here by hand — the " +
    "full standings and brackets from those years aren't recoverable.",

  /* ------------------------------------------------------------
     MANAGERS
     Keyed by Sleeper user ID. Everything here is optional except
     the name — anything you leave out is simply not displayed.

     To find a user ID, open:
     https://api.sleeper.app/v1/league/1389377629622120448/users
     ------------------------------------------------------------ */
  managers: {
    "1135673631012564992": {
      name: "Morgan",
      location: "Akron",
      fantasyStart: 2023,
      favoriteTeam: "dal",
      valuePosition: "RB",
      tradingScale: 5,
      // photo: "assets/managers/morgan.jpg",
      // bio: "Commissioner. Runs a tight ship.",
    },
    "747670372144492544": {
      name: "Collin",
      location: "Norwalk",
      fantasyStart: 2019,
      favoriteTeam: "cle",
      mode: "Dynasty",
      favoritePlayer: "4034",
      valuePosition: "RB",
      tradingScale: 6,
    },
    "1005318470814261248": {
      name: "Dylan",
    },
    "1130659685620834304": {
      name: "Julia",
    },
    "1135673829394952192": {
      name: "Erin",
    },
    "1260012642026668032": {
      name: "Bob",
    },
  },
};
