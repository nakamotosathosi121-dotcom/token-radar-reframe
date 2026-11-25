// Token Launch Radar — Mispricing Screen, model radar-4. It reads window.RADAR (written
// beside dashboard/ by main.ts from the sealed snapshot) and renders the screen, the
// pre-token board, a detail view per protocol and the live-token residual view.
// No network: every byte is in data.js.
//
// Two tracks, kept strictly apart — this is the whole point of the reframe:
//
//   TRADED (24 live rows)   the market has spoken, so a residual is measurable: market
//                            cap against the curve's implied value, flagged RICH (market
//                            above the model) / CHEAP (market below the model) / IN-LINE
//                            from the LOO residuals' P10-P90 quantiles. The residual is
//                            in-sample (full fit, not a leave-one-out refit) and is
//                            labelled that way. The 24 rows are the largest market caps,
//                            so they lean RICH by construction — selection, not a finding.
//   PRE-TOKEN (198 rows)    no price exists, so there is no mispricing to measure: only
//                            an implied value (hypothetical, if a token were issued) and
//                            a P25-P75 range from the LOO residuals. The main table never
//                            uses the word "deviation" for these rows.
//
// The model, fitted at build time on the snapshot's own traded protocols (comps) and
// recomputed here from the same constants, so the page and board.json are visibly the same
// arithmetic (the masthead badge counts the rows this page reproduces exactly):
//
//   comps            118 traded protocols (mcap > 0, TVL > 0; exchange tokens excluded,
//                    one record per ticker of the 128 that trade).
//   size curve       log10(mcap) = a + b * log10(TVL), OLS, fitted JOINTLY with the
//                    category premiums over 4 deterministic refit rounds (radar-4's change
//                    from radar-3's single pass; the constants ride in data.js).
//   category premium median log-residual per category, shrunk n/(n+12) toward 1
//                    (radar-3 used K=16; the ablation below shows both stages measured).
//   growth carry     (1 + clamp(change_7d, -50, +100)/100)^w, clamped to x0.8..x1.25.
//   launch odds      average of the age bucket's and the category's token share (category
//                    shrunk n/(n+20) toward the overall share), clamped to 5%..85%.
//   implied value    round(value-if-launch * launch odds).
//
// Validation is computed by lib/model.ts at build and rendered from data.js: leave-one-out
// refits, a walk-forward split by listed_at, repeated seeded 5-fold CV, the full ablation
// (flat -> size curve -> category -> growth = radar-3 -> K=12 -> joint fit = radar-4 ->
// seasoning/breadth/kinship retested), band coverage from the LOO residuals, and rank
// ranges from 200 seeded bootstrap refits.
//
// Honest limits: the comps are the protocols that made it to a token, so the fit overstates
// a pre-token protocol that never launches (survivorship bias); launch odds are the haircut
// for that, not a cure. R^2 is low (0.153: the model explains 15% of the variation in
// market cap) and the bands are wide because the residuals are. Implied value is an
// estimate under stated assumptions, never a prediction that a token is issued, or when.
// The farm scenario ($1,000 deposit, 10% slice shared pro-rata by TVL, gas and T-bill
// costs netted out) is a what-if the reader can move with the sliders, not a promise
// of an airdrop.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  /** Main-table rows shown before the "show all" toggle: the table is a screen, not a dump. */
  var TABLE_LIMIT = 55;
  var state = {
    q: '', category: 'all', chain: 'all', watchOnly: false, oddsMin: 0, tvlMin: 0, growth: 'all',
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null, showAll: false,
    deposit: DATA.farm_assumptions.deposit_usd, slice: DATA.farm_assumptions.slice_pct,
    compare: []
  };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var neg = n < 0;
    var a = Math.abs(n);
    var s;
    if (a >= 1e9) s = '$' + (a / 1e9).toFixed(2) + 'B';
    else if (a >= 1e6) s = '$' + (a / 1e6).toFixed(1) + 'M';
    else if (a >= 1e3) s = '$' + Math.round(a / 1e3) + 'K';
    else s = '$' + Math.round(a);
    return (neg ? '-' : '') + s;
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Age in days from the snapshot's own dates, as lib/model.ts computes it.
  function ageOf(row) {
    if (!row.listed_at) return null;
    var a = Date.parse(DATA.as_of + 'T00:00:00Z');
    var b = Date.parse(row.listed_at + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / 86400000));
  }

  // The radar-4 model, recomputed in the page from the snapshot figures and the constants
  // in data.js. The badge in the masthead counts how many rows this reproduces exactly.
  function growthFactor(change7d, w) {
    if (change7d === null || change7d === undefined) return 1;
    var pct = Math.min(100, Math.max(-50, change7d));
    var raw = Math.pow(1 + pct / 100, w);
    return Math.min(1.25, Math.max(0.8, raw));
  }
  function seasoningFactor(age, s) {
    var days = Math.max(0, age === null || age === undefined ? s.unknown_age_days : age);
    return s.floor + s.range * (1 - Math.exp(-days / s.tau));
  }
  function oddsOf(row, age) {
    var tables = DATA.odds;
    var ageShare = tables.overall_share;
    if (age !== null) {
      var bounds = [180, 365, 730, 1095, Infinity];
      for (var i = 0; i < bounds.length; i++) {
        if (age < bounds[i]) { ageShare = tables.by_age[i].share; break; }
      }
    }
    var cat = tables.by_category[row.category || 'Other'];
    var catShare = cat ? cat.share : tables.overall_share;
    return Math.min(0.85, Math.max(0.05, (ageShare + catShare) / 2));
  }
  function partsOf(row) {
    var t = DATA.terms;
    var age = ageOf(row);
    var size = Math.pow(10, DATA.fit.a + DATA.fit.b * Math.log10(Math.max(row.tvl_usd, 1)));
    var premium = DATA.premiums[row.category || 'Other'];
    var category = t.category ? (premium ? premium.premium : 1) : 1;
    var growth = t.growth ? growthFactor(row.change_7d, t.growth_w) : 1;
    var seasoning = t.seasoning ? seasoningFactor(age, t.seasoning_params) : 1;
    var breadth = t.breadth ? 1 + 0.03 * Math.min(Math.max((row.chains || []).length - 1, 0), 9) : 1;
    var kinship = t.kinship && row.kin ? 0.5 : 1;
    var value = size * category * growth * seasoning * breadth * kinship;
    var odds = oddsOf(row, age);
    return {
      age: age, size: size, category: category, growth: growth, seasoning: seasoning,
      breadth: breadth, kinship: kinship, value: value, odds: odds,
      implied: Math.max(1, Math.round(value * odds))
    };
  }

  // The farm scenario, recomputed for the what-if sliders with the page's deposit and
  // slice in place of the reference $1,000 / 10% (same arithmetic as lib/model.ts).
  function holdDays(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function farmOf(row, parts, deposit, slice) {
    var F = DATA.farm_assumptions;
    var weeks = Math.ceil(holdDays(parts.age) / 7);
    var chain = (row.chains && row.chains[0]) || '';
    var setup = Object.prototype.hasOwnProperty.call(DATA.setup_gas, chain) ? DATA.setup_gas[chain] : DATA.setup_gas_default;
    var weekly = F.weekly_gas_usd * weeks;
    var exit = setup;
    var opp = deposit * F.tbill_rate * (weeks / 52);
    var cost = setup + weekly + exit + opp;
    var share = row.tvl_usd > 0 ? parts.value * parts.odds * (slice / 100) * (deposit / row.tvl_usd) : 0;
    var net = share - cost;
    var hours = F.setup_hours + F.weekly_hours * weeks + F.claim_hours;
    var perHour = net / hours;
    var verdict = perHour >= F.farm_per_hour ? 'FARM' : perHour >= F.thin_per_hour ? 'THIN' : 'SKIP';
    var sharePerOdds = row.tvl_usd > 0 ? parts.value * (slice / 100) * (deposit / row.tvl_usd) : 0;
    var sharePerSlice = row.tvl_usd > 0 ? parts.value * parts.odds * (1 / 100) * (deposit / row.tvl_usd) : 0;
    return {
      weeks: weeks, share: share, setup: setup, weekly: weekly, exit: exit, opp: opp,
      cost: cost, net: net, hours: hours, perHour: perHour, verdict: verdict,
      breakevenOdds: sharePerOdds > 0 ? cost / sharePerOdds : null,
      breakevenSlice: sharePerSlice > 0 ? cost / sharePerSlice : null
    };
  }

  // Enrich every row once: recomputed parts + reference farm + what-if farm.
  DATA.rows.forEach(function (row) {
    row._parts = partsOf(row);
    row._farm = farmOf(row, row._parts, state.deposit, state.slice);
  });
  var selfCheckOk = DATA.rows.filter(function (r) { return r._parts.implied === r.implied_value_usd; }).length;

  function refreshFarms() {
    DATA.rows.forEach(function (row) { row._farm = farmOf(row, row._parts, state.deposit, state.slice); });
  }

  // The P25-P75 band's width as one global multiple (the band multipliers are constant
  // per row, so every row's band spans the same multiple of its own implied value).
  var bandWidthMult = DATA.bands.p75 / DATA.bands.p25;
  // The shared log scale for every range glyph on the page.
  var rangeLo = Math.min.apply(null, DATA.rows.map(function (r) { return Math.log10(r.band_p25_usd); }));
  var rangeHi = Math.max.apply(null, DATA.rows.map(function (r) { return Math.log10(r.band_p75_usd); }));
  function rangeBarHtml(loUsd, hiUsd) {
    var a = (Math.log10(loUsd) - rangeLo) / (rangeHi - rangeLo) * 100;
    var b = (Math.log10(hiUsd) - rangeLo) / (rangeHi - rangeLo) * 100;
    return '<div class="rangebar"><div class="fill" style="left:' + a.toFixed(1) + '%;width:' + Math.max(1, b - a).toFixed(1) + '%"></div></div>';
  }

  // Screening chips for the main table: plain descriptive flags, at most two per row,
  // priority SIZE, ODDS, GROWTH, SEASONING. They are not a score and never rank a row.
  function screeningChips(row) {
    var chips = [];
    if (row.tvl_usd >= 1e9) chips.push(['SIZE', 'TVL $1B or more']);
    if (row.launch_odds >= 0.5) chips.push(['ODDS', 'launch odds 50% or more']);
    if (row.change_7d !== null && row.change_7d >= 20) chips.push(['GROWTH', '7-day change +20% or more']);
    if (row.age_days !== null && row.age_days >= 730) chips.push(['SEASONING', 'tracked 2 years or more']);
    return chips.slice(0, 2).map(function (c) {
      return '<span class="chip" title="' + esc(c[1]) + '">' + c[0] + '</span>';
    }).join('');
  }

  // ---------------------------------------------------------------- scatter (SVG)
  function scatterSvg(highlightSlug, w, h) {
    var pts = DATA.comps_scatter;
    var xs = pts.map(function (p) { return Math.log10(p.tvl_usd); });
    var ys = pts.map(function (p) { return Math.log10(p.mcap_usd); });
    DATA.rows.slice(0, 15).forEach(function (r) { xs.push(Math.log10(r.tvl_usd)); ys.push(Math.log10(r.implied_value_usd)); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    var pad = 34;
    function X(v) { return pad + (v - x0) / (x1 - x0) * (w - pad - 30); }
    function Y(v) { return h - pad - (v - y0) / (y1 - y0) * (h - pad - 8); }
    var out = '<svg width="' + w + '" height="' + h + '" role="img" aria-label="Market cap versus TVL scatter with the fitted size curve">';
    for (var gx = x0; gx <= x1; gx++) {
      out += '<line x1="' + X(gx) + '" y1="' + (h - pad) + '" x2="' + X(gx) + '" y2="8" stroke="#232c3d"/>' +
        '<text x="' + X(gx) + '" y="' + (h - pad + 14) + '" text-anchor="middle">10^' + gx + '</text>';
    }
    for (var gy = y0; gy <= y1; gy++) {
      out += '<line x1="' + pad + '" y1="' + Y(gy) + '" x2="' + (w - 8) + '" y2="' + Y(gy) + '" stroke="#232c3d"/>' +
        '<text x="' + (pad - 4) + '" y="' + (Y(gy) + 3) + '" text-anchor="end">10^' + gy + '</text>';
    }
    out += '<line x1="' + X(x0) + '" y1="' + Y(DATA.fit.a + DATA.fit.b * x0) + '" x2="' + X(x1) + '" y2="' + Y(DATA.fit.a + DATA.fit.b * x1) + '" stroke="#2dd4bf" stroke-width="1.6"/>';
    pts.forEach(function (p) {
      out += '<circle cx="' + X(Math.log10(p.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(p.mcap_usd)).toFixed(1) + '" r="2.4" fill="#38bdf8" opacity="0.65"/>';
    });
    DATA.rows.slice(0, 15).forEach(function (r) {
      var hl = highlightSlug === r.slug;
      out += '<circle cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.implied_value_usd)).toFixed(1) + '" r="' + (hl ? 5 : 3.2) + '" fill="' + (hl ? '#fbbf24' : '#34d399') + '" stroke="#0d1117" stroke-width="0.8"/>';
    });
    out += '<text x="' + (w / 2) + '" y="' + (h - 4) + '" text-anchor="middle">TVL (USD, log10)</text>';
    out += '<text x="10" y="' + (h / 2) + '" text-anchor="middle" transform="rotate(-90 10 ' + (h / 2) + ')">market cap / implied (USD, log10)</text>';
    out += '</svg>';
    return out;
  }

  // ---------------------------------------------------------------- hero: the two panels
  function heroHtml() {
    var s = DATA.mispricing_summary;
    var n = DATA.live_size;
    var pct = function (c) { return (c / n * 100).toFixed(1); };
    // The live row closest to the median deviation, and the furthest-out row, named for real.
    var sorted = DATA.live.slice().sort(function (a, b) { return Math.abs(a.deviation_ratio - s.median_deviation_ratio) - Math.abs(b.deviation_ratio - s.median_deviation_ratio) || (a.slug < b.slug ? -1 : 1); });
    var medianRow = sorted[0];
    var extreme = DATA.live.slice().sort(function (a, b) {
      return Math.abs(Math.log10(b.deviation_ratio)) - Math.abs(Math.log10(a.deviation_ratio)) || (a.slug < b.slug ? -1 : 1);
    })[0];
    // The range ladder: the top 8 pre-token rows, bars only, no point marker, no numbers.
    var ladder = DATA.rows.slice(0, 8).map(function (r) {
      var lo = Math.log10(r.band_p25_usd), hi = Math.log10(r.band_p75_usd);
      var a = (lo - rangeLo) / (rangeHi - rangeLo) * 100, b = (hi - rangeLo) / (rangeHi - rangeLo) * 100;
      return '<div class="ladder-row"><span class="nm">' + esc(r.name) + '</span><div class="ladder-track"><div class="ladder-bar" style="left:' + a.toFixed(1) + '%;width:' + Math.max(1, b - a).toFixed(1) + '%"></div></div></div>';
    }).join('');
    return '<div class="hero">' +
      '<section class="panel"><h2>Already trading — measured residual</h2>' +
      '<div class="ribbon"><div class="seg-cheap" style="width:' + pct(s.cheap_count) + '%"></div><div class="seg-fair" style="width:' + pct(s.fair_count) + '%"></div><div class="seg-rich" style="width:' + pct(s.rich_count) + '%"></div></div>' +
      '<div class="ribbon-legend"><span class="cheap"><b>' + s.cheap_count + ' CHEAP</b> market below model</span><span class="fair"><b>' + s.fair_count + ' IN-LINE</b></span><span class="rich"><b>' + s.rich_count + ' RICH</b> market above model</span></div>' +
      '<p class="note">Median market cap sits x' + s.median_deviation_ratio.toFixed(1) + ' above the curve value. Example at the median: <b style="color:var(--ink)">' + esc(medianRow.name) + '</b>, market cap ' + fmtUsd(medianRow.mcap_usd) + ' against a curve value of ' + fmtUsd(medianRow.curve_implied_usd) + ' (x' + medianRow.deviation_ratio.toFixed(1) + '). Furthest out: <b style="color:var(--ink)">' + esc(extreme.name) + '</b> at x' + extreme.deviation_ratio.toFixed(1) + '.</p>' +
      '<p class="note">Read it honestly: these 24 are the largest market caps in the snapshot, so they lean RICH by construction — the panel is a screen of where the market already sits, not a sample of all traded tokens. Flags use the LOO residuals\u2019 P10\u2013P90 quantiles; each residual is in-sample (full fit).</p></section>' +
      '<section class="panel"><h2>Not yet trading — range only</h2>' + ladder +
      '<p class="note">P25\u2013P75 range of the top 8 pre-token protocols, bars only — no point estimate is drawn, because the range is the honest statement. Every row\u2019s band spans the same x' + bandWidthMult.toFixed(1) + ' multiple of its own implied value.</p>' +
      '<p class="note">A protocol with no price cannot be mispriced. What follows is a hypothetical value if a token were issued, with the range the held-out comps imply — not a price that is wrong.</p></section>' +
      '<section class="panel" style="grid-column:1/-1"><h2>Size curve — market cap vs TVL (log-log)</h2>' + scatterSvg(state.selected, 900, 300) +
      '<div class="legend">Scatter: <span class="dot" style="background:#38bdf8"></span>comps (traded) <span class="dot" style="background:#34d399"></span>top-15 pre-token at implied value <span class="dot" style="background:#2dd4bf"></span>size curve</div>' +
      '<p class="note">The curve the whole screen hangs on: log10(mcap) = ' + DATA.fit.a.toFixed(3) + ' + ' + DATA.fit.b.toFixed(3) + ' x log10(TVL), fitted on ' + DATA.comps_n + ' comps, R^2 ' + DATA.fit.r2.toFixed(3) + '. The scatter is wide around the line — that width is why every pre-token row carries a range, not a number.</p></section></div>';
  }

  function stripHtml() {
    return '<div class="strip"><span>Snapshot sealed as of <b>' + esc(DATA.as_of) + '</b></span><span class="sep">|</span>' +
      '<span><b>' + DATA.accounting.total + '</b> protocols</span><span class="sep">|</span>' +
      '<span>TVL floor <b>' + fmtUsd(DATA.floor_usd) + '</b> (in the snapshot, not a gate rule)</span><span class="sep">|</span>' +
      '<span>model <b>' + esc(DATA.model_version) + '</b> frozen</span><span class="sep">|</span>' +
      '<span class="notpred">Not a price forecast</span></div>';
  }

  function honestHtml() {
    return '<section class="honest"><h2>Honesty contract — what this screen does and does not do</h2><table>' +
      '<tr><td>What is measured</td><td>For protocols that already trade: the ratio of market cap to the curve\u2019s implied value — a measured residual, flagged RICH / CHEAP / IN-LINE. For pre-token protocols: only an implied value and a P25\u2013P75 range.</td></tr>' +
      '<tr><td>What is not measured</td><td>Any future token price. A pre-token protocol has no price, so it cannot be mispriced — the table shows a hypothetical value if a token were issued, never a price that is wrong.</td></tr>' +
      '<tr><td>Why the bands are wide</td><td>The model explains only 15% of the variation in market cap (R^2 ' + DATA.fit.r2.toFixed(3) + '); the median held-out miss is still x' + DATA.validation.loo.median_miss_x.toFixed(2) + ', so every P25\u2013P75 band spans x' + bandWidthMult.toFixed(1) + '.</td></tr>' +
      '</table></section>' +
      '<section class="newbox"><h2>New vs v3 — what actually changed</h2><ul>' +
      '<li><b>Residual panel for traded tokens</b> — RICH / CHEAP / IN-LINE flags with counts and named examples (new).</li>' +
      '<li><b>Two separate tracks</b> — traded and pre-token protocols are no longer read as one list (new).</li>' +
      '<li><b>Range glyphs + one global band legend</b> — the P25\u2013P75 interval is drawn as a bar, the x' + bandWidthMult.toFixed(1) + ' band width stated once (new).</li>' +
      '</ul><p class="note">Not new, and not claimed as new: the bootstrap rank-stability chip (best\u2013worst rank) already shipped in v3. The model, the board and the farm plans are unchanged from radar-4.</p></section>';
  }

  function acctHtml() {
    var a = DATA.accounting;
    var parts = ['<span><b>' + a.total + '</b> protocols in the sealed snapshot</span>',
      '<span class="sep">|</span><span><b>' + a.ranked + '</b> ranked pre-token (watchlist ' + DATA.watchlist_size + '/' + DATA.watchlist_size + ' covered)</span>',
      '<span class="sep">|</span><span><b>' + a.trading + '</b> already trading (comps + live view)</span>'];
    Object.keys(a.set_aside).sort().forEach(function (k) {
      parts.push('<span class="sep">|</span><span><b>' + a.set_aside[k] + '</b> set aside: ' + esc(k) + '</span>');
    });
    return '<div class="acct">' + parts.join('') + '</div>';
  }

  function modelHtml() {
    var v = DATA.validation;
    var t = DATA.terms;
    var formula = 'implied = 10^(' + DATA.fit.a.toFixed(3) + ' + ' + DATA.fit.b.toFixed(3) + ' * log10 TVL) x category(K=' + t.category_k + ', ' + t.fit_rounds + '-round joint fit) x growth(w=' + t.growth_w + ') x launch odds';
    var abl = v.ablation.map(function (s) {
      return '<tr><td>' + esc(s.stage) + '</td><td>x' + s.median_miss_x.toFixed(2) + '</td><td>' + s.within_3x_pct.toFixed(1) + '%</td><td>' + s.mae_log10.toFixed(3) + '</td><td>' + s.spearman.toFixed(3) + '</td><td class="' + (s.kept ? 'kept' : 'dropped') + '">' + (s.kept ? 'kept' : 'dropped') + '</td></tr>';
    }).join('');
    function valRow(name, m) {
      return '<tr><td>' + name + '</td><td>x' + m.median_miss_x.toFixed(2) + '</td><td>' + m.within_3x_pct.toFixed(1) + '%</td><td>' + m.mae_log10.toFixed(3) + '</td><td>' + m.spearman.toFixed(3) + '</td><td>' + m.n + '</td></tr>';
    }
    return '<div class="grid2"><div class="card"><h2>Model ' + esc(DATA.model_version) + ' — fitted on ' + DATA.comps_n + ' traded comps, R^2 ' + DATA.fit.r2.toFixed(3) + '</h2>' +
      '<div class="formula">' + esc(formula) + '</div>' +
      '<table class="mini"><tr><th>Ablation (LOO refits)</th><th>median miss</th><th>within x3</th><th>MAE log</th><th>Spearman</th><th></th></tr>' + abl + '</table>' +
      '<div class="note">Every term had to earn its place on held-out comps. Radar-3 (submission #2) stopped at the growth stage; radar-4 adds the K=12 shrink and the 4-round joint fit, each kept only because the held-out median miss improved.</div></div>' +
      '<div class="card"><h2>Held-out validation</h2>' +
      '<table class="mini"><tr><th>Method</th><th>median miss</th><th>within x3</th><th>MAE log</th><th>Spearman</th><th>n</th></tr>' +
      valRow('Leave-one-out', v.loo) + valRow('Walk-forward (oldest ' + v.walk_forward.train_n + ' train)', v.walk_forward) + valRow('5-fold CV x' + v.kfold.repeats + ' repeats', v.kfold) + '</table>' +
      '<div class="note">Bands are the LOO residuals\u2019 empirical quantiles; rank ranges come from 200 seeded bootstrap refits. The comps are the protocols that made it to a token, so the fit overstates a pre-token protocol that never launches (survivorship bias); launch odds are the haircut, not a cure.</div></div></div>';
  }

  // ------------------------------------------------------------ method & validation
  // Limits first, then what the numbers are — the order the reframe demands.
  function methodHtml() {
    var v = DATA.validation;
    var t = DATA.terms;
    var fit = DATA.fit;
    var curve = 'log10(mcap) = ' + fit.a.toFixed(3) + ' + ' + fit.b.toFixed(3) + ' * log10(TVL)';
    var rows = [
      ['Size curve (joint OLS fit on ' + DATA.comps_n + ' traded comps)', curve + ', R^2 ' + fit.r2.toFixed(3)],
      ['Category premium', 'median log-residual per category, shrunk n/(n+K) toward 1 with K=' + t.category_k],
      ['Joint fit', t.fit_rounds + ' deterministic refit rounds alternating curve and premiums (radar-3 used a single pass)'],
      ['Leave-one-out median miss', 'x' + v.loo.median_miss_x.toFixed(2) + ' (flat baseline x' + v.flat_median_miss_x.toFixed(2) + '), ' + v.loo.within_3x_pct.toFixed(0) + '% within x3'],
      ['Walk-forward median miss', 'x' + v.walk_forward.median_miss_x.toFixed(2) + ' (oldest ' + v.walk_forward.train_n + ' comps train, newest held out)'],
      ['5-fold CV median miss', 'x' + v.kfold.median_miss_x.toFixed(2) + ' over ' + v.kfold.repeats + ' seeded repeats'],
      ['Uncertainty bands', 'empirical P10-P90 / P25-P75 quantiles of the leave-one-out residuals'],
      ['Rank ranges', '200 seeded bootstrap refits of the whole joint fit']
    ];
    var body = rows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('');
    return '<section class="method"><h2>Method &amp; validation</h2>' +
      '<div class="note method-limits" style="margin-top:0;border-top:0;padding-top:0"><b>Honest limits, first.</b> R^2 ' + fit.r2.toFixed(3) + ' is low: TVL alone explains only a ' +
      'small share of why traded tokens are worth what they are, so the median held-out miss is still about x' +
      v.loo.median_miss_x.toFixed(2) + ' and only ' + v.loo.within_3x_pct.toFixed(0) + '% of comps land within x3 of their ' +
      'actual cap. K=' + t.category_k + ' and the ' + t.fit_rounds + '-round joint fit were <em>selected</em> because they improved ' +
      'held-out error on these same comps, so some overfitting to this snapshot is possible even though every ' +
      'reported error is measured on protocols the fit never saw. The comps are protocols that already launched a ' +
      'token (survivorship bias); launch odds are a haircut for that, not a cure. Read implied values as order-of-' +
      'magnitude estimates under stated assumptions, never as price predictions.</div>' +
      '<div class="cannotclaim"><b>What cannot be claimed.</b><ul>' +
      '<li>No pre-token row is "mispriced" or "cheap" or "expensive" — there is no price to compare against.</li>' +
      '<li>No implied value is a future token price, a target, or an expected return.</li>' +
      '<li>No live flag is a trading signal: the residual is in-sample, the 24 rows are picked by market cap, and the flag thresholds are descriptive quantiles, not a tested strategy.</li>' +
      '<li>The reframe changes how the same numbers are read; it does not improve the model, and no effect size for it has been measured.</li>' +
      '</ul></div>' +
      '<p class="method-lead" style="margin-top:10px">Every value on this board comes from one fitted size curve, ' +
      esc(curve) + ' (R^2 ' + fit.r2.toFixed(3) + '), fitted <em>jointly</em> with per-category premiums over ' +
      t.fit_rounds + ' deterministic refit rounds: each round refits the curve on premium-adjusted caps, ' +
      'then recomputes each category\u2019s median log-residual, shrunk toward 1 by n/(n+K) with K=' + t.category_k +
      ' so thin categories cannot swing the board. Growth carry and launch odds then scale the curve value, ' +
      'exactly as the decomposition in each row\u2019s detail view shows.</p>' +
      '<table class="mini method-table"><tr><th>Component</th><th>What was done</th></tr>' + body + '</table></section>';
  }

  function controlsHtml(cats, chains) {
    function opts(list, cur) {
      return list.map(function (c) { return '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    }
    function optNum(v, label) {
      return '<option value="' + v + '"' + (state.oddsMin === v ? ' selected' : '') + '>' + label + '</option>';
    }
    return '<div class="controls">' +
      '<div class="tabs"><button data-tab="pre-token" class="' + (state.tab === 'pre-token' ? 'on' : '') + '">Pre-token board (' + DATA.board_size + ')</button>' +
      '<button data-tab="live" class="' + (state.tab === 'live' ? 'on' : '') + '">Already trading — measured residual (' + DATA.live_size + ')</button></div>' +
      '<label>Search <input type="search" id="q" value="' + esc(state.q) + '" placeholder="name or slug"></label>' +
      '<label>Category <select id="fcat"><option value="all">all</option>' + opts(cats, state.category) + '</select></label>' +
      '<label>Chain <select id="fchain"><option value="all">all</option>' + opts(chains, state.chain) + '</select></label>' +
      '<label>Launch odds <select id="fodds">' + optNum(0, 'any') + optNum(0.3, '30%+') + optNum(0.5, '50%+') + '</select></label>' +
      '<label>TVL <select id="ftvl"><option value="0"' + (state.tvlMin === 0 ? ' selected' : '') + '>any</option><option value="100000000"' + (state.tvlMin === 100000000 ? ' selected' : '') + '>$100M+</option><option value="500000000"' + (state.tvlMin === 500000000 ? ' selected' : '') + '>$500M+</option><option value="1000000000"' + (state.tvlMin === 1000000000 ? ' selected' : '') + '>$1B+</option></select></label>' +
      '<label>Growth <select id="fgrowth"><option value="all">all</option>' + opts(['down', 'flat', 'up', 'strong'], state.growth) + '</select></label>' +
      '<label><input type="checkbox" id="fwatch"' + (state.watchOnly ? ' checked' : '') + '> watchlist only</label>' +
      '<label>Deposit <input type="range" id="dep" min="250" max="25000" step="250" value="' + state.deposit + '"><span class="slider-val" id="depv">' + money(state.deposit) + '</span></label>' +
      '<label>Airdrop slice <input type="range" id="sli" min="1" max="30" step="1" value="' + state.slice + '"><span class="slider-val" id="sliv">' + state.slice + '%</span></label>' +
      '<button class="btn" id="expCsv">Export CSV</button><button class="btn" id="expJson">Export JSON</button>' +
      '<span class="count" id="count"></span></div>';
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.launch_odds < state.oddsMin) return false;
      if (r.tvl_usd < state.tvlMin) return false;
      if (state.growth !== 'all' && r.growth_tier !== state.growth) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function sortedRows(rows) {
    var key = state.sort, dir = state.dir;
    function val(r) {
      if (key === 'implied') return r.implied_value_usd;
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -1e9 : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      if (key === 'odds') return r.launch_odds;
      if (key === 'name') return r.name;
      return r.rank;
    }
    return rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (typeof va === 'string') return dir * (va < vb ? -1 : va > vb ? 1 : 0);
      return dir * (va - vb) || a.rank - b.rank;
    });
  }

  function boardHtml(rows) {
    function th(key, label, cls) {
      var arrow = state.sort === key ? (state.dir < 0 ? ' \u25bc' : ' \u25b2') : '';
      return '<th class="' + (cls || '') + '" data-sort="' + key + '">' + label + arrow + '</th>';
    }
    var shown = state.showAll ? rows : rows.slice(0, TABLE_LIMIT);
    var head = '<tr>' + th('rank', '#') + th('name', 'Protocol', 'l') + th('tvl', 'TVL') +
      th('implied', 'Implied value') + '<th>Range P25\u2013P75</th><th>Band width</th>' + th('odds', 'Launch odds') + '<th class="l">Screening</th><th>Rank stability</th><th>Status</th><th>Cmp</th></tr>';
    var body = shown.map(function (r) {
      var inCmp = state.compare.indexOf(r.slug) >= 0;
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="l"><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? ' <span class="wl">WATCHLIST</span>' : '') + '<span class="band">' + esc(r.category || 'Other') + ' \u00b7 ' + esc((r.chains || []).slice(0, 2).join(', ') || 'n/a') + '</span></td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td>' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td>' + rangeBarHtml(r.band_p25_usd, r.band_p75_usd) + '</td>' +
        '<td>x' + bandWidthMult.toFixed(1) + '</td>' +
        '<td>' + Math.round(r.launch_odds * 100) + '%</td>' +
        '<td class="l">' + screeningChips(r) + '</td>' +
        '<td>' + r.rank_best + '\u2013' + r.rank_worst + '</td>' +
        '<td><span class="pill PRETOKEN">PRA-TOKEN</span></td>' +
        '<td><input type="checkbox" data-cmp="' + esc(r.slug) + '"' + (inCmp ? ' checked' : '') + ' aria-label="compare ' + esc(r.name) + '"></td></tr>';
    }).join('');
    var more = rows.length > TABLE_LIMIT ? '<p class="note"><button class="btn" id="showAll">' + (state.showAll ? 'Show first ' + TABLE_LIMIT : 'Show all ' + rows.length + ' rows') + '</button> Showing ' + shown.length + ' of ' + rows.length + ' matching rows (of ' + DATA.rows.length + ' ranked).</p>' : '';
    return '<p class="note" style="margin:0 0 6px"><b style="color:var(--ink)">Hypothetical value if a token were issued — not a price that is wrong.</b> Each row\u2019s bar is its P25\u2013P75 range on one shared log scale; the band width (x' + bandWidthMult.toFixed(1) + ') is the same for every row. Screening chips (max 2): SIZE = TVL $1B+, ODDS = launch odds 50%+, GROWTH = 7d +20%+, SEASONING = tracked 2y+. Rank stability is the best\u2013worst rank over 200 bootstrap refits.</p>' +
      '<table class="board"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' + more;
  }

  function liveHtml() {
    // Ordered by how far the market sits from the curve, either direction.
    var rows = DATA.live.slice().sort(function (a, b) {
      return Math.abs(Math.log10(b.deviation_ratio)) - Math.abs(Math.log10(a.deviation_ratio)) || (a.slug < b.slug ? -1 : 1);
    });
    var body = rows.map(function (r, i) {
      var flag = r.mispricing_flag === 'rich' ? '<span class="pill RICH">RICH — market above model</span>'
        : r.mispricing_flag === 'cheap' ? '<span class="pill CHEAP">CHEAP — market below model</span>'
        : '<span class="pill INLINE">IN-LINE</span>';
      return '<tr><td class="rank">' + (i + 1) + '</td><td class="l"><span class="pname">' + esc(r.name) + '</span><span class="band">' + esc(r.category || 'Other') + ' \u00b7 ' + esc((r.chains || []).slice(0, 2).join(', ') || 'n/a') + '</span></td><td>' + fmtUsd(r.tvl_usd) + '</td><td>' + fmtUsd(r.mcap_usd) + '</td><td>' + fmtUsd(r.curve_implied_usd) + '</td><td>x' + r.deviation_ratio.toFixed(1) + '</td><td class="l">' + flag + '</td><td class="l">residual in-sample' + (r.is_comp ? ' \u00b7 comp' : ' \u00b7 not a comp') + '</td></tr>';
    }).join('');
    return '<div class="note" style="margin:0 0 8px">Already trading: the market\u2019s own value against the curve\u2019s implied value — the only place on this screen where a residual is measured. Ordered by distance from the curve, either direction. The residual is in-sample (the curve value comes from the full fit on all 118 comps, not a leave-one-out refit); the flag thresholds are the LOO residuals\u2019 P10\u2013P90 quantiles (market below x' + DATA.bands.p10.toFixed(2) + ' or above x' + DATA.bands.p90.toFixed(1) + ' of the curve value). These 24 are the largest market caps, so they lean RICH by construction.</div>' +
      '<table class="board"><thead><tr><th>#</th><th class="l">Protocol</th><th>TVL</th><th>Market cap</th><th>Implied (curve)</th><th>Ratio</th><th class="l">Flag</th><th class="l">Note</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function detailHtml(row) {
    var p = row._parts;
    var f = row._farm;
    var prem = DATA.premiums[row.category || 'Other'];
    var decomp =
      'size curve      10^(' + DATA.fit.a.toFixed(3) + ' + ' + DATA.fit.b.toFixed(3) + ' x log10 ' + fmtUsd(row.tvl_usd) + ') = ' + money(p.size) + '\n' +
      'x category      ' + (row.category || 'Other') + ' premium x' + p.category.toFixed(3) + (prem ? ' (n=' + prem.n + ' comps, median residual ' + (prem.median_residual >= 0 ? '+' : '') + prem.median_residual.toFixed(3) + ' log10)' : ' (no comps: x1.000)') + '\n' +
      'x growth        7d ' + (row.change_7d === null ? 'n/a' : fmtPct(row.change_7d)) + ' -> x' + p.growth.toFixed(3) + '\n' +
      (DATA.terms.seasoning ? 'x seasoning     age ' + fmtAge(p.age) + ' -> x' + p.seasoning.toFixed(3) + '\n' : '') +
      (DATA.terms.breadth ? 'x chain breadth ' + (row.chains || []).length + ' chains -> x' + p.breadth.toFixed(3) + '\n' : '') +
      (DATA.terms.kinship ? 'x kinship       ' + (row.kin ? 'sibling token trades -> x0.500' : 'no sibling token -> x1.000') + '\n' : '') +
      '= value if launch ' + money(p.value) + '\n' +
      'x launch odds   ' + (p.odds * 100).toFixed(1) + '% (age bucket + category token share)\n' +
      '= implied value   ' + money(p.implied) + '  (board: ' + money(row.implied_value_usd) + ')';
    var steps = (row.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    return '<section class="detail" id="detail"><h2>#' + row.rank + ' ' + esc(row.name) + ' <span class="pill ' + f.verdict + '">' + f.verdict + '</span> <span class="pill PRETOKEN">PRA-TOKEN</span></h2>' +
      '<div class="note" style="margin:0">' + esc(row.category || 'Other') + ' \u00b7 TVL ' + fmtUsd(row.tvl_usd) + ' \u00b7 7d ' + (row.change_7d === null ? 'n/a' : fmtPct(row.change_7d)) + ' \u00b7 age ' + fmtAge(p.age) + ' \u00b7 chains: ' + esc((row.chains || []).join(', ') || 'n/a') + (row.watchlist ? ' \u00b7 <span class="wl">WATCHLIST</span>' : '') + '</div>' +
      '<div class="dgrid"><div><h3>Components of the implied value</h3><div class="decomp">' + esc(decomp) + '</div>' +
      '<h3>What is not claimed</h3><div class="note" style="margin-top:0">This implied value is hypothetical: what the protocol would be worth <em>if</em> it issued a token, under the curve, the category premium, the growth carry and the launch odds above. It is not a future price, not a target, and not an expected return — and this protocol has no price to be wrong about. The P25\u2013P75 range (x' + bandWidthMult.toFixed(1) + ' wide) is the honest statement; the single number is its middle, not a forecast.</div>' +
      '<h3>Uncertainty</h3><table class="mini">' +
      '<tr><td>P10 \u2013 P90 band</td><td>' + fmtUsd(row.band_p10_usd) + ' \u2013 ' + fmtUsd(row.band_p90_usd) + '</td></tr>' +
      '<tr><td>P25 \u2013 P75 band</td><td>' + fmtUsd(row.band_p25_usd) + ' \u2013 ' + fmtUsd(row.band_p75_usd) + '</td></tr>' +
      '<tr><td>Rank range (200 bootstrap refits)</td><td>' + row.rank_best + ' \u2013 ' + row.rank_worst + '</td></tr>' +
      '<tr><td>Value if launch (before odds)</td><td>' + fmtUsd(row.value_if_launch_usd) + '</td></tr></table>' +
      '<h3>Position on the comps scatter</h3>' + scatterSvg(row.slug, 520, 280) + '</div>' +
      '<div><h3>Farm plan, netted (' + money(state.deposit) + ' deposit, ' + state.slice + '% slice)</h3>' +
      '<table class="mini">' +
      '<tr><td>Scenario airdrop share (pro-rata by TVL)</td><td>' + money(f.share) + '</td></tr>' +
      '<tr><td>Setup gas (' + esc((row.chains && row.chains[0]) || 'default') + ')</td><td>-' + money(f.setup) + '</td></tr>' +
      '<tr><td>Weekly gas x' + f.weeks + ' weeks</td><td>-' + money(f.weekly) + '</td></tr>' +
      '<tr><td>Exit gas</td><td>-' + money(f.exit) + '</td></tr>' +
      '<tr><td>Opportunity cost (T-bill ' + (DATA.farm_assumptions.tbill_rate * 100).toFixed(0) + '%)</td><td>-' + money(f.opp) + '</td></tr>' +
      '<tr><td><b>Net</b></td><td><b>' + money(f.net) + '</b></td></tr>' +
      '<tr><td>Hands-on hours</td><td>' + f.hours.toFixed(2) + ' h</td></tr>' +
      '<tr><td><b>Net per hour</b></td><td><b>' + money(f.perHour) + '/h</b></td></tr>' +
      '<tr><td>Break-even launch odds</td><td>' + (f.breakevenOdds === null ? 'n/a' : (f.breakevenOdds * 100).toFixed(1) + '%') + '</td></tr>' +
      '<tr><td>Break-even airdrop slice</td><td>' + (f.breakevenSlice === null ? 'n/a' : f.breakevenSlice.toFixed(2) + '%') + '</td></tr></table>' +
      '<div class="note">Verdict thresholds: FARM at $' + DATA.farm_assumptions.farm_per_hour + '/h or more, THIN from $' + DATA.farm_assumptions.thin_per_hour + '/h. Move the deposit/slice sliders above and this table recomputes live. The scenario is a what-if, never a promise of an airdrop.</div>' +
      '<h3>Farm steps (as written in board.json, reference $1,000 / 10%)</h3><ol class="steps">' + steps + '</ol></div></div></section>';
  }

  function compareHtml() {
    if (state.compare.length === 0) return '';
    var rows = state.compare.map(function (slug) {
      return DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    }).filter(Boolean);
    if (rows.length === 0) return '';
    function line(label, fn) {
      return '<tr><td>' + label + '</td>' + rows.map(function (r) { return '<td>' + fn(r) + '</td>'; }).join('') + '</tr>';
    }
    return '<section class="compare"><h2>Compare (' + rows.length + ' of max 3)</h2><table class="mini">' +
      '<tr><th></th>' + rows.map(function (r) { return '<th>#' + r.rank + ' ' + esc(r.name) + '</th>'; }).join('') + '</tr>' +
      line('Implied value', function (r) { return fmtUsd(r.implied_value_usd); }) +
      line('P25-P75 band', function (r) { return fmtUsd(r.band_p25_usd) + ' \u2013 ' + fmtUsd(r.band_p75_usd); }) +
      line('Rank range', function (r) { return r.rank_best + ' \u2013 ' + r.rank_worst; }) +
      line('TVL', function (r) { return fmtUsd(r.tvl_usd); }) +
      line('Launch odds', function (r) { return Math.round(r.launch_odds * 100) + '%'; }) +
      line('Net @ deposit', function (r) { return fmtUsd(r._farm.net); }) +
      line('$/hour', function (r) { return fmtUsd(r._farm.perHour); }) +
      line('Verdict', function (r) { return '<span class="pill ' + r._farm.verdict + '">' + r._farm.verdict + '</span>'; }) +
      '</table></section>';
  }

  function watchlistHtml() {
    var rows = DATA.rows.filter(function (r) { return r.watchlist; });
    var body = rows.map(function (r) {
      return '<div class="wl-row">#' + r.rank + ' <b>' + esc(r.name) + '</b> — implied ' + fmtUsd(r.implied_value_usd) + ' \u00b7 ' + esc(r.category || 'Other') + '</div>';
    }).join('');
    return '<section class="watchlist"><h2 style="font-size:14px;color:var(--acc);text-transform:uppercase;letter-spacing:.6px;margin:0 0 6px">Watchlist (' + rows.length + ' of ' + DATA.watchlist_size + ')</h2>' + body + '</section>';
  }

  function render() {
    var cats = [];
    var chains = [];
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Other';
      if (cats.indexOf(c) < 0) cats.push(c);
      (r.chains || []).forEach(function (ch) { if (chains.indexOf(ch) < 0) chains.push(ch); });
    });
    cats.sort(); chains.sort();
    var rows = state.tab === 'pre-token' ? sortedRows(filteredRows()) : [];
    var sel = state.selected ? DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    var badgeOk = selfCheckOk === DATA.rows.length;
    var v = DATA.validation;
    app.innerHTML =
      '<header class="masthead"><h1>Token Launch Radar — Mispricing Screen <span class="sub">Traded tokens measured against the curve; pre-token protocols shown as a hypothetical value with a range, never as a price that is wrong. Model ' + esc(DATA.model_version) + ': 4-round joint fit, LOO + walk-forward + 5-fold tested. Snapshot as of ' + esc(DATA.as_of) + ' \u00b7 source: ' + esc(DATA.source) + ' \u00b7 TVL floor ' + fmtUsd(DATA.floor_usd) + '.</span></h1>' +
      '<span class="badge' + (badgeOk ? '' : ' bad') + '" title="This page recomputes the model from the raw snapshot figures in data.js and compares every row with board.json">page = board.json ' + (badgeOk ? '\u2713 ' : '\u2717 ') + selfCheckOk + '/' + DATA.rows.length + '</span></header>' +
      (state.focus && sel ? detailHtml(sel) : '') +
      '<p class="thesis">This dashboard does not answer what token X will be worth. It separates the protocols that already have a price and sit away from it, from the ones that have no price at all — <b>for the second group there is only a range, never a number to be wrong about.</b></p>' +
      stripHtml() + heroHtml() + honestHtml() +
      modelHtml() + methodHtml() + controlsHtml(cats, chains) +
      (!state.focus && sel ? detailHtml(sel) : '') + compareHtml() +
      (state.tab === 'pre-token' ? boardHtml(rows) + watchlistHtml() : liveHtml()) +
      '<footer class="foot">Model ' + esc(DATA.model_version) + ' \u00b7 fit on ' + DATA.comps_n + ' comps, R^2 ' + DATA.fit.r2.toFixed(3) + ' \u00b7 LOO median miss x' + v.loo.median_miss_x.toFixed(2) + ' \u00b7 walk-forward x' + v.walk_forward.median_miss_x.toFixed(2) + ' \u00b7 5-fold x' + v.kfold.median_miss_x.toFixed(2) + ' \u00b7 bands hold P25\u2013P75 ' + v.band_coverage.p25_p75_pct.toFixed(0) + '% / P10\u2013P90 ' + v.band_coverage.p10_p90_pct.toFixed(0) + '% \u00b7 ' + DATA.worth_farming + ' rows worth farming at the reference scenario, best ' + fmtUsd(DATA.best_per_hour_usd) + '/h.</footer>' +
      acctHtml() +
      '<footer class="foot">Implied value is an estimate under the stated assumptions, never a prediction that a token is issued or when. Farm economics are a scenario (deposit, slice, gas and T-bill costs as shown), not a promise of an airdrop; always claim only from links the protocol itself publishes. Model ' + esc(DATA.model_version) + ' \u00b7 deterministic build from the sealed snapshot \u00b7 no network calls from this page.</footer>';
    app.setAttribute('aria-busy', 'false');
    var count = document.getElementById('count');
    if (count) count.textContent = state.tab === 'pre-token' ? (state.showAll ? rows.length : Math.min(TABLE_LIMIT, rows.length)) + ' of ' + rows.length + ' matching rows shown' : DATA.live.length + ' live tokens shown';
    bind();
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function bind() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; var pos = q.selectionStart; render(); var nq = document.getElementById('q'); if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); } });
    var fc = document.getElementById('fcat');
    if (fc) fc.addEventListener('change', function () { state.category = fc.value; render(); });
    var fh = document.getElementById('fchain');
    if (fh) fh.addEventListener('change', function () { state.chain = fh.value; render(); });
    var fo = document.getElementById('fodds');
    if (fo) fo.addEventListener('change', function () { state.oddsMin = Number(fo.value); render(); });
    var ft = document.getElementById('ftvl');
    if (ft) ft.addEventListener('change', function () { state.tvlMin = Number(ft.value); render(); });
    var fg = document.getElementById('fgrowth');
    if (fg) fg.addEventListener('change', function () { state.growth = fg.value; render(); });
    var fw = document.getElementById('fwatch');
    if (fw) fw.addEventListener('change', function () { state.watchOnly = fw.checked; render(); });
    var dep = document.getElementById('dep');
    if (dep) dep.addEventListener('input', function () { state.deposit = Number(dep.value); refreshFarms(); render(); });
    var sli = document.getElementById('sli');
    if (sli) sli.addEventListener('input', function () { state.slice = Number(sli.value); refreshFarms(); render(); });
    var sa = document.getElementById('showAll');
    if (sa) sa.addEventListener('click', function () { state.showAll = !state.showAll; render(); });
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); render(); });
    });
    app.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'rank' ? 1 : -1; }
        render();
      });
    });
    app.querySelectorAll('tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function (ev) {
        if (ev.target && ev.target.hasAttribute('data-cmp')) return;
        var slug = tr.getAttribute('data-slug');
        state.selected = state.selected === slug ? null : slug;
        render();
        var d = document.getElementById('detail');
        if (d) d.scrollIntoView({ block: 'start' });
      });
    });
    app.querySelectorAll('[data-cmp]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var slug = cb.getAttribute('data-cmp');
        var at = state.compare.indexOf(slug);
        if (cb.checked && at < 0) {
          if (state.compare.length >= 3) { cb.checked = false; return; }
          state.compare.push(slug);
        } else if (!cb.checked && at >= 0) state.compare.splice(at, 1);
        render();
      });
    });
    var ec = document.getElementById('expCsv');
    if (ec) ec.addEventListener('click', function () {
      var head = 'rank,slug,name,category,tvl_usd,change_7d,age_days,implied_value_usd,band_p25_usd,band_p75_usd,launch_odds,rank_best,rank_worst,growth_tier,net_usd,per_hour_usd,verdict\n';
      var body = sortedRows(filteredRows()).map(function (r) {
        return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || 'Other') + '"', r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.implied_value_usd, r.band_p25_usd, r.band_p75_usd, r.launch_odds, r.rank_best, r.rank_worst, r.growth_tier, r._farm.net.toFixed(2), r._farm.perHour.toFixed(2), r._farm.verdict].join(',');
      }).join('\n');
      download('launch-radar-board.csv', head + body + '\n', 'text/csv');
    });
    var ej = document.getElementById('expJson');
    if (ej) ej.addEventListener('click', function () {
      download('launch-radar-board.json', JSON.stringify(sortedRows(filteredRows()).map(function (r) {
        return { rank: r.rank, slug: r.slug, name: r.name, category: r.category, tvl_usd: r.tvl_usd, implied_value_usd: r.implied_value_usd, launch_odds: r.launch_odds, growth_tier: r.growth_tier, verdict: r._farm.verdict };
      }), null, 2), 'application/json');
    });
  }

  // Hash state for screenshots and deep links: #p=<slug>, #category=X&deposit=N&slice=N.
  function applyHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv.slice(1).join('=') || '');
      if (k === 'p') state.selected = v;
      else if (k === 'category') state.category = v;
      else if (k === 'chain') state.chain = v;
      else if (k === 'tab') state.tab = v;
      else if (k === 'growth') state.growth = v;
      else if (k === 'deposit' && isFinite(Number(v))) state.deposit = Number(v);
      else if (k === 'slice' && isFinite(Number(v))) state.slice = Number(v);
      else if (k === 'focus') state.focus = v === '1';
    });
    refreshFarms();
  }

  applyHash();
  render();
})();
