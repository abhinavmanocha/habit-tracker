/* ============================================================
   Habit Tracker — month grid, weekly progress, charts.
   Data lives in localStorage; export/import JSON for backup.
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'habit-tracker-v2';
  var SYNC_URL = 'garmin-sleep.json';
  var SYNC_API = 'https://habit-tracker-sync.abhinavmanocha.workers.dev';
  var SYNC_KEY_STORAGE = 'ht-sync-key';
  var SYNC_LAST_STORAGE = 'ht-last-sync';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var SVGNS = 'http://www.w3.org/2000/svg';
  var STARTERS = [
    'Wake up at 9:00', 'Sleep 7 hours', '3L water', 'Exercise 45 min',
    'Read 20 pages', 'No screens before bed', 'Journal'
  ];

  var habits = [];
  var tombstones = [];          // [{ id, updatedAt }] so deletes survive a merge
  var view = { y: 0, m: 0 };
  var editingId = null;
  var saveTimer = null;
  var pushTimer = null;
  var syncing = false;
  var rowRefs = {};

  /* ---------------- small helpers ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function K(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function mKey(y, m) { return y + '-' + pad2(m + 1); }
  function weekOf(d) { return Math.floor((d - 1) / 7) + 1; }
  function wkCls(w) { return 'w' + (((w - 1) % 2) + 1); }   // amber / blue alternating
  function isToday(y, m, d) {
    var t = new Date();
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
  }
  function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  /* ---------------- storage ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.habits)) return;
      habits = data.habits.map(function (h) {
        return {
          id: String(h.id || uid()),
          name: String(h.name || 'Habit'),
          goals: (h.goals && typeof h.goals === 'object') ? h.goals : {},
          log: (h.log && typeof h.log === 'object') ? h.log : {},
          source: h.source === 'garmin-sleep' ? 'garmin-sleep' : null,
          updatedAt: Number(h.updatedAt) || 0
        };
      });
      tombstones = Array.isArray(data.deleted)
        ? data.deleted.map(function (t) {
            return { id: String(t.id), updatedAt: Number(t.updatedAt) || 0 };
          })
        : [];
    } catch (e) {
      console.warn('Could not read saved habits', e);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc()));
      noteSaved();
      schedulePush();
    } catch (e) {
      toast('Could not save — browser storage may be full');
    }
  }

  // The whole synced document. Tombstones ride along so deletes propagate.
  function doc() {
    return { version: 3, habits: habits, deleted: tombstones };
  }

  function noteSaved() {
    var badge = document.getElementById('saveState');
    if (!badge) return;
    badge.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { badge.textContent = 'All changes saved'; }, 450);
  }

  /* ---------------- maths ---------------- */
  function goalFor(h, y, m) {
    var g = h.goals[mKey(y, m)];
    if (typeof g === 'number' && isFinite(g)) {
      return Math.max(0, Math.min(daysInMonth(y, m), Math.round(g)));
    }
    return daysInMonth(y, m);
  }
  function doneInMonth(h, y, m) {
    var n = 0, dim = daysInMonth(y, m);
    for (var d = 1; d <= dim; d++) { if (h.log[K(y, m, d)]) n++; }
    return n;
  }
  function completedOn(y, m, d) {
    var k = K(y, m, d), n = 0;
    for (var i = 0; i < habits.length; i++) { if (habits[i].log[k]) n++; }
    return n;
  }
  // Days of the viewed month that have actually happened (0 for future months).
  function elapsedDays() {
    var t = new Date();
    if (view.y === t.getFullYear() && view.m === t.getMonth()) return t.getDate();
    if (view.y > t.getFullYear() || (view.y === t.getFullYear() && view.m > t.getMonth())) return 0;
    return daysInMonth(view.y, view.m);
  }
  function weeksOfMonth(dim) {
    var out = [];
    for (var w = 1; w <= 5; w++) {
      var s = (w - 1) * 7 + 1, e = Math.min(w * 7, dim);
      if (s > dim) break;
      out.push({ w: w, s: s, e: e });
    }
    return out;
  }

  /* ---------------- charts ---------------- */
  function renderCharts() {
    var dim = daysInMonth(view.y, view.m), upto = elapsedDays(), series = [];
    for (var d = 1; d <= dim; d++) {
      var c = completedOn(view.y, view.m, d);
      series.push({
        d: d, c: c, counted: d <= upto,
        pct: habits.length ? (c / habits.length) * 100 : 0
      });
    }
    drawLine(series, dim, upto);
    drawDonut(upto);
  }

  function drawLine(series, dim, upto) {
    var host = document.getElementById('lineChart');
    host.textContent = '';

    // Draw in real pixels (the panel width varies) so axis text is never scaled tiny.
    var W = Math.round(host.clientWidth || 760);
    if (W < 280) W = 280;
    var H = W < 520 ? 210 : 240;
    var L = 40, R = 10, T = 12, B = 30;
    var iw = W - L - R, ih = H - T - B;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      role: 'img',
      'aria-label': 'Daily completion percentage across the month'
    });

    for (var g = 0; g <= 4; g++) {
      var y = T + ih - (g * 25 / 100) * ih;
      svg.appendChild(svgEl('line', {
        x1: L, x2: W - R, y1: y, y2: y, stroke: '#e7eaf3', 'stroke-width': 1
      }));
      var lab = svgEl('text', {
        x: L - 8, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: '#9aa1b8'
      });
      lab.textContent = (g * 25) + '%';
      svg.appendChild(lab);
    }

    function xAt(day) { return L + (dim > 1 ? ((day - 1) / (dim - 1)) * iw : iw / 2); }
    function yAt(pct) { return T + ih - (pct / 100) * ih; }

    var pts = [];
    for (var i = 0; i < series.length; i++) {
      if (!series[i].counted) continue;
      pts.push([xAt(series[i].d), yAt(series[i].pct)]);
    }

    if (pts.length) {
      var line = pts.map(function (p, idx) {
        return (idx ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      }).join(' ');
      var area = line +
        ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (T + ih) +
        ' L' + pts[0][0].toFixed(1) + ' ' + (T + ih) + ' Z';

      var defs = svgEl('defs');
      var lg = svgEl('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
      lg.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#0038bd', 'stop-opacity': '.26' }));
      lg.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#0038bd', 'stop-opacity': '.02' }));
      defs.appendChild(lg);
      svg.appendChild(defs);

      svg.appendChild(svgEl('path', { d: area, fill: 'url(#areaGrad)' }));
      svg.appendChild(svgEl('path', {
        d: line, fill: 'none', stroke: '#0038bd', 'stroke-width': 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
      pts.forEach(function (p) {
        svg.appendChild(svgEl('circle', {
          cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 2.2, fill: '#ef8e01'
        }));
      });
    } else {
      var none = svgEl('text', {
        x: W / 2, y: T + ih / 2, 'text-anchor': 'middle', 'font-size': 12, fill: '#9aa1b8'
      });
      none.textContent = habits.length ? 'No ticks recorded yet this month' : 'Add a habit to start the chart';
      svg.appendChild(none);
    }

    // Label every 5th day (plus the last day) and keep a tick mark for orientation —
    // 31 separate numbers collide into an unreadable smear at narrow widths.
    var ticks = [1, 6, 11, 16, 21, 26].filter(function (d) { return d <= dim; });
    if (dim - ticks[ticks.length - 1] >= 2) ticks.push(dim);

    ticks.forEach(function (d2) {
      var x = xAt(d2);
      svg.appendChild(svgEl('line', {
        x1: x.toFixed(1), x2: x.toFixed(1), y1: T + ih, y2: T + ih + 4,
        stroke: '#ccd2e4', 'stroke-width': 1
      }));
      var tx = svgEl('text', {
        x: x.toFixed(1), y: H - B + 17, 'text-anchor': 'middle',
        'font-size': 10.5, fill: '#6a7290', 'class': 'xlab xlab-major'
      });
      tx.textContent = d2;
      svg.appendChild(tx);
    });

    host.appendChild(svg);
  }

  function drawDonut(upto) {
    var host = document.getElementById('donut');
    host.textContent = '';
    var possible = habits.length * upto, done = 0;
    for (var d = 1; d <= upto; d++) done += completedOn(view.y, view.m, d);
    var pct = possible ? Math.round((done / possible) * 100) : 0;
    var left = Math.max(possible - done, 0);

    var R = 54, C = 2 * Math.PI * R, arc = (pct / 100) * C;
    var svg = svgEl('svg', { viewBox: '0 0 132 132', role: 'img', 'aria-label': 'Overview daily progress' });

    svg.appendChild(svgEl('circle', {
      cx: 66, cy: 66, r: R, fill: 'none', stroke: '#e7eaf3', 'stroke-width': 15
    }));
    if (done > 0) {
      svg.appendChild(svgEl('circle', {
        cx: 66, cy: 66, r: R, fill: 'none', stroke: '#ef8e01', 'stroke-width': 15,
        'stroke-dasharray': arc.toFixed(2) + ' ' + (C - arc).toFixed(2),
        'stroke-linecap': 'round', transform: 'rotate(-90 66 66)'
      }));
    }
    var t1 = svgEl('text', {
      x: 66, y: 64, 'text-anchor': 'middle', 'font-size': 23, 'font-weight': 800, fill: '#0038bd'
    });
    t1.textContent = pct + '%';
    var t2 = svgEl('text', {
      x: 66, y: 79, 'text-anchor': 'middle', 'font-size': 8.5, fill: '#8b93a8',
      'letter-spacing': '1'
    });
    t2.textContent = 'DONE';
    svg.appendChild(t1);
    svg.appendChild(t2);
    host.appendChild(svg);

    document.getElementById('donutDone').textContent = done;
    document.getElementById('donutLeft').textContent = left;
  }

  /* ---------------- overview table ---------------- */
  function renderOverview() {
    var host = document.getElementById('overview');
    host.textContent = '';
    var dim = daysInMonth(view.y, view.m), upto = elapsedDays();
    var weeks = weeksOfMonth(dim);

    if (!habits.length) {
      host.appendChild(el('p', 'hint', 'No habits yet — add one to see the daily overview.'));
      return;
    }

    var table = el('table', 'ov');
    var thead = el('thead');

    var r1 = el('tr');
    var c1 = el('th', 'sticky ov-label-cell', 'Overview');
    r1.appendChild(c1);
    weeks.forEach(function (w) {
      var th = el('th', 'week-h ' + wkCls(w.w), 'Week ' + w.w);
      th.colSpan = w.e - w.s + 1;
      r1.appendChild(th);
    });
    thead.appendChild(r1);

    var r2 = el('tr');
    r2.appendChild(el('th', 'sticky ov-label-cell', ''));
    for (var d = 1; d <= dim; d++) {
      var th2 = el('th', 'day-h', String(d));
      if (isToday(view.y, view.m, d)) th2.className += ' is-today';
      r2.appendChild(th2);
    }
    thead.appendChild(r2);
    table.appendChild(thead);

    var tbody = el('tbody');
    function dayRow(label, valueFn, dimIfFuture) {
      var tr = el('tr');
      tr.appendChild(el('th', 'sticky ov-label-cell ov-label', label));
      for (var d = 1; d <= dim; d++) {
        var td = el('td', 'ov-day', String(valueFn(d)));
        if (dimIfFuture && d > upto) td.className += ' dim';
        if (isToday(view.y, view.m, d)) td.className += ' is-today';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    dayRow('Completed', function (d) { return completedOn(view.y, view.m, d); }, false);
    dayRow('Goal', function () { return habits.length; }, true);
    dayRow('Left', function (d) {
      return Math.max(habits.length - completedOn(view.y, view.m, d), 0);
    }, true);

    var trW = el('tr');
    trW.appendChild(el('th', 'sticky ov-label-cell ov-label', 'Weekly progress'));
    weeks.forEach(function (w) {
      var td = el('td', 'wk-profit-cell');
      td.colSpan = w.e - w.s + 1;
      var doneW = 0, goalW = 0;
      for (var d = w.s; d <= w.e; d++) {
        doneW += completedOn(view.y, view.m, d);
        goalW += habits.length;
      }
      var pctW = goalW ? Math.round((doneW / goalW) * 100) : 0;
      var wrap = el('div', 'wbar ' + wkCls(w.w));
      var fig = el('div', 'fig');
      fig.appendChild(el('span', null, doneW + '/' + goalW));
      fig.appendChild(el('span', null, pctW + '%'));
      wrap.appendChild(fig);
      var track = el('div', 'track');
      var fill = el('i');
      fill.style.width = pctW + '%';
      track.appendChild(fill);
      wrap.appendChild(track);
      td.appendChild(wrap);
      trW.appendChild(td);
    });
    tbody.appendChild(trW);
    table.appendChild(tbody);
    host.appendChild(table);
  }

  /* ---------------- habit grid ---------------- */
  function renderGrid() {
    var host = document.getElementById('grid');
    host.textContent = '';
    rowRefs = {};
    var dim = daysInMonth(view.y, view.m);

    if (!habits.length) {
      var empty = el('div', 'empty');
      empty.appendChild(el('b', null, 'No habits yet'));
      empty.appendChild(el('p', null, 'Add your first habit, or load a starter set to see the tracker working.'));
      var row = el('div');
      row.style.display = 'flex';
      row.style.gap = '9px';
      row.style.justifyContent = 'center';
      var b1 = el('button', 'btn primary', '+ New habit');
      b1.type = 'button';
      b1.addEventListener('click', function () { openEditor(null); });
      var b2 = el('button', 'btn ghost', 'Load starter habits');
      b2.type = 'button';
      b2.addEventListener('click', loadStarters);
      row.appendChild(b1);
      row.appendChild(b2);
      empty.appendChild(row);
      host.appendChild(empty);
      return;
    }

    var weeks = weeksOfMonth(dim);
    var table = el('table', 'grid');
    var thead = el('thead');

    var r1 = el('tr');
    var nameH = el('th', 'sticky-name', 'Daily habits');
    nameH.rowSpan = 2;
    r1.appendChild(nameH);
    var goalH = el('th', 'sticky-goal', 'Goals');
    goalH.rowSpan = 2;
    r1.appendChild(goalH);
    weeks.forEach(function (w) {
      var th = el('th', 'week-h ' + wkCls(w.w), 'Week ' + w.w);
      th.colSpan = w.e - w.s + 1;
      r1.appendChild(th);
    });
    var doneH = el('th', 'num-h', 'Done');
    doneH.rowSpan = 2;
    r1.appendChild(doneH);
    var leftH = el('th', 'num-h', 'Left');
    leftH.rowSpan = 2;
    r1.appendChild(leftH);
    var progH = el('th', 'prog-h', 'Progress');
    progH.rowSpan = 2;
    r1.appendChild(progH);
    thead.appendChild(r1);

    var r2 = el('tr');
    for (var d = 1; d <= dim; d++) {
      var th = el('th', 'day-h ' + wkCls(weekOf(d)));
      var dow = el('span', 'dow', DAY_LETTER[new Date(view.y, view.m, d).getDay()]);
      th.appendChild(dow);
      th.appendChild(document.createTextNode(String(d)));
      if (isToday(view.y, view.m, d)) th.className += ' is-today';
      r2.appendChild(th);
    }
    thead.appendChild(r2);
    table.appendChild(thead);

    var tbody = el('tbody');
    habits.forEach(function (h) {
      var tr = el('tr');

      var nameCell = el('th', 'hname-cell sticky-name');
      var nameBtn = el('button', 'name-btn', h.name);
      nameBtn.type = 'button';
      nameBtn.title = 'Edit ' + h.name;
      nameBtn.addEventListener('click', function () { openEditor(h); });
      nameCell.appendChild(nameBtn);
      if (h.source === 'garmin-sleep') {
        var badge = el('span', 'badge', 'Garmin');
        badge.title = 'Ticked automatically from Garmin sleep';
        nameCell.appendChild(badge);
      }
      tr.appendChild(nameCell);

      var goal = goalFor(h, view.y, view.m);
      var goalCell = el('td', 'goal-cell sticky-goal');
      var goalInput = el('input', 'goal-input');
      goalInput.type = 'number';
      goalInput.min = '0';
      goalInput.max = String(dim);
      goalInput.value = String(goal);
      goalInput.setAttribute('aria-label', 'Monthly goal for ' + h.name);
      goalInput.addEventListener('change', function () {
        var v = parseInt(goalInput.value, 10);
        if (!isFinite(v)) v = dim;
        v = Math.max(0, Math.min(dim, v));
        goalInput.value = String(v);
        h.goals[mKey(view.y, view.m)] = v;
        h.updatedAt = Date.now();
        save();
        updateRowStats(h);
        renderOverview();
        renderCharts();
        renderTop();
        renderTiles();
      });
      goalCell.appendChild(goalInput);
      tr.appendChild(goalCell);

      for (var d = 1; d <= dim; d++) {
        var k = K(view.y, view.m, d);
        var wc = wkCls(weekOf(d));
        var td = el('td', 'day-cell ' + wc);
        if (isToday(view.y, view.m, d)) td.className += ' is-today';

        var box = el('button', 'box ' + wc + (h.log[k] ? ' on' : ''));
        box.type = 'button';
        box.textContent = '✓';
        box.setAttribute('aria-pressed', h.log[k] ? 'true' : 'false');
        box.setAttribute('aria-label', h.name + ', day ' + d);
        box.dataset.h = h.id;      // lets the Today checklist find this box
        box.dataset.k = k;
        box.addEventListener('click', function (habit, dayKey, button) {
          return function () { toggle(habit, dayKey, button); };
        }(h, k, box));
        td.appendChild(box);
        tr.appendChild(td);
      }

      var done = doneInMonth(h, view.y, view.m);
      var leftN = Math.max(goal - done, 0);
      var pctN = goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0;

      var tdDone = el('td', 'num', String(done));
      var tdLeft = el('td', 'num left', String(leftN));
      var tdProg = el('td', 'prog-cell');
      var meta = el('div', 'prog-meta');
      var ml = el('span', null, done + '/' + goal);
      var mr = el('span', null, pctN + '%');
      meta.appendChild(ml);
      meta.appendChild(mr);
      var bar = el('div', 'pbar');
      var fill = el('i');
      fill.style.width = pctN + '%';
      bar.appendChild(fill);
      tdProg.appendChild(meta);
      tdProg.appendChild(bar);

      tr.appendChild(tdDone);
      tr.appendChild(tdLeft);
      tr.appendChild(tdProg);
      tbody.appendChild(tr);

      rowRefs[h.id] = { done: tdDone, left: tdLeft, ml: ml, mr: mr, fill: fill };
    });

    table.appendChild(tbody);
    host.appendChild(table);
  }

  function updateRowStats(h) {
    var ref = rowRefs[h.id];
    if (!ref) return;
    var goal = goalFor(h, view.y, view.m);
    var done = doneInMonth(h, view.y, view.m);
    var pct = goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0;
    ref.done.textContent = done;
    ref.left.textContent = Math.max(goal - done, 0);
    ref.ml.textContent = done + '/' + goal;
    ref.mr.textContent = pct + '%';
    ref.fill.style.width = pct + '%';
  }

  function toggle(h, k, box) {
    if (h.log[k]) delete h.log[k];
    else h.log[k] = true;
    h.updatedAt = Date.now();
    if (!box) {
      // ticked from the Today checklist: update the month grid's box for the same day
      var boxes = document.querySelectorAll('#grid button.box[data-k="' + k + '"]');
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].dataset.h === h.id) { box = boxes[i]; break; }
      }
    }
    if (box) {
      box.classList.toggle('on', !!h.log[k]);
      box.setAttribute('aria-pressed', h.log[k] ? 'true' : 'false');
    }
    save();
    renderToday();
    updateRowStats(h);
    renderOverview();
    renderCharts();
    renderTop();
    renderTiles();
  }

  /* ---------------- today checklist ---------------- */
  function streakOf(h) {
    var d = new Date(), n = 0, guard = 0;
    while (guard++ < 500) {
      if (h.log[K(d.getFullYear(), d.getMonth(), d.getDate())]) n++;
      else if (guard > 1) break;   // an unticked today doesn't break a live streak
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  function renderToday() {
    var host = document.getElementById('todayList');
    if (!host) return;
    var now = new Date();
    var k = K(now.getFullYear(), now.getMonth(), now.getDate());
    document.getElementById('todayDate').textContent =
      now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    var done = 0;
    habits.forEach(function (h) { if (h.log[k]) done++; });
    document.getElementById('todayCount').textContent = done + ' / ' + habits.length;
    document.getElementById('todayFill').style.width =
      habits.length ? Math.round((done / habits.length) * 100) + '%' : '0%';

    host.textContent = '';
    var note = document.getElementById('todayNote');

    if (!habits.length) {
      note.textContent = 'No habits yet.';
      var first = el('button', 'tick-row', '+ Add your first habit');
      first.type = 'button';
      first.addEventListener('click', function () { openEditor(null); });
      host.appendChild(first);
      return;
    }

    note.textContent = done === habits.length
      ? 'All done for today — nice work.'
      : (habits.length - done) + ' left today · tap a habit to tick it off';

    habits.forEach(function (h) {
      var on = !!h.log[k];
      var row = el('button', 'tick-row' + (on ? ' done' : ''));
      row.type = 'button';
      row.setAttribute('aria-pressed', on ? 'true' : 'false');
      row.setAttribute('aria-label', (on ? 'Untick ' : 'Tick ') + h.name);

      var box = el('span', 'tickbox');
      box.appendChild(el('span', 'tickmark', '✓'));
      row.appendChild(box);
      row.appendChild(el('span', 'tickname', h.name));

      var st = streakOf(h);
      if (st > 1) {
        var chip = el('span', 'tickstreak', st + 'd');
        chip.title = st + '-day streak';
        row.appendChild(chip);
      }
      row.addEventListener('click', function () { toggle(h, k, null); });
      host.appendChild(row);
    });
  }

  /* ---------------- top 10 + tiles ---------------- */
  function renderTop() {
    var host = document.getElementById('topHabits');
    host.textContent = '';
    if (!habits.length) {
      host.appendChild(el('li', 'hint', 'Nothing tracked yet.'));
      return;
    }
    var rows = habits.map(function (h) {
      var goal = goalFor(h, view.y, view.m);
      var done = doneInMonth(h, view.y, view.m);
      return {
        name: h.name, done: done, goal: goal,
        pct: goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0
      };
    }).sort(function (a, b) {
      return (b.pct - a.pct) || (b.done - a.done);
    }).slice(0, 10);

    rows.forEach(function (r, i) {
      var li = el('li');
      li.appendChild(el('span', 'rank', String(i + 1)));
      var wrap = el('div');
      wrap.appendChild(el('div', 'tname', r.name));
      var bar = el('div', 'pbar');
      bar.style.marginTop = '3px';
      var fill = el('i');
      fill.style.width = r.pct + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
      li.appendChild(wrap);
      li.appendChild(el('span', 'tpct', r.pct + '%'));
      host.appendChild(li);
    });
  }

  function renderTiles() {
    var dim = daysInMonth(view.y, view.m), upto = elapsedDays();
    var ticks = 0, perfect = 0;
    for (var d = 1; d <= dim; d++) {
      var c = completedOn(view.y, view.m, d);
      ticks += c;
      if (d <= upto && habits.length && c === habits.length) perfect++;
    }
    var possible = habits.length * upto;
    var cons = possible ? Math.round((ticks / possible) * 100) : 0;
    document.getElementById('tileTicks').textContent = String(ticks);
    document.getElementById('tileCons').textContent = cons + '%';
    document.getElementById('tilePerfect').textContent = String(perfect);
  }

  /* ---------------- editor ---------------- */
  var scrim = document.getElementById('scrim');

  function openEditor(h) {
    editingId = h ? h.id : null;
    document.getElementById('editorTitle').textContent = h ? 'Edit habit' : 'New habit';
    document.getElementById('editorHint').textContent = h
      ? 'Rename it or change this month’s target.'
      : 'Give it a name and a target for ' + MONTHS[view.m] + '.';
    var nameInput = document.getElementById('nameInput');
    nameInput.value = h ? h.name : '';
    var goalInput = document.getElementById('goalInput');
    goalInput.max = String(daysInMonth(view.y, view.m));
    goalInput.value = String(h ? goalFor(h, view.y, view.m) : daysInMonth(view.y, view.m));
    document.getElementById('garminToggle').checked = !!(h && h.source === 'garmin-sleep');
    document.getElementById('deleteHabit').style.display = h ? '' : 'none';
    scrim.classList.add('open');
    setTimeout(function () { nameInput.focus(); }, 60);
  }

  function closeEditor() {
    scrim.classList.remove('open');
    editingId = null;
  }

  function commitEditor() {
    var name = document.getElementById('nameInput').value.trim();
    if (!name) { toast('Give the habit a name'); return; }
    var dim = daysInMonth(view.y, view.m);
    var goal = parseInt(document.getElementById('goalInput').value, 10);
    if (!isFinite(goal)) goal = dim;
    goal = Math.max(0, Math.min(dim, goal));

    var garmin = document.getElementById('garminToggle').checked;
    var source = garmin ? 'garmin-sleep' : null;

    if (editingId) {
      habits.forEach(function (h) {
        if (h.id === editingId) {
          h.name = name;
          h.goals[mKey(view.y, view.m)] = goal;
          h.source = source;
          h.updatedAt = Date.now();
        }
      });
    } else {
      var goals = {};
      goals[mKey(view.y, view.m)] = goal;
      habits.push({
        id: uid(), name: name, goals: goals, log: {}, source: source,
        updatedAt: Date.now()
      });
    }
    var wasNew = !editingId;
    save();
    closeEditor();
    renderAll();
    toast(wasNew ? 'Habit added' : 'Saved');
    if (garmin) syncGarmin({ quiet: false });
  }

  function deleteHabit() {
    if (!editingId) return;
    var target = habits.filter(function (h) { return h.id === editingId; })[0];
    if (!target) return;
    if (!confirm('Delete “' + target.name + '” and its whole history?')) return;
    tombstones.push({ id: editingId, updatedAt: Date.now() });
    habits = habits.filter(function (h) { return h.id !== editingId; });
    save();
    closeEditor();
    renderAll();
    toast('Habit deleted');
  }

  function loadStarters() {
    var dim = daysInMonth(view.y, view.m);
    STARTERS.forEach(function (name) {
      var goals = {};
      goals[mKey(view.y, view.m)] = dim;
      habits.push({
        id: uid(), name: name, goals: goals, log: {},
        source: name === 'Sleep 7 hours' ? 'garmin-sleep' : null
      });
    });
    save();
    renderAll();
    toast('Starter habits added');
    syncGarmin({ quiet: true });
  }

  /* ---------------- Garmin sleep sync ---------------- */
  function setSyncStatus(text, state) {
    var pill = document.getElementById('syncState');
    if (!pill) return;
    pill.textContent = text;
    pill.setAttribute('data-state', state || 'off');
  }

  // Mirror the published nights onto every habit flagged as Garmin-sourced.
  function applyGarminDays(days) {
    var changed = 0, keys = Object.keys(days);
    habits.forEach(function (h) {
      if (h.source !== 'garmin-sleep') return;
      var touched = 0;
      keys.forEach(function (k) {
        var want = days[k] === true;
        if (want && !h.log[k]) { h.log[k] = true; touched++; }
        else if (!want && h.log[k]) { delete h.log[k]; touched++; }
      });
      if (touched) { h.updatedAt = Date.now(); changed += touched; }
    });
    if (changed) { save(); renderAll(); }
    return changed;
  }

  function syncGarmin(opts) {
    var quiet = !!(opts && opts.quiet);
    setSyncStatus('Garmin · syncing…', 'busy');
    return fetch(SYNC_URL + '?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var days = (data && data.days) || {};
        if (!Object.keys(days).length) {
          setSyncStatus('Garmin · no nights yet', 'off');
          return 0;
        }
        var changed = applyGarminDays(days);
        var when = data.generated ? new Date(data.generated) : null;
        var stamp = (when && !isNaN(when.getTime()))
          ? when.toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            })
          : 'synced';
        setSyncStatus('Garmin · ' + stamp, 'ok');
        if (changed && !quiet) toast(changed + ' night' + (changed === 1 ? '' : 's') + ' synced');
        return changed;
      })
      .catch(function (err) {
        setSyncStatus('Garmin · not connected', 'off');
        if (!quiet) toast('Garmin sync unavailable: ' + err.message);
        return 0;
      });
  }

  /* ---------------- cloud sync (Cloudflare Worker + D1) ---------------- */
  function syncKey() {
    try { return localStorage.getItem(SYNC_KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function hasSync() { return syncKey().length > 0; }

  function setCloudState(text, state) {
    var pill = document.getElementById('cloudState');
    if (pill) {
      pill.textContent = text;
      pill.setAttribute('data-state', state || 'off');
    }
  }

  function stamp() {
    var d = new Date();
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function markSynced() {
    try { localStorage.setItem(SYNC_LAST_STORAGE, String(Date.now())); } catch (e) { /* ignore */ }
    setCloudState('Synced · ' + stamp(), 'ok');
  }

  function schedulePush() {
    if (!hasSync()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushRemote(); }, 1500);
  }

  // Newest metadata wins; ticks are unioned (a tick is additive across devices).
  function mergeHabit(a, b) {
    var newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    var log = {};
    [a.log || {}, b.log || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) { if (src[k]) log[k] = true; });
    });
    var goals = {};
    [a.goals || {}, b.goals || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) { goals[k] = src[k]; });
    });
    return {
      id: newer.id,
      name: newer.name,
      goals: goals,
      log: log,
      source: newer.source === 'garmin-sleep' ? 'garmin-sleep' : null,
      updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0)
    };
  }

  function mergeDocs(localDoc, remoteDoc) {
    var tomb = {};
    function note(list) {
      (list || []).forEach(function (t) {
        if (!t || !t.id) return;
        tomb[t.id] = Math.max(tomb[t.id] || 0, Number(t.updatedAt) || 0);
      });
    }
    note(localDoc.deleted);
    note(remoteDoc.deleted);

    var map = {};
    (remoteDoc.habits || []).forEach(function (h) { if (h && h.id) map[h.id] = h; });
    (localDoc.habits || []).forEach(function (h) {
      if (!h || !h.id) return;
      map[h.id] = map[h.id] ? mergeHabit(h, map[h.id]) : h;
    });

    var merged = [];
    Object.keys(map).forEach(function (id) {
      var h = map[id];
      if ((tomb[id] || 0) >= (h.updatedAt || 0) && tomb[id]) return;  // delete wins
      merged.push(h);
    });
    var deleted = Object.keys(tomb).map(function (id) {
      return { id: id, updatedAt: tomb[id] };
    });
    return { version: 3, habits: merged, deleted: deleted };
  }

  function pullRemote() {
    if (!hasSync()) return Promise.resolve(false);
    syncing = true;
    setCloudState('Syncing…', 'busy');
    return fetch(SYNC_API + '/api/state', {
      headers: { Authorization: 'Bearer ' + syncKey() },
      cache: 'no-store'
    })
      .then(function (res) {
        if (res.status === 401) throw new Error('key rejected');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        syncing = false;
        if (!data || !data.payload) {          // empty server: seed it from this device
          pushRemote();
          return false;
        }
        var merged = mergeDocs(doc(), data.payload);
        var changed = JSON.stringify(merged) !== JSON.stringify(doc());
        if (changed) {
          habits = merged.habits;
          tombstones = merged.deleted;
          save();
          renderAll();
        }
        markSynced();
        return changed;
      })
      .catch(function (err) {
        syncing = false;
        setCloudState('Sync error · ' + err.message, 'off');
        return false;
      });
  }

  function pushRemote() {
    if (!hasSync()) return Promise.resolve(false);
    return fetch(SYNC_API + '/api/state', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + syncKey(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payload: doc() })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        markSynced();
        return true;
      })
      .catch(function (err) {
        setCloudState('Push failed · ' + err.message, 'off');
        return false;
      });
  }

  function refreshCloudUI() {
    var nowBtn = document.getElementById('cloudSyncNow');
    var note = document.getElementById('storageNote');
    if (hasSync()) {
      var last = 0;
      try { last = Number(localStorage.getItem(SYNC_LAST_STORAGE)) || 0; } catch (e) { last = 0; }
      setCloudState(last ? 'Synced · ' + stamp() : 'Connected', 'ok');
      document.getElementById('cloudBtn').textContent = 'Change key';
      if (nowBtn) nowBtn.style.display = '';
      if (note) note.textContent = 'Synced through your Cloudflare Worker — every connected device sees the same habits.';
    } else {
      setCloudState('Sync off', 'off');
      document.getElementById('cloudBtn').textContent = 'Connect';
      if (nowBtn) nowBtn.style.display = 'none';
      if (note) note.textContent = 'Data is stored in this browser only.';
    }
  }

  var cloudScrim = document.getElementById('cloudScrim');

  function openCloudModal() {
    document.getElementById('cloudKey').value = syncKey();
    document.getElementById('cloudForget').style.display = hasSync() ? '' : 'none';
    cloudScrim.classList.add('open');
    setTimeout(function () { document.getElementById('cloudKey').focus(); }, 60);
  }

  function closeCloudModal() {
    cloudScrim.classList.remove('open');
  }

  function connectCloud() {
    var key = document.getElementById('cloudKey').value.trim();
    if (!key) { toast('Paste the sync key first'); return; }
    try { localStorage.setItem(SYNC_KEY_STORAGE, key); } catch (e) {
      toast('Could not store the key in this browser');
      return;
    }
    closeCloudModal();
    refreshCloudUI();
    pullRemote().then(function (changed) {
      toast(changed ? 'Connected — pulled changes from another device' : 'Connected');
      pushRemote();
    });
  }

  function disconnectCloud() {
    try {
      localStorage.removeItem(SYNC_KEY_STORAGE);
      localStorage.removeItem(SYNC_LAST_STORAGE);
    } catch (e) { /* ignore */ }
    closeCloudModal();
    refreshCloudUI();
    toast('Cloud sync disconnected');
  }

  /* ---------------- render all ---------------- */
  function renderAll() {
    document.getElementById('yearSel').value = String(view.y);
    document.getElementById('monthSel').value = String(view.m);

    var scroller = document.getElementById('gridScroll');
    var keepLeft = scroller ? scroller.scrollLeft : 0;
    renderToday();
    renderGrid();
    renderOverview();
    renderCharts();
    renderTop();
    renderTiles();
    if (scroller) scroller.scrollLeft = keepLeft;
  }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }

  /* ---------------- export / import ---------------- */
  function exportJSON() {
    var blob = new Blob(
      [JSON.stringify({ version: 2, habits: habits }, null, 2)],
      { type: 'application/json' }
    );
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'habits-' + view.y + '-' + pad2(view.m + 1) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  function importJSON(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.habits)) throw new Error('bad shape');
        if (!confirm('Replace your current habits with the ' + data.habits.length + ' from this file?')) return;
        habits = data.habits.map(function (h) {
          return {
            id: String(h.id || uid()),
            name: String(h.name || 'Habit'),
            goals: (h.goals && typeof h.goals === 'object') ? h.goals : {},
            log: (h.log && typeof h.log === 'object') ? h.log : {},
            source: h.source === 'garmin-sleep' ? 'garmin-sleep' : null,
            updatedAt: Number(h.updatedAt) || 0
          };
        });
        tombstones = Array.isArray(data.deleted)
          ? data.deleted.map(function (t) {
              return { id: String(t.id), updatedAt: Number(t.updatedAt) || 0 };
            })
          : [];
        save();
        renderAll();
        toast('Backup imported');
      } catch (err) {
        toast('That file is not a habit backup');
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    var now = new Date();
    view.y = now.getFullYear();
    view.m = now.getMonth();

    var ySel = document.getElementById('yearSel');
    var mSel = document.getElementById('monthSel');
    for (var y = view.y - 3; y <= view.y + 2; y++) ySel.appendChild(new Option(String(y), String(y)));
    MONTHS.forEach(function (name, idx) { mSel.appendChild(new Option(name, String(idx))); });

    ySel.addEventListener('change', function () { view.y = parseInt(ySel.value, 10); renderAll(); });
    mSel.addEventListener('change', function () { view.m = parseInt(mSel.value, 10); renderAll(); });

    document.getElementById('addBtn').addEventListener('click', function () { openEditor(null); });
    document.getElementById('syncBtn').addEventListener('click', function () { syncGarmin({ quiet: false }); });
    document.getElementById('cloudBtn').addEventListener('click', openCloudModal);
    document.getElementById('cloudSyncNow').addEventListener('click', function () { pullRemote(); });
    document.getElementById('cloudCancel').addEventListener('click', closeCloudModal);
    document.getElementById('cloudSave').addEventListener('click', connectCloud);
    document.getElementById('cloudForget').addEventListener('click', disconnectCloud);
    cloudScrim.addEventListener('click', function (ev) { if (ev.target === cloudScrim) closeCloudModal(); });
    document.getElementById('cloudKey').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); connectCloud(); }
    });
    document.getElementById('cancelBtn').addEventListener('click', closeEditor);
    document.getElementById('saveBtn').addEventListener('click', commitEditor);
    document.getElementById('deleteHabit').addEventListener('click', deleteHabit);
    document.getElementById('exportBtn').addEventListener('click', exportJSON);
    document.getElementById('importBtn').addEventListener('click', function () {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', function (ev) {
      importJSON(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });

    scrim.addEventListener('click', function (ev) { if (ev.target === scrim) closeEditor(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeEditor();
    });
    document.getElementById('nameInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitEditor(); }
    });

    load();
    renderAll();
    refreshCloudUI();
    if (hasSync()) pullRemote();
    syncGarmin({ quiet: true });   // silent on first paint; failure just greys the pill

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        renderAll();                      // day rollover while open
        if (hasSync()) pullRemote();      // catch up with other devices
      }
    });

    // the line chart is drawn in real pixels, so it must redraw when the panel resizes
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { renderCharts(); }, 180);
    });

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0 &&
        location.hostname !== '127.0.0.1') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache optional */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
