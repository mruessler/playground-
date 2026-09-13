/* ============================================================
   Bracketeer — offline tournament tracker
   Vanilla JS, no dependencies, state persisted to localStorage.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var uid = function (p) { return (p || 'id') + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); };
  var clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var MIN_TEAMS = 2, MAX_TEAMS = 64;

  var MODES = {
    single: { label: 'Single elimination', hint: 'Lose once and you are out. Byes are handed to the top seeds automatically.' },
    double: { label: 'Double elimination', hint: 'Everyone gets a second life in the lower bracket. Two losses and you are out.' },
    roundrobin: { label: 'Round robin', hint: 'Everyone plays everyone. Ranked on points, then goal difference.' }
  };

  var OPTION_DEFS = {
    single: [{ key: 'thirdPlace', label: 'Play a third-place match', def: true }],
    double: [{ key: 'grandFinalReset', label: 'Bracket reset in the grand final', def: true }],
    roundrobin: [
      { key: 'doubleRR', label: 'Double round robin (home & away)', def: false },
      { key: 'allowDraws', label: 'Allow draws (1 point each)', def: true }
    ]
  };

  /* ---------- storage ---------- */
  var KEY = 'bracketeer.v1';
  var storageOK = true;
  function readStore() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { storageOK = false; return null; }
  }
  function writeStore() {
    try { localStorage.setItem(KEY, JSON.stringify({ tournament: T, draft: draft, theme: theme })); }
    catch (e) { storageOK = false; }
  }

  /* ---------- state ---------- */
  var T = null;      // the live tournament (null when none)
  var draft = null;  // setup form contents
  var theme = null;  // 'light' | 'dark' | null (follow system)

  function freshDraft() {
    return { name: '', mode: 'single', count: 8, names: [], options: {} };
  }
  function defaultOptions(mode, current) {
    var out = {};
    (OPTION_DEFS[mode] || []).forEach(function (o) {
      out[o.key] = current && Object.prototype.hasOwnProperty.call(current, o.key) ? !!current[o.key] : o.def;
    });
    return out;
  }
  function teamName(i) { return 'Team ' + (i + 1); }
  function draftNames() {
    var out = [];
    for (var i = 0; i < draft.count; i++) out.push((draft.names[i] || '').trim() || teamName(i));
    return out;
  }

  /* ============================================================
     Bracket generation
     ============================================================ */
  function nextPow2(n) { var p = 1; while (p < n) p *= 2; return Math.max(2, p); }

  // Standard seeding order for a bracket of size n: 1 v n, 2 v n-1, nested.
  function seedOrder(n) {
    var seeds = [1, 2];
    while (seeds.length < n) {
      var m = seeds.length * 2 + 1, next = [];
      for (var i = 0; i < seeds.length; i++) { next.push(seeds[i], m - seeds[i]); }
      seeds = next;
    }
    return seeds;
  }

  function mkMatch(o) {
    return {
      id: uid('m'), bracket: o.bracket, round: o.round, order: o.order,
      a: o.a || null, b: o.b || null, scoreA: null, scoreB: null,
      conditional: o.conditional || null, refs: o.refs || null
    };
  }

  function firstRoundSlots(teams) {
    var n = nextPow2(teams.length), order = seedOrder(n);
    return order.map(function (s) {
      return s <= teams.length ? { k: 'team', id: teams[s - 1].id } : { k: 'bye' };
    });
  }

  // Winners/upper bracket. Returns { matches, rounds: [[m,...],...] }
  function buildUpper(teams, bracketName) {
    var slots = firstRoundSlots(teams);
    var n = slots.length, total = Math.round(Math.log(n) / Math.log(2));
    var matches = [], rounds = [], prev = [];
    for (var r = 1; r <= total; r++) {
      var count = n / Math.pow(2, r), cur = [];
      for (var i = 0; i < count; i++) {
        var m = mkMatch({ bracket: bracketName, round: r, order: i });
        if (r === 1) { m.a = slots[2 * i]; m.b = slots[2 * i + 1]; }
        else { m.a = { k: 'W', m: prev[2 * i].id }; m.b = { k: 'W', m: prev[2 * i + 1].id }; }
        matches.push(m); cur.push(m);
      }
      rounds.push(cur); prev = cur;
    }
    return { matches: matches, rounds: rounds };
  }

  function buildSingle(teams, opts) {
    var up = buildUpper(teams, 'WB');
    var matches = up.matches.slice();
    var last = up.rounds.length;
    if (opts.thirdPlace && last >= 2) {
      var semis = up.rounds[last - 2];
      matches.push(mkMatch({
        bracket: '3P', round: last, order: 0,
        a: { k: 'L', m: semis[0].id }, b: { k: 'L', m: semis[1].id }
      }));
    }
    return matches;
  }

  function buildDouble(teams, opts) {
    var up = buildUpper(teams, 'WB');
    var wb = up.rounds, k = wb.length;
    var matches = up.matches.slice();
    var lbRound = 1, survivors = [];

    // Lower bracket round 1: the losers of upper round 1, paired up.
    var r1 = wb[0];
    for (var i = 0; i < r1.length / 2; i++) {
      survivors.push(mkMatch({
        bracket: 'LB', round: lbRound, order: i,
        a: { k: 'L', m: r1[2 * i].id }, b: { k: 'L', m: r1[2 * i + 1].id }
      }));
    }
    matches = matches.concat(survivors);
    lbRound++;

    for (var ri = 1; ri < k; ri++) {
      // "major" round — lower-bracket survivors meet the freshly dropped upper-bracket losers
      var dropped = wb[ri].map(function (m) { return { k: 'L', m: m.id }; });
      if (ri % 2 === 1) dropped.reverse();          // reduces early rematches
      var major = survivors.map(function (s, j) {
        return mkMatch({
          bracket: 'LB', round: lbRound, order: j,
          a: dropped[j], b: { k: 'W', m: s.id }
        });
      });
      matches = matches.concat(major);
      survivors = major; lbRound++;

      // "minor" round — survivors play each other to halve the field
      if (survivors.length > 1) {
        var minor = [];
        for (var j2 = 0; j2 < survivors.length / 2; j2++) {
          minor.push(mkMatch({
            bracket: 'LB', round: lbRound, order: j2,
            a: { k: 'W', m: survivors[2 * j2].id }, b: { k: 'W', m: survivors[2 * j2 + 1].id }
          }));
        }
        matches = matches.concat(minor);
        survivors = minor; lbRound++;
      }
    }

    var wbFinal = wb[k - 1][0], lbFinal = survivors[0];
    var gf1 = mkMatch({
      bracket: 'GF', round: 1, order: 0,
      a: { k: 'W', m: wbFinal.id }, b: { k: 'W', m: lbFinal.id }
    });
    matches.push(gf1);

    if (opts.grandFinalReset) {
      var gf2 = mkMatch({
        bracket: 'GF', round: 2, order: 0,
        a: { k: 'W', m: gf1.id }, b: { k: 'L', m: gf1.id },
        conditional: 'reset'
      });
      gf2.refs = { gf1: gf1.id, wbFinal: wbFinal.id };
      matches.push(gf2);
    }
    return matches;
  }

  function buildRoundRobin(teams, opts) {
    var ids = teams.map(function (t) { return t.id; });
    var ghost = null;
    if (ids.length % 2 === 1) { ghost = '__bye__'; ids = ids.concat([ghost]); }
    var n = ids.length, roundsN = n - 1, matches = [], list = ids.slice();

    for (var r = 0; r < roundsN; r++) {
      for (var i = 0; i < n / 2; i++) {
        var home = list[i], away = list[n - 1 - i];
        if (home === ghost || away === ghost) continue;
        var flip = (r % 2 === 1 && i === 0);   // keeps the fixed team from always playing at home
        matches.push(mkMatch({
          bracket: 'RR', round: r + 1, order: i,
          a: { k: 'team', id: flip ? away : home }, b: { k: 'team', id: flip ? home : away }
        }));
      }
      list = [list[0]].concat([list[n - 1]]).concat(list.slice(1, n - 1)); // rotate
    }

    if (opts.doubleRR) {
      var firstLeg = matches.slice();
      firstLeg.forEach(function (m) {
        matches.push(mkMatch({
          bracket: 'RR', round: m.round + roundsN, order: m.order,
          a: { k: 'team', id: m.b.id }, b: { k: 'team', id: m.a.id }
        }));
      });
    }
    return matches;
  }

  function createTournament(cfg) {
    var teams = cfg.names.map(function (nm, i) { return { id: 't' + (i + 1) + '_' + uid(''), name: nm, seed: i + 1 }; });
    var opts = defaultOptions(cfg.mode, cfg.options);
    var matches;
    if (cfg.mode === 'single') matches = buildSingle(teams, opts);
    else if (cfg.mode === 'double') matches = buildDouble(teams, opts);
    else matches = buildRoundRobin(teams, opts);

    return {
      version: 1,
      id: uid('t'),
      name: (cfg.name || '').trim() || 'Untitled tournament',
      mode: cfg.mode,
      options: opts,
      teams: teams,
      matches: matches,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /* ============================================================
     Resolution — who is in each slot, who won, what comes next
     ============================================================ */
  function teamById(id) {
    for (var i = 0; i < T.teams.length; i++) if (T.teams[i].id === id) return T.teams[i];
    return null;
  }

  function resolveAll() {
    var res = {};
    function slotOf(ref) {
      if (!ref) return { t: 'tbd' };
      if (ref.k === 'bye') return { t: 'bye' };
      if (ref.k === 'team') return { t: 'team', id: ref.id };
      var src = res[ref.m];
      if (!src) return { t: 'tbd' };
      var target = ref.k === 'W' ? src.winner : src.loser;
      return target ? target : { t: 'tbd', from: ref };
    }

    T.matches.forEach(function (m) {
      // Grand-final reset only happens when the lower-bracket side wins game one.
      if (m.conditional === 'reset') {
        var g1 = res[m.refs.gf1], wbf = res[m.refs.wbFinal];
        if (!g1 || !g1.winner || !wbf || !wbf.winner) {
          res[m.id] = { a: { t: 'tbd' }, b: { t: 'tbd' }, winner: null, loser: null, status: 'locked' };
          return;
        }
        if (g1.winner.t === 'team' && wbf.winner.t === 'team' && g1.winner.id === wbf.winner.id) {
          res[m.id] = { a: { t: 'tbd' }, b: { t: 'tbd' }, winner: null, loser: null, status: 'void' };
          return;
        }
      }

      var a = slotOf(m.a), b = slotOf(m.b);
      var winner = null, loser = null, status = 'pending';

      if (a.t === 'bye' && b.t === 'bye') { winner = { t: 'bye' }; loser = { t: 'bye' }; status = 'bye'; }
      else if (a.t === 'bye' && b.t === 'team') { winner = b; loser = { t: 'bye' }; status = 'bye'; }
      else if (b.t === 'bye' && a.t === 'team') { winner = a; loser = { t: 'bye' }; status = 'bye'; }
      else if (a.t === 'team' && b.t === 'team') {
        var sa = m.scoreA, sb = m.scoreB;
        if (sa != null && sb != null) {
          if (sa > sb) { winner = a; loser = b; status = 'done'; }
          else if (sb > sa) { winner = b; loser = a; status = 'done'; }
          else { status = drawsAllowed() ? 'draw' : 'tie'; }
        } else { status = 'ready'; }
      }
      res[m.id] = { a: a, b: b, winner: winner, loser: loser, status: status };
    });
    return res;
  }

  function drawsAllowed() { return T.mode === 'roundrobin' && T.options.allowDraws !== false; }

  function playableMatches(res) {
    return T.matches.filter(function (m) {
      var r = res[m.id];
      return r.status !== 'bye' && r.status !== 'void' && r.status !== 'locked';
    });
  }
  function playedCount(res) {
    return playableMatches(res).filter(function (m) {
      var s = res[m.id].status; return s === 'done' || s === 'draw';
    }).length;
  }

  /* ---------- standings (round robin) ---------- */
  function standings(res) {
    var rows = {};
    T.teams.forEach(function (t) {
      rows[t.id] = { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
    });
    T.matches.forEach(function (m) {
      var r = res[m.id];
      if (r.status !== 'done' && r.status !== 'draw') return;
      var A = rows[r.a.id], B = rows[r.b.id];
      if (!A || !B) return;
      A.p++; B.p++;
      A.gf += m.scoreA; A.ga += m.scoreB;
      B.gf += m.scoreB; B.ga += m.scoreA;
      if (r.status === 'draw') { A.d++; B.d++; A.pts += 1; B.pts += 1; }
      else if (r.winner.id === A.team.id) { A.w++; B.l++; A.pts += 3; }
      else { B.w++; A.l++; B.pts += 3; }
    });
    var list = Object.keys(rows).map(function (k) {
      var r = rows[k]; r.gd = r.gf - r.ga; return r;
    });
    list.sort(function (x, y) {
      return (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) ||
        (x.team.seed - y.team.seed);
    });
    return list;
  }

  /* ---------- champion & podium ---------- */
  function outcome(res) {
    var out = { champion: null, runnerUp: null, third: null, complete: false };
    if (!T) return out;

    if (T.mode === 'roundrobin') {
      var table = standings(res);
      var remaining = playableMatches(res).length - playedCount(res);
      out.complete = remaining === 0;
      if (out.complete && table.length) {
        out.champion = table[0].team;
        if (table[1]) out.runnerUp = table[1].team;
        if (table[2]) out.third = table[2].team;
        var tied = table[1] && table[1].pts === table[0].pts && table[1].gd === table[0].gd && table[1].gf === table[0].gf;
        out.sharedTop = !!tied;
      }
      return out;
    }

    var decider = null;
    if (T.mode === 'double') {
      var gf2 = T.matches.filter(function (m) { return m.conditional === 'reset'; })[0];
      var gf1 = T.matches.filter(function (m) { return m.bracket === 'GF' && !m.conditional; })[0];
      decider = (gf2 && res[gf2.id].status !== 'void' && res[gf2.id].status !== 'locked') ? gf2 : gf1;
      if (gf2 && res[gf2.id].status === 'locked') decider = gf1;
    } else {
      var wb = T.matches.filter(function (m) { return m.bracket === 'WB'; });
      decider = wb[wb.length - 1];
    }
    if (decider) {
      var r = res[decider.id];
      if (r && r.winner && r.winner.t === 'team') {
        // still need game two of a grand final before crowning anyone
        if (T.mode === 'double' && !decider.conditional) {
          var gf2b = T.matches.filter(function (m) { return m.conditional === 'reset'; })[0];
          if (gf2b && res[gf2b.id].status !== 'void') return out;
        }
        out.complete = true;
        out.champion = teamById(r.winner.id);
        if (r.loser && r.loser.t === 'team') out.runnerUp = teamById(r.loser.id);
      }
    }
    var third = T.matches.filter(function (m) { return m.bracket === '3P'; })[0];
    if (third && res[third.id] && res[third.id].winner && res[third.id].winner.t === 'team') {
      out.third = teamById(res[third.id].winner.id);
    }
    return out;
  }

  /* ============================================================
     Rendering
     ============================================================ */
  var el = {};
  function cacheEls() {
    ['setupCard', 'setupBody', 'setupForm', 'toggleSetupBtn', 'setupSubtitle', 'tName', 'tMode', 'tCount',
      'countMinus', 'countPlus', 'modeHint', 'countHint', 'optRow', 'teamGrid', 'teamsCountPill', 'shuffleBtn',
      'pasteToggle', 'pasteBox', 'pasteArea', 'pasteApply', 'clearNamesBtn', 'generateBtn', 'applyNamesBtn',
      'setupMsg', 'liveSection', 'liveTitle', 'summaryMeta', 'progressBar', 'progressLabel', 'view',
      'championBox', 'emptyState', 'themeBtn', 'exportBtn', 'importBtn', 'importFile', 'printBtn',
      'deleteBtn', 'toast', 'confirmModal', 'confirmText', 'confirmOk', 'confirmCancel'
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function initials(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function hueOf(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function avatar(name) {
    var h = hueOf(name || '');
    return '<span class="avatar" aria-hidden="true" style="background:linear-gradient(135deg,hsl(' + h + ' 62% 52%),hsl(' + ((h + 38) % 360) + ' 66% 44%))">' + esc(initials(name)) + '</span>';
  }

  function roundLabel(matchCount, isFinalRound) {
    if (matchCount === 1) return isFinalRound === false ? 'Round' : 'Final';
    if (matchCount === 2) return 'Semi-finals';
    if (matchCount === 4) return 'Quarter-finals';
    return 'Round of ' + matchCount * 2;
  }

  function slotHTML(m, side, slot, res) {
    var r = res[m.id];
    var cls = ['slot'];
    var nameHTML, seedHTML = '', av = '';
    var value = side === 'a' ? m.scoreA : m.scoreB;
    var disabled = true;

    if (slot.t === 'team') {
      var t = teamById(slot.id);
      var nm = t ? t.name : 'Unknown';
      nameHTML = esc(nm);
      seedHTML = t ? '<span class="s-seed">#' + t.seed + '</span>' : '';
      av = avatar(nm);
      disabled = !(r.a.t === 'team' && r.b.t === 'team');
      var isWinner = r.winner && r.winner.t === 'team' && r.winner.id === slot.id;
      // A walkover is not a result — never dress it up as one.
      if (isWinner) cls.push(r.status === 'bye' ? 'advanced' : 'won');
      else if (r.status === 'done') cls.push('lost');
    } else if (slot.t === 'bye') {
      cls.push('bye'); nameHTML = 'Bye'; av = '<span class="avatar" aria-hidden="true">–</span>';
    } else {
      cls.push('tbd');
      nameHTML = r.status === 'void' ? '&mdash;' : pendingLabel(m, side);
      av = '<span class="avatar" aria-hidden="true">' + (r.status === 'void' ? '&ndash;' : '?') + '</span>';
    }
    if (r.status === 'void' || r.status === 'locked') { disabled = true; }

    // A walkover or a match that will never be played gets no score box at all.
    var scoreHTML;
    if (r.status === 'bye' || r.status === 'void' || r.status === 'locked') {
      scoreHTML = cls.indexOf('advanced') > -1
        ? '<span class="tag-advance">Advances</span>'
        : '<span class="score-blank" aria-hidden="true"></span>';
    } else {
      scoreHTML = '<input class="score" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" ' +
        'value="' + (value == null ? '' : value) + '" ' +
        'data-match="' + m.id + '" data-side="' + side + '" ' +
        (disabled ? 'disabled ' : '') +
        'aria-label="Score for ' + (slot.t === 'team' ? esc(teamById(slot.id) ? teamById(slot.id).name : '') : 'the undecided team') + '">';
    }

    return '<div class="' + cls.join(' ') + '">' + av +
      '<span class="s-name">' + nameHTML + '</span>' + seedHTML + scoreHTML + '</div>';
  }

  // Human-readable "waiting for…" text, e.g. "Winner of M4"
  function pendingLabel(m, side) {
    var ref = side === 'a' ? m.a : m.b;
    if (!ref || ref.k === 'team') return 'To be decided';
    if (ref.k === 'bye') return 'Bye';
    var src = matchIndex[ref.m];
    if (!src) return 'To be decided';
    return (ref.k === 'W' ? 'Winner of ' : 'Loser of ') + src.label;
  }

  var matchIndex = {};   // id -> { label }
  function buildMatchIndex() {
    matchIndex = {};
    var n = 0;
    T.matches.forEach(function (m) {
      n++;
      var label;
      if (m.bracket === 'GF') label = m.conditional === 'reset' ? 'GF2' : 'GF';
      else if (m.bracket === '3P') label = '3rd';
      else if (m.bracket === 'LB') label = 'L' + m.round + '.' + (m.order + 1);
      else if (m.bracket === 'RR') label = 'R' + m.round + '.' + (m.order + 1);
      else label = 'M' + n;
      matchIndex[m.id] = { label: label, num: n };
    });
  }

  function matchHTML(m, res, opts) {
    opts = opts || {};
    var r = res[m.id];
    var cls = ['match'];
    if (r.status === 'done') cls.push('is-done');
    if (r.status === 'ready' || r.status === 'tie' || r.status === 'draw') cls.push('is-live');
    if (r.status === 'void' || r.status === 'locked') cls.push('is-void');
    if (r.status === 'bye') cls.push('is-bye');
    if (opts.final) cls.push('is-final');

    var head = opts.title || matchIndex[m.id].label;
    if (r.status === 'bye') head += ' · walkover';
    var canClear = (m.scoreA != null || m.scoreB != null);

    var note = '';
    if (r.status === 'tie') note = '<div class="m-note warn">A knockout match needs a winner — break the tie.</div>';
    else if (r.status === 'void') note = '<div class="m-note info">Not needed — the upper-bracket team held on.</div>';
    else if (r.status === 'locked') note = '<div class="m-note info">Only played if the lower-bracket team wins game one.</div>';
    else if (r.status === 'bye') {
      var adv = r.winner && r.winner.t === 'team' ? teamById(r.winner.id) : null;
      note = '<div class="m-note info">Not played &mdash; ' +
        (adv ? esc(adv.name) + ' had no opponent in this round.' : 'nobody to play.') + '</div>';
    }

    return '<div class="' + cls.join(' ') + '" data-match="' + m.id + '">' +
      '<div class="m-head"><span>' + esc(head) + '</span>' +
      (canClear ? '<button type="button" class="m-clear" data-clear="' + m.id + '" title="Clear this result">Clear</button>' : '') +
      '</div>' +
      slotHTML(m, 'a', r.a, res) +
      slotHTML(m, 'b', r.b, res) +
      note +
      '</div>';
  }

  function bracketColumnsHTML(matches, res, titleFor, finalId) {
    var byRound = {};
    matches.forEach(function (m) { (byRound[m.round] = byRound[m.round] || []).push(m); });
    var rounds = Object.keys(byRound).map(Number).sort(function (a, b) { return a - b; });
    var html = '<div class="bracket-scroll"><div class="bracket">';
    rounds.forEach(function (r, idx) {
      var list = byRound[r];
      html += '<div class="round"><div class="round-head">' + esc(titleFor(r, list, idx === rounds.length - 1)) + '</div><div class="round-body">';
      list.forEach(function (m) {
        html += matchHTML(m, res, { final: m.id === finalId });
      });
      html += '</div></div>';
    });
    return html + '</div></div>';
  }

  function renderSingle(res) {
    var wb = T.matches.filter(function (m) { return m.bracket === 'WB'; });
    var finalMatch = wb[wb.length - 1];
    var html = bracketColumnsHTML(wb, res, function (r, list, isLast) {
      return roundLabel(list.length, isLast);
    }, finalMatch.id);

    var third = T.matches.filter(function (m) { return m.bracket === '3P'; });
    if (third.length) {
      html += '<div class="section-title"><h2>Third-place match</h2></div>' +
        '<div class="bracket-scroll"><div class="bracket"><div class="round"><div class="round-body">' +
        matchHTML(third[0], res, { title: 'Third place' }) + '</div></div></div></div>';
    }
    return html;
  }

  function renderDouble(res) {
    var wb = T.matches.filter(function (m) { return m.bracket === 'WB'; });
    var lb = T.matches.filter(function (m) { return m.bracket === 'LB'; });
    var gf = T.matches.filter(function (m) { return m.bracket === 'GF'; });

    var html = '<div class="section-title"><h2>Upper bracket</h2><span class="muted">Lose here and you drop to the lower bracket.</span></div>';
    html += bracketColumnsHTML(wb, res, function (r, list, isLast) {
      return isLast ? 'Upper final' : 'Upper round ' + r;
    }, null);

    html += '<div class="section-title"><h2>Lower bracket</h2><span class="muted">Second chance — one more loss and you are out.</span></div>';
    html += bracketColumnsHTML(lb, res, function (r, list, isLast) {
      return isLast ? 'Lower final' : 'Lower round ' + r;
    }, null);

    html += '<div class="section-title"><h2>Grand final</h2></div>';
    html += '<div class="bracket-scroll"><div class="bracket">';
    gf.forEach(function (m) {
      html += '<div class="round"><div class="round-head">' + (m.conditional === 'reset' ? 'Game two (if needed)' : 'Game one') + '</div><div class="round-body">' +
        matchHTML(m, res, { final: true, title: m.conditional === 'reset' ? 'Bracket reset' : 'Grand final' }) + '</div></div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderRoundRobin(res) {
    var table = standings(res);
    var rows = table.map(function (r, i) {
      return '<tr' + (i === 0 && r.p > 0 ? ' class="leader"' : '') + '>' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="team-cell"><span class="team-inline">' + avatar(r.team.name) + '<span>' + esc(r.team.name) + '</span></span></td>' +
        '<td>' + r.p + '</td><td>' + r.w + '</td>' + (T.options.allowDraws !== false ? '<td>' + r.d + '</td>' : '') +
        '<td>' + r.l + '</td><td>' + r.gf + '</td><td>' + r.ga + '</td>' +
        '<td>' + (r.gd > 0 ? '+' : '') + r.gd + '</td><td class="pts">' + r.pts + '</td></tr>';
    }).join('');

    var head = '<table class="standings"><thead><tr>' +
      '<th>#</th><th class="team-cell">Team</th><th title="Played">P</th><th title="Won">W</th>' +
      (T.options.allowDraws !== false ? '<th title="Drawn">D</th>' : '') +
      '<th title="Lost">L</th><th title="Points scored">F</th><th title="Points conceded">A</th>' +
      '<th title="Difference">+/−</th><th title="Table points">Pts</th></tr></thead><tbody>' + rows + '</tbody></table>';

    var byRound = {};
    T.matches.forEach(function (m) { (byRound[m.round] = byRound[m.round] || []).push(m); });
    var fixtures = Object.keys(byRound).map(Number).sort(function (a, b) { return a - b; }).map(function (r) {
      return '<div class="fix-round"><h4>Round ' + r + '</h4><div class="fix-list">' +
        byRound[r].map(function (m) { return matchHTML(m, res); }).join('') +
        '</div></div>';
    }).join('');

    return '<div class="rr-layout">' +
      '<div><div class="section-title"><h2>Standings</h2><span class="muted">3 points a win' +
      (T.options.allowDraws !== false ? ', 1 a draw' : '') + '</span></div>' +
      '<div class="card"><div class="card-body table-wrap">' + head + '</div></div></div>' +
      '<div><div class="section-title"><h2>Fixtures</h2><span class="muted">Type the scores straight in</span></div>' +
      '<div class="fixtures">' + fixtures + '</div></div>' +
      '</div>';
  }

  function renderChampion(res) {
    var o = outcome(res);
    if (!o.champion) { el.championBox.innerHTML = ''; return; }
    var extra = [];
    if (o.runnerUp) extra.push('<span>🥈 ' + esc(o.runnerUp.name) + '</span>');
    if (o.third) extra.push('<span>🥉 ' + esc(o.third.name) + '</span>');
    el.championBox.innerHTML =
      '<div class="champion">' +
      '<span class="trophy" aria-hidden="true">🏆</span>' +
      '<div><div class="sub">' + (o.sharedTop ? 'Top of the table (tied on every tie-break)' : 'Champion') + '</div>' +
      '<div class="who">' + esc(o.champion.name) + '</div></div>' +
      (extra.length ? '<div class="podium">' + extra.join('') + '</div>' : '') +
      '</div>';
  }

  function renderTournament(focusSel) {
    if (!T) {
      el.liveSection.hidden = true;
      el.emptyState.hidden = false;
      el.view.innerHTML = '';
      el.championBox.innerHTML = '';
      return;
    }
    el.liveSection.hidden = false;
    el.emptyState.hidden = true;
    buildMatchIndex();
    var res = resolveAll();

    el.liveTitle.textContent = T.name;
    var bits = [MODES[T.mode].label, T.teams.length + ' teams'];
    if (T.mode === 'roundrobin' && T.options.doubleRR) bits.push('home & away');
    if (T.mode === 'single' && T.options.thirdPlace) bits.push('third-place match');
    el.summaryMeta.textContent = bits.join(' · ');

    var total = playableMatches(res).length, played = playedCount(res);
    el.progressBar.style.width = (total ? Math.round(played / total * 100) : 0) + '%';
    el.progressLabel.textContent = played + ' of ' + total + ' matches played';

    if (T.mode === 'single') el.view.innerHTML = renderSingle(res);
    else if (T.mode === 'double') el.view.innerHTML = renderDouble(res);
    else el.view.innerHTML = renderRoundRobin(res);

    renderChampion(res);

    if (focusSel) {
      var input = document.querySelector(focusSel);
      if (input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }
  }

  /* ============================================================
     Setup form
     ============================================================ */
  function renderOptions() {
    var defs = OPTION_DEFS[draft.mode] || [];
    draft.options = defaultOptions(draft.mode, draft.options);
    if (!defs.length) { el.optRow.innerHTML = '<span class="opt-empty">No extra options for this format.</span>'; return; }
    el.optRow.innerHTML = defs.map(function (o) {
      return '<label class="check"><input type="checkbox" data-opt="' + o.key + '"' +
        (draft.options[o.key] ? ' checked' : '') + '> ' + esc(o.label) + '</label>';
    }).join('');
  }

  function renderTeamInputs() {
    var html = '';
    for (var i = 0; i < draft.count; i++) {
      var v = draft.names[i] == null ? '' : draft.names[i];
      html += '<div class="team-row">' +
        '<span class="seed" title="Seed ' + (i + 1) + '">' + (i + 1) + '</span>' +
        '<input type="text" class="team-input" data-i="' + i + '" maxlength="40" ' +
        'value="' + esc(v) + '" placeholder="' + teamName(i) + '" ' +
        'aria-label="Name of team ' + (i + 1) + '" autocomplete="off">' +
        '</div>';
    }
    el.teamGrid.innerHTML = html;
    el.teamsCountPill.textContent = draft.count;
  }

  // Spells out what the team count means before anything is generated, so a
  // walkover in round one is never a surprise.
  function updateCountHint() {
    var n = draft.count, txt;
    if (draft.mode === 'roundrobin') {
      var games = n * (n - 1) / 2;
      if (draft.options.doubleRR) games *= 2;
      txt = n + ' teams · ' + games + ' matches';
    } else {
      var size = nextPow2(n), byes = size - n;
      txt = n + ' teams · ' + size + '-team bracket · ' +
        (byes ? byes + (byes === 1 ? ' bye' : ' byes') + ' in round one, given to the top seeds' : 'no byes');
    }
    el.countHint.textContent = txt;
  }

  function renderSetup() {
    el.tName.value = draft.name;
    el.tMode.value = draft.mode;
    el.tCount.value = draft.count;
    el.modeHint.textContent = MODES[draft.mode].hint;
    renderOptions();
    renderTeamInputs();
    updateCountHint();
    el.applyNamesBtn.hidden = !(T && T.teams.length === draft.count);
    el.generateBtn.textContent = T ? 'Regenerate tournament' : 'Generate tournament';
    setSetupMsg('');
  }

  function setSetupMsg(msg) { el.setupMsg.textContent = msg || ''; }

  function setCount(n) {
    draft.count = clamp(n, MIN_TEAMS, MAX_TEAMS);
    renderTeamInputs();
    updateCountHint();
    el.tCount.value = draft.count;
    el.applyNamesBtn.hidden = !(T && T.teams.length === draft.count);
    writeStore();
  }

  function collapseSetup(collapsed) {
    el.setupBody.hidden = collapsed;
    el.toggleSetupBtn.textContent = collapsed ? 'Edit' : 'Hide';
    el.toggleSetupBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  /* ============================================================
     Interaction
     ============================================================ */
  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(function () { el.toast.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
      setTimeout(function () { el.toast.hidden = true; }, 220);
    }, 2600);
  }

  var confirmCb = null;
  function askConfirm(text, cb) {
    el.confirmText.textContent = text;
    el.confirmModal.hidden = false;
    confirmCb = cb;
    el.confirmOk.focus();
  }
  function closeConfirm() { el.confirmModal.hidden = true; confirmCb = null; }

  function touch() { if (T) T.updatedAt = Date.now(); writeStore(); }

  function parseScore(v) {
    var s = String(v).replace(/[^0-9]/g, '');
    if (s === '') return null;
    return clamp(parseInt(s, 10), 0, 999);
  }

  function onScoreInput(e) {
    var input = e.target;
    if (!input.classList.contains('score')) return;
    var m = T.matches.filter(function (x) { return x.id === input.dataset.match; })[0];
    if (!m) return;
    var val = parseScore(input.value);
    if (input.dataset.side === 'a') m.scoreA = val; else m.scoreB = val;
    touch();
    renderTournament('.score[data-match="' + m.id + '"][data-side="' + input.dataset.side + '"]');
  }

  function onViewClick(e) {
    var clearBtn = e.target.closest ? e.target.closest('[data-clear]') : null;
    if (clearBtn) {
      var id = clearBtn.getAttribute('data-clear');
      var m = T.matches.filter(function (x) { return x.id === id; })[0];
      if (m) { m.scoreA = null; m.scoreB = null; touch(); renderTournament(); }
    }
  }

  function applyTheme() {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else {
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
  }

  function exportJSON() {
    var data = JSON.stringify({ app: 'bracketeer', version: 1, tournament: T }, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (T.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tournament') + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Exported a backup file');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        var t = parsed && parsed.tournament ? parsed.tournament : parsed;
        if (!t || !t.matches || !t.teams || !t.mode) throw new Error('bad file');
        T = t;
        T.options = T.options || {};
        draft.name = T.name; draft.mode = T.mode; draft.count = T.teams.length;
        draft.names = T.teams.map(function (x) { return x.name; });
        draft.options = defaultOptions(T.mode, T.options);
        writeStore();
        renderSetup(); renderTournament(); collapseSetup(true);
        toast('Tournament imported');
      } catch (err) {
        toast('That file could not be read');
      }
    };
    reader.readAsText(file);
  }

  /* ============================================================
     Wiring
     ============================================================ */
  function wire() {
    // ── setup form
    el.tName.addEventListener('input', function () { draft.name = el.tName.value; writeStore(); });

    el.tMode.addEventListener('change', function () {
      draft.mode = el.tMode.value;
      el.modeHint.textContent = MODES[draft.mode].hint;
      renderOptions();
      updateCountHint();
      writeStore();
    });

    el.tCount.addEventListener('input', function () {
      var digits = el.tCount.value.replace(/[^0-9]/g, '');
      el.tCount.value = digits;
    });
    el.tCount.addEventListener('change', function () {
      var n = parseInt(el.tCount.value, 10);
      setCount(isNaN(n) ? MIN_TEAMS : n);
    });
    el.tCount.addEventListener('blur', function () {
      var n = parseInt(el.tCount.value, 10);
      setCount(isNaN(n) ? MIN_TEAMS : n);
    });
    el.countMinus.addEventListener('click', function () { setCount(draft.count - 1); });
    el.countPlus.addEventListener('click', function () { setCount(draft.count + 1); });

    el.optRow.addEventListener('change', function (e) {
      var key = e.target.getAttribute && e.target.getAttribute('data-opt');
      if (!key) return;
      draft.options[key] = e.target.checked;
      updateCountHint();
      writeStore();
    });

    el.teamGrid.addEventListener('input', function (e) {
      var i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i == null) return;
      draft.names[+i] = e.target.value;
      writeStore();
    });

    el.shuffleBtn.addEventListener('click', function () {
      var names = draftNames();
      for (var i = names.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = names[i]; names[i] = names[j]; names[j] = tmp;
      }
      draft.names = names;
      renderTeamInputs(); writeStore();
      setSetupMsg('Seeding shuffled — generate to apply it.');
    });

    el.clearNamesBtn.addEventListener('click', function () {
      draft.names = [];
      renderTeamInputs(); writeStore();
    });

    el.pasteToggle.addEventListener('click', function () {
      var show = el.pasteBox.hidden;
      el.pasteBox.hidden = !show;
      el.pasteToggle.setAttribute('aria-expanded', String(show));
      if (show) el.pasteArea.focus();
    });

    el.pasteApply.addEventListener('click', function () {
      var lines = el.pasteArea.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length < MIN_TEAMS) { setSetupMsg('Give me at least ' + MIN_TEAMS + ' names.'); return; }
      if (lines.length > MAX_TEAMS) lines = lines.slice(0, MAX_TEAMS);
      draft.names = lines;
      draft.count = lines.length;
      el.tCount.value = draft.count;
      renderTeamInputs();
      updateCountHint();
      el.pasteBox.hidden = true;
      el.pasteToggle.setAttribute('aria-expanded', 'false');
      writeStore();
      setSetupMsg(lines.length + ' teams loaded.');
    });

    el.setupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var names = draftNames();
      var dupes = {}, hasDupe = false;
      names.forEach(function (n) {
        var k = n.toLowerCase();
        if (dupes[k]) hasDupe = true; dupes[k] = true;
      });
      var go = function () {
        T = createTournament({ name: draft.name, mode: draft.mode, names: names, options: draft.options });
        draft.names = names;
        writeStore();
        renderSetup();
        renderTournament();
        collapseSetup(true);
        toast('Tournament generated');
        el.liveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      if (hasDupe) setSetupMsg('Heads up: two teams share a name.');
      if (T) {
        askConfirm('This replaces the current tournament and every score already entered. Continue?', go);
      } else { go(); }
    });

    el.applyNamesBtn.addEventListener('click', function () {
      if (!T || T.teams.length !== draft.count) return;
      var names = draftNames();
      T.teams.forEach(function (t, i) { t.name = names[i]; });
      touch(); renderTournament();
      toast('Team names updated');
    });

    el.toggleSetupBtn.addEventListener('click', function () { collapseSetup(!el.setupBody.hidden); });

    // ── live tournament
    el.view.addEventListener('input', onScoreInput);
    el.view.addEventListener('click', onViewClick);
    el.view.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('score')) { e.preventDefault(); e.target.blur(); }
    });
    el.view.addEventListener('focusin', function (e) {
      if (e.target.classList.contains('score')) e.target.select();
    });

    el.exportBtn.addEventListener('click', exportJSON);
    el.importBtn.addEventListener('click', function () { el.importFile.click(); });
    el.importFile.addEventListener('change', function () {
      if (el.importFile.files && el.importFile.files[0]) importJSON(el.importFile.files[0]);
      el.importFile.value = '';
    });
    el.printBtn.addEventListener('click', function () { window.print(); });
    el.deleteBtn.addEventListener('click', function () {
      askConfirm('Delete this tournament and all its scores? This cannot be undone.', function () {
        T = null; writeStore(); renderTournament(); collapseSetup(false); renderSetup();
        toast('Tournament deleted');
      });
    });

    // ── chrome
    el.themeBtn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      theme = current === 'dark' ? 'light' : 'dark';
      applyTheme(); writeStore();
    });

    el.confirmOk.addEventListener('click', function () {
      var cb = confirmCb; closeConfirm(); if (cb) cb();
    });
    el.confirmCancel.addEventListener('click', closeConfirm);
    el.confirmModal.addEventListener('click', function (e) { if (e.target === el.confirmModal) closeConfirm(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.confirmModal.hidden) closeConfirm();
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var listener = function () { if (!theme) applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', listener);
      else if (mq.addListener) mq.addListener(listener);
    }
  }

  /* ============================================================
     Boot
     ============================================================ */
  function init() {
    cacheEls();
    var saved = readStore();
    draft = (saved && saved.draft) || freshDraft();
    draft.names = draft.names || [];
    draft.count = clamp(parseInt(draft.count, 10) || 8, MIN_TEAMS, MAX_TEAMS);
    if (!MODES[draft.mode]) draft.mode = 'single';
    T = (saved && saved.tournament) || null;
    theme = (saved && saved.theme) || null;

    applyTheme();
    wire();
    renderSetup();
    renderTournament();
    if (T) collapseSetup(true);

    if (!storageOK) {
      var b = document.createElement('div');
      b.className = 'banner';
      b.textContent = 'This browser is blocking local storage, so your tournament will not survive a reload. Use Export to keep a copy.';
      el.setupBody.insertBefore(b, el.setupBody.firstChild);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
