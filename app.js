/* ===========================================================
   Friki Football — application logic
   Pure browser JS. No build step, no server, no API key.
   Sleeper's API is public and CORS-open, so the page talks to
   it directly from the visitor's browser.
   =========================================================== */

(function () {
  "use strict";

  var API = "https://api.sleeper.app/v1";
  var CDN = "https://sleepercdn.com";
  var CACHE_MS = 5 * 60 * 1000; // in-tab cache lifetime for API responses

  /* ---------------- State ---------------- */

  var S = {
    players: {},      // playerId -> [name, pos, team]
    state: null,      // NFL season state
    seasons: [],      // newest first: {leagueId, season, league, rosters, users}
    current: null,    // the season object matching CONFIG.leagueId
    view: null,       // active view id
  };

  /* ---------------- Small helpers ---------------- */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Sleeper stores points split across two integer fields.
  function pts(settings, base) {
    var whole = settings[base] || 0;
    var dec = settings[base + "_decimal"] || 0;
    return whole + dec / 100;
  }

  function fmt(n, d) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toFixed(d == null ? 2 : d);
  }

  function avatarUrl(hash) {
    return hash ? CDN + "/avatars/thumbs/" + hash : "";
  }

  function playerImg(pid) {
    // Team defenses use a team logo; everyone else has a headshot.
    if (/^[A-Z]{2,3}$/.test(pid)) return CDN + "/images/team_logos/nfl/" + pid.toLowerCase() + ".png";
    return CDN + "/content/nfl/players/thumb/" + pid + ".jpg";
  }

  function playerName(pid) {
    var p = S.players[pid];
    if (p) return p[0];
    if (/^[A-Z]{2,3}$/.test(pid)) return pid + " Defense";
    return "Player " + pid;
  }

  function playerMeta(pid) {
    var p = S.players[pid];
    if (!p) return "";
    return p[1] + " · " + (p[2] || "FA");
  }

  function timeAgo(ms) {
    var s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    return new Date(ms).toLocaleDateString();
  }

  /* ---------------- Fetch with cache ---------------- */

  var memCache = {};

  function api(path) {
    var now = Date.now();
    var hit = memCache[path];
    if (hit && now - hit.t < CACHE_MS) return Promise.resolve(hit.v);

    return fetch(API + path)
      .then(function (r) {
        if (!r.ok) throw new Error("Sleeper returned " + r.status + " for " + path);
        return r.json();
      })
      .then(function (v) {
        memCache[path] = { t: now, v: v };
        return v;
      });
  }

  /* ---------------- Player database ---------------- */

  function loadPlayers() {
    // Prefer the small pre-built file (≈230 KB). The full Sleeper endpoint is
    // ~15 MB, so it is only used as a fallback if the local file is missing.
    return fetch("data/players.json")
      .then(function (r) {
        if (!r.ok) throw new Error("no local player file");
        return r.json();
      })
      .then(function (j) { S.players = j; })
      .catch(function () {
        return api("/players/nfl")
          .then(function (all) {
            var out = {};
            for (var k in all) {
              var p = all[k];
              if (!p.position) continue;
              out[k] = [p.full_name || ((p.first_name || "") + " " + (p.last_name || "")).trim(), p.position, p.team || "FA"];
            }
            S.players = out;
          })
          .catch(function () { S.players = {}; });
      });
  }

  /* ---------------- Season discovery ---------------- */

  // Walks previous_league_id backwards so past seasons appear automatically.
  function loadSeasonChain() {
    var chain = [];

    function step(id) {
      if (!id || chain.length > 25) return Promise.resolve();
      return Promise.all([
        api("/league/" + id),
        api("/league/" + id + "/rosters"),
        api("/league/" + id + "/users"),
      ]).then(function (res) {
        var league = res[0];
        if (!league) return;
        chain.push({
          leagueId: id,
          season: league.season,
          league: league,
          rosters: res[1] || [],
          users: res[2] || [],
        });
        return step(league.previous_league_id);
      });
    }

    return step(CONFIG.leagueId).then(function () {
      S.seasons = chain;
      S.current = chain[0] || null;
    });
  }

  /* ---------------- Season-scoped lookups ---------------- */

  function userMap(season) {
    var m = {};
    (season.users || []).forEach(function (u) { m[u.user_id] = u; });
    return m;
  }

  // roster_id -> a single display object for that team
  function teamMap(season) {
    var users = userMap(season);
    var m = {};
    (season.rosters || []).forEach(function (r) {
      var u = users[r.owner_id] || {};
      var cfg = (CONFIG.managers || {})[r.owner_id] || {};
      var meta = u.metadata || {};
      m[r.roster_id] = {
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        manager: cfg.name || u.display_name || "Unknown",
        teamName: meta.team_name || (u.display_name ? u.display_name + "'s Team" : "Team " + r.roster_id),
        avatar: meta.avatar || avatarUrl(u.avatar),
        roster: r,
      };
    });
    return m;
  }

  function teamHtml(t, sub) {
    if (!t) return '<span class="team-name">TBD</span>';
    var img = t.avatar
      ? '<img class="avatar" src="' + esc(t.avatar) + '" alt="" loading="lazy">'
      : '<div class="avatar"></div>';
    return (
      '<div class="team">' + img +
      '<div style="min-width:0"><div class="team-name">' + esc(t.teamName) + "</div>" +
      '<div class="team-owner">' + esc(sub || t.manager) + "</div></div></div>"
    );
  }

  /* ---------------- Standings ---------------- */

  function standingsOf(season) {
    var teams = teamMap(season);
    var rows = (season.rosters || []).map(function (r) {
      var s = r.settings || {};
      return {
        team: teams[r.roster_id],
        wins: s.wins || 0,
        losses: s.losses || 0,
        ties: s.ties || 0,
        pf: pts(s, "fpts"),
        pa: pts(s, "fpts_against"),
        max: pts(s, "ppts"),
        streak: s.streak || "",
      };
    });
    rows.sort(function (a, b) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.ties !== a.ties) return b.ties - a.ties;
      return b.pf - a.pf;
    });
    return rows;
  }

  /* ---------------- Views ---------------- */

  var VIEWS = {};

  /* ===== HOME ===== */

  VIEWS.home = function (root) {
    var cur = S.current;
    var lg = cur.league;
    var st = S.state || {};
    var rows = standingsOf(cur);
    var isPreseason = lg.status === "pre_draft" || lg.status === "drafting";
    var week = st.season === lg.season ? (st.display_week || st.week || 0) : 0;

    var h = "";

    h += '<div class="hero">';
    h += "<h2>" + esc(CONFIG.leagueName) + "</h2>";
    h += "<p>" + esc(CONFIG.tagline || "") + "</p>";
    h += CONFIG.homepageText || "";
    h += '<div class="pill-row">';
    h += '<span class="pill">' + esc(lg.season) + " Season</span>";
    h += '<span class="pill neutral">' + lg.total_rosters + " teams</span>";
    h += '<span class="pill neutral">' + esc(statusLabel(lg.status)) + "</span>";
    if (CONFIG.dues) h += '<span class="pill neutral">$' + CONFIG.dues + " buy-in</span>";
    h += "</div></div>";

    // Season-state banner
    if (isPreseason) {
      h += '<div class="card"><h2>Season status</h2>';
      h += "<p style='margin:0;color:var(--txt-dim)'>The " + esc(lg.season) +
        " season hasn't kicked off yet, so standings and matchups are empty. " +
        "Rosters, the draft board and live scores all fill in automatically once the draft happens — " +
        "nothing here needs to be updated by hand.</p>";
      h += '<div class="note">In the meantime, the History and Records tabs are fully populated from past seasons.</div>';
      h += "</div>";
    }

    // Current standings snapshot
    if (rows.some(function (r) { return r.wins + r.losses + r.ties > 0; })) {
      h += '<div class="card"><h2>Standings</h2>' + standingsTable(rows, cur) + "</div>";
    }

    // Last completed season recap
    var past = S.seasons.filter(function (s) { return s.league.status === "complete"; });
    if (past.length) {
      var lastSeason = past[0];
      h += '<div class="card"><h2>' + esc(lastSeason.season) + " recap</h2>";
      h += '<div id="home-recap"><div class="loading"><div class="spinner"></div>Loading…</div></div></div>';
      setTimeout(function () { renderRecap(lastSeason, el("home-recap")); }, 0);
    }

    h += '<div class="card"><h2>Recent moves</h2><div id="home-txn">' +
      '<div class="loading"><div class="spinner"></div>Loading…</div></div></div>';

    root.innerHTML = h;
    renderRecentTransactions(el("home-txn"), week);
  };

  function statusLabel(s) {
    return {
      pre_draft: "Pre-draft",
      drafting: "Drafting",
      in_season: "In season",
      complete: "Complete",
      post_season: "Playoffs",
    }[s] || s;
  }

  function renderRecap(season, node) {
    if (!node) return;
    api("/league/" + season.leagueId + "/winners_bracket")
      .then(function (br) {
        var teams = teamMap(season);
        var champ = championFrom(br, teams);
        var rows = standingsOf(season);
        var top = rows[0];
        var mostPf = rows.slice().sort(function (a, b) { return b.pf - a.pf; })[0];

        var h = '<div class="stats">';
        h += tile("Champion", champ ? champ.teamName : "—", champ ? champ.manager : "");
        h += tile("Best record", top.wins + "-" + top.losses, top.team.manager);
        h += tile("Most points", fmt(mostPf.pf, 1), mostPf.team.manager);
        h += tile("Season", season.season, season.league.total_rosters + " teams");
        h += "</div>";
        node.innerHTML = h;
      })
      .catch(function (e) { node.innerHTML = errBox(e); });
  }

  function tile(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      "</div>" + (s ? '<div class="s">' + esc(s) + "</div>" : "") + "</div>";
  }

  function championFrom(bracket, teams) {
    if (!bracket || !bracket.length) return null;
    // The championship game is the match carrying p === 1 (Sleeper's placement
    // marker); fall back to the final round's first match.
    var title = bracket.filter(function (m) { return m.p === 1; })[0];
    if (!title) {
      var maxR = Math.max.apply(null, bracket.map(function (m) { return m.r; }));
      title = bracket.filter(function (m) { return m.r === maxR; })[0];
    }
    return title && title.w ? teams[title.w] : null;
  }

  /* ===== STANDINGS ===== */

  function standingsTable(rows, season) {
    var playoffTeams = (season.league.settings || {}).playoff_teams || 0;
    var h = '<div class="table-wrap"><table><thead><tr>';
    h += "<th></th><th>Team</th><th class='num'>W-L</th><th class='num'>PF</th><th class='num'>PA</th><th class='num'>Diff</th>";
    h += "</tr></thead><tbody>";
    rows.forEach(function (r, i) {
      var cls = i === 0 ? "rank top" : i < playoffTeams ? "rank playoff" : "rank";
      var rec = r.wins + "-" + r.losses + (r.ties ? "-" + r.ties : "");
      var diff = r.pf - r.pa;
      h += "<tr>";
      h += '<td><span class="' + cls + '">' + (i + 1) + "</span></td>";
      h += '<td class="name">' + teamHtml(r.team) + "</td>";
      h += '<td class="num">' + rec + "</td>";
      h += '<td class="num">' + fmt(r.pf, 1) + "</td>";
      h += '<td class="num">' + fmt(r.pa, 1) + "</td>";
      h += '<td class="num" style="color:' + (diff >= 0 ? "var(--accent)" : "var(--red)") + '">' +
        (diff >= 0 ? "+" : "") + fmt(diff, 1) + "</td>";
      h += "</tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  VIEWS.standings = function (root) {
    var seasonId = getParam("season") || S.current.leagueId;
    var season = S.seasons.filter(function (s) { return s.leagueId === seasonId; })[0] || S.current;
    var rows = standingsOf(season);
    var played = rows.some(function (r) { return r.wins + r.losses + r.ties > 0; });

    var h = '<h2 class="page-title">Standings</h2>';
    h += '<p class="page-sub">Sorted by record, then points for. Ties broken by total points.</p>';
    h += seasonChips(seasonId);

    if (!played) {
      h += '<div class="card"><div class="empty">No games played yet in ' + esc(season.season) +
        ".<br>Standings appear here once Week 1 kicks off.</div></div>";
    } else {
      h += '<div class="card">' + standingsTable(rows, season) + "</div>";
      var pf = rows.slice().sort(function (a, b) { return b.pf - a.pf; });
      h += '<div class="card"><h2>At a glance</h2><div class="stats">';
      h += tile("Most points for", fmt(pf[0].pf, 1), pf[0].team.manager);
      h += tile("Fewest points for", fmt(pf[pf.length - 1].pf, 1), pf[pf.length - 1].team.manager);
      var pa = rows.slice().sort(function (a, b) { return b.pa - a.pa; });
      h += tile("Most points against", fmt(pa[0].pa, 1), pa[0].team.manager);
      h += tile("Luckiest", fmt(pa[pa.length - 1].pa, 1) + " PA", pa[pa.length - 1].team.manager);
      h += "</div></div>";
    }

    root.innerHTML = h;
    wireSeasonChips("standings");
  };

  /* ===== MATCHUPS ===== */

  VIEWS.matchups = function (root) {
    var seasonId = getParam("season") || S.current.leagueId;
    var season = S.seasons.filter(function (s) { return s.leagueId === seasonId; })[0] || S.current;
    var st = S.state || {};
    var lastWeek = totalWeeks(season);
    var defWeek = st.season === season.season ? Math.max(1, Math.min(st.display_week || st.week || 1, lastWeek)) : 1;
    var week = parseInt(getParam("week") || defWeek, 10);

    var h = '<h2 class="page-title">Matchups</h2>';
    h += '<p class="page-sub">Scores update live on game day, straight from Sleeper.</p>';
    h += seasonChips(seasonId);

    h += '<div class="controls"><select id="week-sel">';
    for (var w = 1; w <= lastWeek; w++) {
      h += '<option value="' + w + '"' + (w === week ? " selected" : "") + ">Week " + w + "</option>";
    }
    h += "</select></div>";
    h += '<div id="mu"><div class="loading"><div class="spinner"></div>Loading week ' + week + "…</div></div>";

    root.innerHTML = h;
    wireSeasonChips("matchups");

    el("week-sel").addEventListener("change", function () {
      go("matchups", { season: seasonId, week: this.value });
    });

    renderMatchups(season, week, el("mu"));
  };

  function totalWeeks(season) {
    var s = season.league.settings || {};
    var start = s.playoff_week_start || 15;
    return Math.max(start + 3, 17);
  }

  function renderMatchups(season, week, node) {
    api("/league/" + season.leagueId + "/matchups/" + week)
      .then(function (list) {
        if (!list || !list.length) {
          node.innerHTML = '<div class="card"><div class="empty">No matchup data for Week ' + week + " yet.</div></div>";
          return;
        }
        var teams = teamMap(season);
        var groups = {};
        list.forEach(function (m) {
          var key = m.matchup_id == null ? "bye-" + m.roster_id : m.matchup_id;
          (groups[key] = groups[key] || []).push(m);
        });

        var h = '<div class="card">';
        Object.keys(groups).forEach(function (k) {
          var g = groups[k];
          var a = g[0], b = g[1];
          h += '<div class="matchup">';
          if (!b) {
            h += mrow(teams[a.roster_id], a.points, false) +
              '<div class="vs">BYE</div>';
          } else {
            var aw = (a.points || 0) >= (b.points || 0);
            h += mrow(teams[a.roster_id], a.points, aw);
            h += '<div class="vs">VS</div>';
            h += mrow(teams[b.roster_id], b.points, !aw);
          }
          h += "</div>";
        });
        h += "</div>";

        // Weekly leaderboard
        var sorted = list.slice().sort(function (x, y) { return (y.points || 0) - (x.points || 0); });
        h += '<div class="card"><h2>Week ' + week + " scoring</h2>";
        h += '<div class="table-wrap"><table><thead><tr><th></th><th>Team</th><th class="num">Points</th></tr></thead><tbody>';
        sorted.forEach(function (m, i) {
          h += "<tr><td><span class='rank" + (i === 0 ? " top" : "") + "'>" + (i + 1) + "</span></td>";
          h += '<td class="name">' + teamHtml(teams[m.roster_id]) + "</td>";
          h += '<td class="num">' + fmt(m.points, 2) + "</td></tr>";
        });
        h += "</tbody></table></div></div>";

        node.innerHTML = h;
      })
      .catch(function (e) { node.innerHTML = errBox(e); });
  }

  function mrow(t, p, win) {
    return '<div class="mrow ' + (win ? "winner" : "loser") + '">' +
      teamHtml(t) + '<div class="score">' + fmt(p, 2) + "</div></div>";
  }

  /* ===== ROSTERS ===== */

  VIEWS.rosters = function (root) {
    var seasonId = getParam("season") || S.current.leagueId;
    var season = S.seasons.filter(function (s) { return s.leagueId === seasonId; })[0] || S.current;
    var teams = teamMap(season);
    var ids = Object.keys(teams);
    var sel = getParam("team");
    if (!teams[sel]) sel = ids[0];   // team ids differ between seasons

    var h = '<h2 class="page-title">Rosters</h2>';
    h += '<p class="page-sub">Rosters for the ' + esc(season.season) + " season.</p>";
    h += seasonChips(seasonId);

    h += '<div class="chips">';
    ids.forEach(function (id) {
      h += '<button class="chip' + (id === String(sel) ? " active" : "") + '" data-team="' + id + '">' +
        esc(teams[id].manager) + "</button>";
    });
    h += "</div>";
    h += '<div id="roster-body" style="margin-top:16px"></div>';

    root.innerHTML = h;
    wireSeasonChips("rosters");

    Array.prototype.forEach.call(root.querySelectorAll("[data-team]"), function (b) {
      b.addEventListener("click", function () {
        go("rosters", { season: seasonId, team: this.dataset.team });
      });
    });

    renderRoster(season, teams[sel], el("roster-body"));
  };

  function renderRoster(season, team, node) {
    if (!team) { node.innerHTML = '<div class="card"><div class="empty">Team not found.</div></div>'; return; }
    var r = team.roster;
    var players = r.players || [];
    var starters = r.starters || [];

    if (!players.length) {
      node.innerHTML = '<div class="card"><div class="empty"><strong>' + esc(team.teamName) +
        "</strong> has no players yet.<br>Rosters populate automatically after the draft.</div></div>";
      return;
    }

    var slots = season.league.roster_positions || [];
    var starterSlots = slots.filter(function (p) { return p !== "BN" && p !== "IR" && p !== "TAXI"; });
    var bench = players.filter(function (p) { return starters.indexOf(p) === -1; });

    var h = '<div class="card">';
    h += '<div class="mgr-top">' +
      (team.avatar ? '<img class="avatar lg" src="' + esc(team.avatar) + '" alt="">' : '<div class="avatar lg"></div>') +
      "<div><h3>" + esc(team.teamName) + '</h3><div class="sub">' + esc(team.manager) + " · " +
      (r.settings.wins || 0) + "-" + (r.settings.losses || 0) + "</div></div></div>";

    h += '<div class="section-title">Starters</div>';
    starters.forEach(function (pid, i) {
      h += slotRow(starterSlots[i] || "FLEX", pid);
    });

    if (bench.length) {
      h += '<div class="bench-label">Bench (' + bench.length + ")</div>";
      bench.forEach(function (pid) {
        var p = S.players[pid];
        h += slotRow(p ? p[1] : "BN", pid);
      });
    }
    h += "</div>";
    node.innerHTML = h;
  }

  function slotRow(pos, pid) {
    if (!pid || pid === "0") {
      return '<div class="slot"><div class="pos ' + esc(pos) + '">' + esc(pos) +
        '</div><div class="headshot"></div><div><div class="pname" style="color:var(--txt-faint)">Empty</div></div></div>';
    }
    return '<div class="slot">' +
      '<div class="pos ' + esc(pos) + '">' + esc(pos) + "</div>" +
      '<img class="headshot" src="' + esc(playerImg(pid)) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' +
      '<div style="min-width:0"><div class="pname">' + esc(playerName(pid)) + "</div>" +
      '<div class="pmeta">' + esc(playerMeta(pid)) + "</div></div></div>";
  }

  /* ===== DRAFT ===== */

  VIEWS.draft = function (root) {
    var seasonId = getParam("season") || S.current.leagueId;
    var season = S.seasons.filter(function (s) { return s.leagueId === seasonId; })[0] || S.current;

    var h = '<h2 class="page-title">Draft</h2>';
    h += '<p class="page-sub">Pick-by-pick board, straight from Sleeper.</p>';
    h += seasonChips(seasonId);
    h += '<div id="draft-body"><div class="loading"><div class="spinner"></div>Loading draft…</div></div>';
    root.innerHTML = h;
    wireSeasonChips("draft");

    renderDraft(season, el("draft-body"));
  };

  function renderDraft(season, node) {
    api("/league/" + season.leagueId + "/drafts")
      .then(function (drafts) {
        if (!drafts || !drafts.length) {
          node.innerHTML = '<div class="card"><div class="empty">No draft found for this season.</div></div>';
          return;
        }
        var d = drafts[0];
        if (d.status !== "complete" && d.status !== "paused" && d.status !== "in_progress") {
          var when = d.start_time ? new Date(d.start_time).toLocaleString() : "not scheduled yet";
          node.innerHTML = '<div class="card"><div class="empty"><strong>The ' + esc(season.season) +
            " draft hasn't started.</strong><br>Type: " + esc(d.type) + " · Scheduled: " + esc(when) +
            "<br><br>This board fills in automatically, pick by pick, once you're on the clock.</div></div>";
          return;
        }
        return api("/draft/" + d.draft_id + "/picks").then(function (picks) {
          if (!picks || !picks.length) {
            node.innerHTML = '<div class="card"><div class="empty">No picks recorded yet.</div></div>';
            return;
          }
          var teams = teamMap(season);
          var byRound = {};
          picks.forEach(function (p) { (byRound[p.round] = byRound[p.round] || []).push(p); });

          var posColor = { QB: "var(--red)", RB: "var(--accent)", WR: "var(--blue)", TE: "var(--gold)", K: "var(--txt-faint)", DEF: "#c89ef0" };
          var h = "";
          Object.keys(byRound).sort(function (a, b) { return a - b; }).forEach(function (rd) {
            h += '<div class="card"><h2>Round ' + rd + "</h2>";
            h += '<div class="draft-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">';
            byRound[rd].sort(function (a, b) { return a.pick_no - b.pick_no; }).forEach(function (p) {
              var meta = p.metadata || {};
              var nm = (meta.first_name || "") + " " + (meta.last_name || "");
              if (!nm.trim()) nm = playerName(p.player_id);
              var t = teams[p.roster_id];
              h += '<div class="dpick" style="border-left-color:' + (posColor[meta.position] || "var(--line)") + '">';
              h += '<div class="dno">' + p.round + "." + String(p.draft_slot).padStart(2, "0") +
                " · #" + p.pick_no + "</div>";
              h += '<div class="dname">' + esc(nm.trim()) + "</div>";
              h += '<div class="dteam">' + esc(meta.position || "") + " " + esc(meta.team || "") + "</div>";
              h += '<div class="dteam" style="margin-top:3px;color:var(--txt-dim)">' +
                esc(t ? t.manager : "—") + "</div>";
              h += "</div>";
            });
            h += "</div></div>";
          });
          node.innerHTML = h;
        });
      })
      .catch(function (e) { node.innerHTML = errBox(e); });
  }

  /* ===== HISTORY ===== */

  VIEWS.history = function (root) {
    var h = '<h2 class="page-title">History</h2>';
    h += '<p class="page-sub">Every champion in league history, plus full standings and brackets for the seasons Sleeper has on record.</p>';
    h += '<div id="hist"><div class="loading"><div class="spinner"></div>Loading seasons…</div></div>';
    root.innerHTML = h;

    var done = S.seasons.filter(function (s) {
      return s.league.status === "complete" || s.league.status === "post_season";
    });

    Promise.all([
      getChampions(),
      Promise.all(done.map(function (s) {
        return api("/league/" + s.leagueId + "/winners_bracket")
          .then(function (b) { return { season: s, bracket: b || [] }; })
          .catch(function () { return { season: s, bracket: [] }; });
      })),
    ]).then(function (res) {
      var champs = res[0];
      var all = res[1];
      var counts = titleCounts(champs);
      var h = "";

      if (!champs.length && !all.length) {
        el("hist").innerHTML = '<div class="card"><div class="empty">No completed seasons yet.</div></div>';
        return;
      }

      // Roll of honour — Sleeper seasons and pre-Sleeper seasons together
      h += '<div class="card"><h2>🏆 Champions</h2><div class="table-wrap"><table>';
      h += "<thead><tr><th>Season</th><th>Champion</th><th>Manager</th><th class='num'>Record</th></tr></thead><tbody>";
      champs.forEach(function (c) {
        h += "<tr><td><strong>" + esc(c.season) + "</strong></td>";
        if (c.team) {
          h += '<td class="name"><div class="team">' +
            (c.avatar ? '<img class="avatar" src="' + esc(c.avatar) + '" alt="" loading="lazy">' : '<div class="avatar"></div>') +
            '<div style="min-width:0"><div class="team-name">' + esc(c.team) + "</div>" +
            '<div class="team-owner">' + esc(c.manager) + "</div></div></div></td>";
        } else {
          h += '<td class="name"><div class="team">' +
            (c.avatar ? '<img class="avatar" src="' + esc(c.avatar) + '" alt="" loading="lazy">' : '<div class="avatar"></div>') +
            '<div class="team-name">' + esc(c.manager) + "</div></div></td>";
        }
        h += "<td>" + esc(c.manager) + "</td>";
        h += '<td class="num">' + esc(c.record || "—") + "</td></tr>";
      });
      h += "</tbody></table></div>";

      // Ring count
      var ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
      h += '<div class="section-title" style="margin-top:18px">Rings</div><div class="pill-row">';
      ranked.forEach(function (name) {
        h += '<span class="pill">' + esc(name) + " · " +
          new Array(counts[name] + 1).join("🏆") + "</span>";
      });
      h += "</div>";

      if (champs.some(function (c) { return !c.tracked; }) && CONFIG.pastChampionsNote) {
        h += '<div class="note">' + esc(CONFIG.pastChampionsNote) + "</div>";
      }
      h += "</div>";

      // Per-season detail (Sleeper seasons only)
      all.forEach(function (x) {
        var teams = teamMap(x.season);
        h += '<div class="card"><h2>' + esc(x.season.season) + " season</h2>";
        h += standingsTable(standingsOf(x.season), x.season);
        if (x.bracket.length) {
          h += '<div class="section-title" style="margin-top:18px">Playoff bracket</div>';
          h += bracketHtml(x.bracket, teams);
        }
        h += "</div>";
      });

      el("hist").innerHTML = h;
    }).catch(function (e) { el("hist").innerHTML = errBox(e); });
  };

  function bracketHtml(bracket, teams) {
    var rounds = {};
    bracket.forEach(function (m) { (rounds[m.r] = rounds[m.r] || []).push(m); });
    var keys = Object.keys(rounds).sort(function (a, b) { return a - b; });

    function label(rd, i) {
      var left = keys.length - i;
      if (left === 1) return "Championship";
      if (left === 2) return "Semifinals";
      if (left === 3) return "Quarterfinals";
      return "Round " + rd;
    }

    // Sleeper marks placement games with `p` (1 = title, 3 = third place, …).
    function placement(p) {
      if (!p) return "";
      if (p === 1) return "🏆 Championship";
      var suffix = p === 3 ? "rd" : p === 5 ? "th" : p === 7 ? "th" : "th";
      return p + suffix + " place";
    }

    var h = '<div class="bracket">';
    keys.forEach(function (rd, i) {
      h += '<div class="bracket-round"><h4>' + esc(label(rd, i)) + "</h4>";
      rounds[rd].forEach(function (m) {
        h += '<div class="bmatch">';
        if (m.p) h += '<div class="bcap">' + esc(placement(m.p)) + "</div>";
        [m.t1, m.t2].forEach(function (tid) {
          var t = teams[tid];
          var win = m.w && tid === m.w;
          h += '<div class="bteam' + (win ? " win" : "") + '">';
          h += "<span>" + esc(t ? t.manager : "TBD") + "</span>";
          h += '<span class="bscore">' + (win ? "W" : m.w ? "L" : "") + "</span>";
          h += "</div>";
        });
        h += "</div>";
      });
      h += "</div>";
    });
    h += "</div>";
    return h;
  }

  /* ===== RECORDS ===== */

  VIEWS.records = function (root) {
    var h = '<h2 class="page-title">Record book</h2>';
    h += '<p class="page-sub">All-time marks across every season on Sleeper. Regular season and playoffs.</p>';
    h += '<div id="rec"><div class="loading"><div class="spinner"></div>Crunching every week of every season…</div></div>';
    root.innerHTML = h;

    gatherAllMatchups().then(function (games) {
      if (!games.length) {
        el("rec").innerHTML = '<div class="card"><div class="empty">No completed games yet.</div></div>';
        return;
      }

      // Single-team weekly scores
      var scores = [];
      games.forEach(function (g) {
        scores.push({ t: g.a, p: g.ap, wk: g.week, sn: g.season, opp: g.b });
        if (g.b) scores.push({ t: g.b, p: g.bp, wk: g.week, sn: g.season, opp: g.a });
      });
      scores.sort(function (x, y) { return y.p - x.p; });

      var head2head = games.filter(function (g) { return g.b; });
      var blow = head2head.slice().sort(function (x, y) {
        return Math.abs(y.ap - y.bp) - Math.abs(x.ap - x.bp);
      });
      var close = head2head.slice().sort(function (x, y) {
        return Math.abs(x.ap - x.bp) - Math.abs(y.ap - y.bp);
      });
      var shootout = head2head.slice().sort(function (x, y) {
        return (y.ap + y.bp) - (x.ap + x.bp);
      });

      var h = "";
      h += '<div class="card"><h2>Headlines</h2><div class="stats">';
      h += tile("Highest week", fmt(scores[0].p, 2), scores[0].t.manager + " · " + scores[0].sn + " Wk " + scores[0].wk);
      var low = scores[scores.length - 1];
      h += tile("Lowest week", fmt(low.p, 2), low.t.manager + " · " + low.sn + " Wk " + low.wk);
      var bg = blow[0];
      h += tile("Biggest blowout", fmt(Math.abs(bg.ap - bg.bp), 2), bg.season + " Wk " + bg.week);
      var cg = close[0];
      h += tile("Closest game", fmt(Math.abs(cg.ap - cg.bp), 2), cg.season + " Wk " + cg.week);
      h += "</div></div>";

      h += '<div class="card"><h2>Top 10 single-week scores</h2>' + scoreTable(scores.slice(0, 10)) + "</div>";
      h += '<div class="card"><h2>Bottom 10 single-week scores</h2>' +
        scoreTable(scores.slice(-10).reverse()) + "</div>";

      h += '<div class="card"><h2>Biggest blowouts</h2>' + gameTable(blow.slice(0, 8), "margin") + "</div>";
      h += '<div class="card"><h2>Nail-biters</h2>' + gameTable(close.slice(0, 8), "margin") + "</div>";
      h += '<div class="card"><h2>Highest-scoring matchups</h2>' + gameTable(shootout.slice(0, 8), "total") + "</div>";

      // All-time manager totals
      h += '<div class="card"><h2>All-time by manager</h2>' + allTimeTable(games) + "</div>";

      el("rec").innerHTML = h;
    }).catch(function (e) {
      el("rec").innerHTML = errBox(e);
    });
  };

  function scoreTable(list) {
    var h = '<div class="table-wrap"><table><thead><tr><th></th><th>Team</th><th class="num">Points</th><th>When</th></tr></thead><tbody>';
    list.forEach(function (s, i) {
      h += "<tr><td><span class='rank" + (i === 0 ? " top" : "") + "'>" + (i + 1) + "</span></td>";
      h += '<td class="name">' + teamHtml(s.t) + "</td>";
      h += '<td class="num">' + fmt(s.p, 2) + "</td>";
      h += "<td>" + esc(s.sn) + " Wk " + s.wk + "</td></tr>";
    });
    return h + "</tbody></table></div>";
  }

  function gameTable(list, mode) {
    var h = '<div class="table-wrap"><table><thead><tr><th>When</th><th>Matchup</th><th class="num">Score</th><th class="num">' +
      (mode === "total" ? "Total" : "Margin") + "</th></tr></thead><tbody>";
    list.forEach(function (g) {
      var hi = g.ap >= g.bp ? g : { a: g.b, ap: g.bp, b: g.a, bp: g.ap };
      var val = mode === "total" ? g.ap + g.bp : Math.abs(g.ap - g.bp);
      h += "<tr><td>" + esc(g.season) + " Wk " + g.week + "</td>";
      h += '<td class="name">' + esc(hi.a.manager) + " def. " + esc(hi.b.manager) + "</td>";
      h += '<td class="num">' + fmt(hi.ap, 2) + "–" + fmt(hi.bp, 2) + "</td>";
      h += '<td class="num"><strong>' + fmt(val, 2) + "</strong></td></tr>";
    });
    return h + "</tbody></table></div>";
  }

  function allTimeTable(games) {
    var agg = {};
    games.forEach(function (g) {
      if (!g.b) return;
      [[g.a, g.ap, g.bp], [g.b, g.bp, g.ap]].forEach(function (x) {
        var key = x[0].ownerId || x[0].manager;
        var r = agg[key] || (agg[key] = { t: x[0], w: 0, l: 0, tie: 0, pf: 0, pa: 0, g: 0 });
        r.g++; r.pf += x[1]; r.pa += x[2];
        if (x[1] > x[2]) r.w++; else if (x[1] < x[2]) r.l++; else r.tie++;
        r.t = x[0];
      });
    });
    var rows = Object.keys(agg).map(function (k) { return agg[k]; });
    rows.sort(function (a, b) {
      var aw = a.w / (a.g || 1), bw = b.w / (b.g || 1);
      if (bw !== aw) return bw - aw;
      return b.pf - a.pf;
    });

    var h = '<div class="table-wrap"><table><thead><tr><th></th><th>Manager</th><th class="num">W-L</th><th class="num">Win%</th><th class="num">PPG</th><th class="num">Total PF</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      h += "<tr><td><span class='rank" + (i === 0 ? " top" : "") + "'>" + (i + 1) + "</span></td>";
      h += '<td class="name">' + teamHtml(r.t, r.t.manager) + "</td>";
      h += '<td class="num">' + r.w + "-" + r.l + (r.tie ? "-" + r.tie : "") + "</td>";
      h += '<td class="num">' + (100 * r.w / (r.g || 1)).toFixed(1) + "%</td>";
      h += '<td class="num">' + fmt(r.pf / (r.g || 1), 1) + "</td>";
      h += '<td class="num">' + fmt(r.pf, 1) + "</td></tr>";
    });
    return h + "</tbody></table></div>";
  }

  /* ===== HEAD TO HEAD ===== */

  VIEWS.h2h = function (root) {
    var h = '<h2 class="page-title">Head to head</h2>';
    h += '<p class="page-sub">All-time record of the row manager against the column manager.</p>';
    h += '<div id="h2h"><div class="loading"><div class="spinner"></div>Building the grid…</div></div>';
    root.innerHTML = h;

    gatherAllMatchups().then(function (games) {
      var rec = {}, names = {};
      games.forEach(function (g) {
        if (!g.b) return;
        var A = g.a.ownerId || g.a.manager, B = g.b.ownerId || g.b.manager;
        names[A] = g.a.manager; names[B] = g.b.manager;
        rec[A] = rec[A] || {}; rec[B] = rec[B] || {};
        rec[A][B] = rec[A][B] || { w: 0, l: 0, t: 0 };
        rec[B][A] = rec[B][A] || { w: 0, l: 0, t: 0 };
        if (g.ap > g.bp) { rec[A][B].w++; rec[B][A].l++; }
        else if (g.ap < g.bp) { rec[A][B].l++; rec[B][A].w++; }
        else { rec[A][B].t++; rec[B][A].t++; }
      });

      var ids = Object.keys(names).sort(function (a, b) { return names[a].localeCompare(names[b]); });
      if (!ids.length) {
        el("h2h").innerHTML = '<div class="card"><div class="empty">No games played yet.</div></div>';
        return;
      }

      var h = '<div class="card"><div class="table-wrap"><table class="h2h"><thead><tr><th></th>';
      ids.forEach(function (id) { h += "<th>" + esc(names[id].slice(0, 6)) + "</th>"; });
      h += "</tr></thead><tbody>";
      ids.forEach(function (a) {
        h += "<tr><td>" + esc(names[a]) + "</td>";
        ids.forEach(function (b) {
          if (a === b) { h += '<td class="self">—</td>'; return; }
          var r = (rec[a] || {})[b];
          if (!r) { h += "<td>—</td>"; return; }
          var cls = r.w > r.l ? "good" : r.w < r.l ? "bad" : "";
          h += '<td class="' + cls + '">' + r.w + "-" + r.l + (r.t ? "-" + r.t : "") + "</td>";
        });
        h += "</tr>";
      });
      h += "</tbody></table></div>";
      h += '<div class="note">Read across: the manager on the left, versus the manager on top.</div></div>';
      el("h2h").innerHTML = h;
    }).catch(function (e) { el("h2h").innerHTML = errBox(e); });
  };

  /* ===== TRANSACTIONS ===== */

  VIEWS.moves = function (root) {
    var seasonId = getParam("season") || S.current.leagueId;
    var season = S.seasons.filter(function (s) { return s.leagueId === seasonId; })[0] || S.current;

    var h = '<h2 class="page-title">Transactions</h2>';
    h += '<p class="page-sub">Trades, waiver claims and free-agent pickups.</p>';
    h += seasonChips(seasonId);
    h += '<div id="tx"><div class="loading"><div class="spinner"></div>Loading moves…</div></div>';
    root.innerHTML = h;
    wireSeasonChips("moves");

    var weeks = [];
    for (var w = 1; w <= totalWeeks(season); w++) weeks.push(w);

    Promise.all(weeks.map(function (w) {
      return api("/league/" + season.leagueId + "/transactions/" + w).catch(function () { return []; });
    })).then(function (all) {
      var txns = [];
      all.forEach(function (list) {
        (list || []).forEach(function (t) { if (t.status === "complete") txns.push(t); });
      });
      txns.sort(function (a, b) { return b.status_updated - a.status_updated; });
      el("tx").innerHTML = txns.length
        ? '<div class="card">' + txns.map(txnHtml.bind(null, teamMap(season))).join("") + "</div>"
        : '<div class="card"><div class="empty">No completed transactions this season yet.</div></div>';
    }).catch(function (e) { el("tx").innerHTML = errBox(e); });
  };

  function renderRecentTransactions(node, week) {
    if (!node) return;
    var season = S.current;
    var weeks = [];
    for (var w = Math.max(1, week - 2); w <= Math.max(1, week); w++) weeks.push(w);
    if (!weeks.length) weeks = [1];

    Promise.all(weeks.map(function (w) {
      return api("/league/" + season.leagueId + "/transactions/" + w).catch(function () { return []; });
    })).then(function (all) {
      var txns = [];
      all.forEach(function (l) { (l || []).forEach(function (t) { if (t.status === "complete") txns.push(t); }); });
      txns.sort(function (a, b) { return b.status_updated - a.status_updated; });
      txns = txns.slice(0, 8);
      node.innerHTML = txns.length
        ? txns.map(txnHtml.bind(null, teamMap(season))).join("") +
          '<div class="note"><a href="#/moves">See all transactions →</a></div>'
        : '<div class="empty">No moves yet this season.</div>';
    }).catch(function () { node.innerHTML = '<div class="empty">Couldn\'t load transactions.</div>'; });
  }

  function txnHtml(teams, t) {
    var who = (t.roster_ids || []).map(function (id) {
      return teams[id] ? teams[id].manager : "Team " + id;
    }).join(" ↔ ");

    var h = '<div class="txn"><div class="txn-head">';
    h += '<span class="tag ' + esc(t.type) + '">' + esc(String(t.type).replace("_", " ")) + "</span>";
    h += "<strong>" + esc(who) + "</strong>";
    h += '<span class="txn-time">' + esc(timeAgo(t.status_updated)) + "</span></div>";

    if (t.adds) {
      Object.keys(t.adds).forEach(function (pid) {
        var team = teams[t.adds[pid]];
        h += '<div class="move"><span class="add">+</span> ' + esc(playerName(pid)) +
          ' <span class="pmeta">' + esc(playerMeta(pid)) + "</span>" +
          (t.roster_ids.length > 1 && team ? ' <span class="pmeta">→ ' + esc(team.manager) + "</span>" : "") +
          "</div>";
      });
    }
    if (t.drops) {
      Object.keys(t.drops).forEach(function (pid) {
        h += '<div class="move"><span class="drop">−</span> ' + esc(playerName(pid)) +
          ' <span class="pmeta">' + esc(playerMeta(pid)) + "</span></div>";
      });
    }
    if (t.draft_picks && t.draft_picks.length) {
      t.draft_picks.forEach(function (p) {
        h += '<div class="move"><span class="pmeta">Pick: ' + esc(p.season) + " round " + esc(p.round) + "</span></div>";
      });
    }
    var fab = (t.settings || {}).waiver_bid;
    if (fab) h += '<div class="move pmeta">Winning bid: $' + fab + "</div>";
    return h + "</div>";
  }

  /* ===== MANAGERS ===== */

  VIEWS.managers = function (root) {
    var h = '<h2 class="page-title">Managers</h2>';
    h += '<p class="page-sub">The six people responsible for all of this.</p>';
    h += '<div id="mgrs"><div class="loading"><div class="spinner"></div>Loading…</div></div>';
    root.innerHTML = h;

    Promise.all([gatherAllMatchups(), getChampions()]).then(function (res) {
      var games = res[0];
      var counts = titleCounts(res[1]);
      var agg = {};
      games.forEach(function (g) {
        if (!g.b) return;
        [[g.a, g.ap, g.bp], [g.b, g.bp, g.ap]].forEach(function (x) {
          var k = x[0].ownerId;
          if (!k) return;
          var r = agg[k] || (agg[k] = { w: 0, l: 0, pf: 0, g: 0 });
          r.g++; r.pf += x[1];
          if (x[1] > x[2]) r.w++; else if (x[1] < x[2]) r.l++;
        });
      });
      renderManagers(agg, counts);
    }).catch(function () { renderManagers({}, {}); });
  };

  function renderManagers(agg, counts) {
    var season = S.current;
    var users = userMap(season);
    var teams = teamMap(season);
    var byOwner = {};
    Object.keys(teams).forEach(function (rid) { byOwner[teams[rid].ownerId] = teams[rid]; });

    var ids = Object.keys(CONFIG.managers || {});
    // Include anyone in the league who isn't in the config file.
    Object.keys(byOwner).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });

    var h = '<div class="mgr-grid">';
    ids.forEach(function (id) {
      var cfg = (CONFIG.managers || {})[id] || {};
      var u = users[id] || {};
      var t = byOwner[id];
      var name = cfg.name || u.display_name || "Unknown";
      var img = cfg.photo || (t && t.avatar) || avatarUrl(u.avatar);
      var a = agg[id];

      h += '<div class="mgr"><div class="mgr-top">';
      h += img ? '<img class="avatar lg" src="' + esc(img) + '" alt="" loading="lazy">' : '<div class="avatar lg"></div>';
      h += "<div><h3>" + esc(name) + "</h3>";
      h += '<div class="sub">' + esc(t ? t.teamName : u.display_name || "") + "</div></div></div>";

      if (cfg.bio) h += '<p style="font-size:13.5px;color:var(--txt-dim);margin:0 0 8px">' + esc(cfg.bio) + "</p>";

      var rings = (counts || {})[name] || 0;
      if (rings) h += kv("Championships", new Array(rings + 1).join("🏆") + " " + rings, true);

      if (a) h += kv("All-time record", a.w + "-" + a.l + " (" + (100 * a.w / (a.g || 1)).toFixed(0) + "%)");
      if (a) h += kv("Points per game", fmt(a.pf / (a.g || 1), 1));
      if (cfg.location) h += kv("Location", cfg.location);
      if (cfg.fantasyStart) h += kv("Playing since", cfg.fantasyStart);
      if (cfg.favoriteTeam) {
        h += kv("Favorite team",
          '<img src="' + CDN + "/images/team_logos/nfl/" + esc(cfg.favoriteTeam) +
          '.png" alt="" style="height:20px;vertical-align:middle" onerror="this.remove()"> ' +
          esc(String(cfg.favoriteTeam).toUpperCase()), true);
      }
      if (cfg.favoritePlayer) h += kv("Favorite player", esc(playerName(String(cfg.favoritePlayer))));
      if (cfg.valuePosition) h += kv("Values most", esc(cfg.valuePosition));
      if (cfg.mode) h += kv("Mode", esc(cfg.mode));
      if (cfg.tradingScale) h += kv("Trade willingness", cfg.tradingScale + "/10");
      if (u.display_name) h += kv("Sleeper", "@" + esc(u.display_name));

      h += "</div>";
    });
    h += "</div>";
    el("mgrs").innerHTML = h;
  }

  function kv(k, v, raw) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' +
      (raw ? v : esc(v)) + "</span></div>";
  }

  /* ---------------- Champions ---------------- */

  var championsPromise = null;

  // Merges titles won on Sleeper with the pre-Sleeper ones from config.js.
  // Returns newest season first.
  function getChampions() {
    if (championsPromise) return championsPromise;

    var done = S.seasons.filter(function (s) {
      return s.league.status === "complete" || s.league.status === "post_season";
    });

    championsPromise = Promise.all(done.map(function (s) {
      return api("/league/" + s.leagueId + "/winners_bracket")
        .then(function (b) { return { season: s, bracket: b || [] }; })
        .catch(function () { return { season: s, bracket: [] }; });
    })).then(function (all) {
      var list = [];

      all.forEach(function (x) {
        var teams = teamMap(x.season);
        var champ = championFrom(x.bracket, teams);
        if (!champ) return;
        var st = champ.roster.settings || {};
        list.push({
          season: x.season.season,
          manager: champ.manager,
          team: champ.teamName,
          record: (st.wins || 0) + "-" + (st.losses || 0),
          avatar: champ.avatar,
          tracked: true,
        });
      });

      (CONFIG.pastChampions || []).forEach(function (c) {
        // Don't duplicate a season Sleeper already covers.
        if (list.some(function (x) { return String(x.season) === String(c.season); })) return;
        list.push({
          season: String(c.season),
          manager: c.manager,
          team: c.team || null,
          record: c.record || null,
          avatar: managerAvatar(c.manager),
          tracked: false,
        });
      });

      list.sort(function (a, b) { return Number(b.season) - Number(a.season); });
      return list;
    });

    return championsPromise;
  }

  // Best-effort photo for a manager named in pastChampions.
  function managerAvatar(name) {
    var ids = Object.keys(CONFIG.managers || {});
    for (var i = 0; i < ids.length; i++) {
      if ((CONFIG.managers[ids[i]] || {}).name === name) {
        if (CONFIG.managers[ids[i]].photo) return CONFIG.managers[ids[i]].photo;
        var u = userMap(S.current)[ids[i]];
        return u ? avatarUrl(u.avatar) : "";
      }
    }
    return "";
  }

  function titleCounts(champs) {
    var counts = {};
    champs.forEach(function (c) {
      counts[c.manager] = (counts[c.manager] || 0) + 1;
    });
    return counts;
  }

  /* ---------------- Shared data gathering ---------------- */

  var allMatchupsPromise = null;

  // Pulls every week of every season once, then reuses the result.
  function gatherAllMatchups() {
    if (allMatchupsPromise) return allMatchupsPromise;

    var jobs = [];
    S.seasons.forEach(function (season) {
      if (season.league.status === "pre_draft" || season.league.status === "drafting") return;
      var teams = teamMap(season);
      var last = totalWeeks(season);
      for (var w = 1; w <= last; w++) {
        (function (wk) {
          jobs.push(
            api("/league/" + season.leagueId + "/matchups/" + wk)
              .then(function (list) { return { season: season, teams: teams, week: wk, list: list || [] }; })
              .catch(function () { return { season: season, teams: teams, week: wk, list: [] }; })
          );
        })(w);
      }
    });

    allMatchupsPromise = Promise.all(jobs).then(function (chunks) {
      var games = [];
      chunks.forEach(function (c) {
        var groups = {};
        c.list.forEach(function (m) {
          if (m.matchup_id == null) return;      // bye / unplayed
          (groups[m.matchup_id] = groups[m.matchup_id] || []).push(m);
        });
        Object.keys(groups).forEach(function (k) {
          var g = groups[k];
          if (g.length < 2) return;
          // A week that hasn't been played yet reports 0–0; skip those.
          if (!g[0].points && !g[1].points) return;
          games.push({
            season: c.season.season,
            week: c.week,
            a: c.teams[g[0].roster_id],
            ap: g[0].points || 0,
            b: c.teams[g[1].roster_id],
            bp: g[1].points || 0,
          });
        });
      });
      return games.filter(function (g) { return g.a && g.b; });
    });

    return allMatchupsPromise;
  }

  /* ---------------- Season chips ---------------- */

  function seasonChips(activeId) {
    if (S.seasons.length < 2) return "";
    var h = '<div class="chips" style="margin-bottom:16px">';
    S.seasons.forEach(function (s) {
      h += '<button class="chip' + (s.leagueId === activeId ? " active" : "") +
        '" data-season="' + s.leagueId + '">' + esc(s.season) + "</button>";
    });
    return h + "</div>";
  }

  function wireSeasonChips(view) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-season]"), function (b) {
      b.addEventListener("click", function () { go(view, { season: this.dataset.season }); });
    });
  }

  /* ---------------- Router ---------------- */

  var params = {};

  function getParam(k) { return params[k]; }

  function go(view, p) {
    var q = Object.keys(p || {}).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]);
    }).join("&");
    location.hash = "#/" + view + (q ? "?" + q : "");
  }

  function parseHash() {
    var raw = location.hash.replace(/^#\/?/, "") || "home";
    var parts = raw.split("?");
    var view = parts[0] || "home";
    params = {};
    (parts[1] || "").split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return VIEWS[view] ? view : "home";
  }

  function route() {
    var view = parseHash();
    S.view = view;

    Array.prototype.forEach.call(document.querySelectorAll(".nav a"), function (a) {
      a.classList.toggle("active", a.dataset.view === view);
    });

    var root = el("app");
    root.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';
    try {
      VIEWS[view](root);
    } catch (e) {
      root.innerHTML = errBox(e);
    }
    window.scrollTo(0, 0);
  }

  function errBox(e) {
    return '<div class="card"><div class="error"><strong>Something went wrong.</strong><br>' +
      esc(e && e.message ? e.message : e) +
      "<br><br>This is usually a temporary Sleeper API hiccup — refresh the page to try again.</div></div>";
  }

  /* ---------------- Boot ---------------- */

  function boot() {
    document.title = CONFIG.leagueName + " · League Home";
    var bn = el("brand-name"), bt = el("brand-tag");
    if (bn) bn.textContent = CONFIG.leagueName;
    if (bt) bt.textContent = CONFIG.tagline || "";

    var app = el("app");
    app.innerHTML = '<div class="loading"><div class="spinner"></div>Loading league data from Sleeper…</div>';

    Promise.all([
      loadPlayers(),
      api("/state/nfl").then(function (s) { S.state = s; }).catch(function () {}),
      loadSeasonChain(),
    ]).then(function () {
      if (!S.current) {
        app.innerHTML = '<div class="card"><div class="error"><strong>League not found.</strong><br>' +
          "Sleeper returned nothing for league ID <code>" + esc(CONFIG.leagueId) + "</code>.<br><br>" +
          "Check the <code>leagueId</code> value in <code>config.js</code> — it should match the number " +
          "in your Sleeper URL.</div></div>";
        return;
      }
      window.addEventListener("hashchange", route);
      route();

      // Refresh live scores every 60s while a game week is in progress.
      setInterval(function () {
        if (S.view === "matchups" || S.view === "home") {
          memCache = {};
          route();
        }
      }, 60000);
    }).catch(function (e) {
      app.innerHTML = errBox(e);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
