/* ============================================================
   Habits — mobile-first tracker.
   Today checklist · month heatmap · stats · settings.
   Data lives in localStorage and syncs through a Cloudflare Worker.
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'habit-tracker-v2';
  var SYNC_URL = 'garmin-sleep.json';
  var SYNC_API = 'https://habit-tracker-sync.abhinavmanocha.workers.dev';
  var SYNC_KEY_STORAGE = 'ht-sync-key';
  var SYNC_LAST_STORAGE = 'ht-last-sync';
  var VIEW_STORAGE = 'ht-view';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var SVGNS = 'http://www.w3.org/2000/svg';
  var STARTERS = [
    'Wake up at 9:00', 'Sleep 7 hours', '3L water', 'Exercise 45 min',
    'Read 20 pages', 'No screens before bed', 'Journal'
  ];

  var habits = [];
  var tombstones = [];          // [{ id, updatedAt }] so deletes survive a merge
  var view = { y: 0, m: 0 };    // month currently being looked at
  var currentView = 'today';
  var editingId = null;
  var sheetHabitId = null;
  var saveTimer = null;
  var pushTimer = null;
  var syncing = false;

  /* ---------------- helpers ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function K(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function mKey(y, m) { return y + '-' + pad2(m + 1); }
  function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
  function isToday(y, m, d) {
    var t = new Date();
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
  }
  function todayKey() {
    var t = new Date();
    return K(t.getFullYear(), t.getMonth(), t.getDate());
  }
  function inFuture(y, m, d) {
    var t = new Date();
    return new Date(y, m, d) > new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
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
  function checkIcon() {
    var svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { d: 'M4 12.2 9.2 17.4 20 6.6' }));
    return svg;
  }
  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* ignore */ }
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
  function elapsedDays() {
    var t = new Date();
    if (view.y === t.getFullYear() && view.m === t.getMonth()) return t.getDate();
    if (view.y > t.getFullYear() || (view.y === t.getFullYear() && view.m > t.getMonth())) return 0;
    return daysInMonth(view.y, view.m);
  }
  function streakOf(h) {
    var d = new Date(), n = 0, guard = 0;
    while (guard++ < 500) {
      if (h.log[K(d.getFullYear(), d.getMonth(), d.getDate())]) n++;
      else if (guard > 1) break;   // an unticked today doesn't break a live streak
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  function monthPct() {
    var dim = daysInMonth(view.y, view.m), upto = elapsedDays();
    if (!habits.length || !upto) return 0;
    var ticks = 0;
    for (var d = 1; d <= upto; d++) ticks += completedOn(view.y, view.m, d);
    return Math.round((ticks / (habits.length * upto)) * 100);
  }

  /* ---------------- stats ---------------- */
  function renderStats() {
    var dim = daysInMonth(view.y, view.m), upto = elapsedDays(), series = [];
    for (var d = 1; d <= dim; d++) {
      var c = completedOn(view.y, view.m, d);
      series.push({
        d: d, c: c, counted: d <= upto,
        pct: habits.length ? (c / habits.length) * 100 : 0
      });
    }
    drawLine(series, dim);
    drawDonut(upto);
    renderTop();
    renderTiles();
  }

  function drawLine(series, dim) {
    var host = document.getElementById('lineChart');
    host.textContent = '';
    var W = Math.round(host.clientWidth || 340);
    if (W < 240) W = 240;
    var H = 200, L = 34, R = 8, T = 10, B = 26;
    var iw = W - L - R, ih = H - T - B;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Daily completion percentage across the month'
    });

    for (var g = 0; g <= 4; g++) {
      var y = T + ih - (g * 25 / 100) * ih;
      svg.appendChild(svgEl('line', {
        x1: L, x2: W - R, y1: y, y2: y, stroke: '#e7eaf3', 'stroke-width': 1
      }));
      var lab = svgEl('text', {
        x: L - 7, y: y + 3.5, 'text-anchor': 'end', 'font-size': 9.5, fill: '#9aa1b8'
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
      lg.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#0038bd', 'stop-opacity': '.24' }));
      lg.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#0038bd', 'stop-opacity': '.02' }));
      defs.appendChild(lg);
      svg.appendChild(defs);
      svg.appendChild(svgEl('path', { d: area, fill: 'url(#areaGrad)' }));
      svg.appendChild(svgEl('path', {
        d: line, fill: 'none', stroke: '#0038bd', 'stroke-width': 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
      pts.forEach(function (p) {
        svg.appendChild(svgEl('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 2.1, fill: '#ef8e01' }));
      });
    } else {
      var none = svgEl('text', {
        x: W / 2, y: T + ih / 2, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#9aa1b8'
      });
      none.textContent = habits.length ? 'No ticks yet this month' : 'Add a habit to start';
      svg.appendChild(none);
    }

    var ticks = [1, 6, 11, 16, 21, 26].filter(function (d) { return d <= dim; });
    if (dim - ticks[ticks.length - 1] >= 2) ticks.push(dim);
    ticks.forEach(function (d2) {
      var x = xAt(d2);
      svg.appendChild(svgEl('line', {
        x1: x.toFixed(1), x2: x.toFixed(1), y1: T + ih, y2: T + ih + 4,
        stroke: '#ccd2e4', 'stroke-width': 1
      }));
      var tx = svgEl('text', {
        x: x.toFixed(1), y: H - B + 16, 'text-anchor': 'middle',
        'font-size': 10, fill: '#6a7290', 'class': 'xlab'
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

    var R = 54, C = 2 * Math.PI * R, arc = (pct / 100) * C;
    var svg = svgEl('svg', { viewBox: '0 0 132 132', role: 'img', 'aria-label': 'Month completion' });
    svg.appendChild(svgEl('circle', { cx: 66, cy: 66, r: R, fill: 'none', stroke: '#e7eaf3', 'stroke-width': 15 }));
    if (done > 0) {
      svg.appendChild(svgEl('circle', {
        cx: 66, cy: 66, r: R, fill: 'none', stroke: '#ef8e01', 'stroke-width': 15,
        'stroke-dasharray': arc.toFixed(2) + ' ' + (C - arc).toFixed(2),
        'stroke-linecap': 'round', transform: 'rotate(-90 66 66)'
      }));
    }
    var t1 = svgEl('text', { x: 66, y: 64, 'text-anchor': 'middle', 'font-size': 23, 'font-weight': 800, fill: '#0038bd' });
    t1.textContent = pct + '%';
    var t2 = svgEl('text', { x: 66, y: 79, 'text-anchor': 'middle', 'font-size': 8.5, fill: '#8b93a8', 'letter-spacing': '1' });
    t2.textContent = 'DONE';
    svg.appendChild(t1);
    svg.appendChild(t2);
    host.appendChild(svg);
    document.getElementById('donutDone').textContent = done;
    document.getElementById('donutLeft').textContent = Math.max(possible - done, 0);
  }

  function renderTop() {
    var host = document.getElementById('topHabits');
    host.textContent = '';
    if (!habits.length) {
      host.appendChild(el('li', 'hint', 'Nothing tracked yet.'));
      return;
    }
    var upto = elapsedDays() || 1;
    habits.map(function (h) {
      var done = 0, dim = daysInMonth(view.y, view.m);
      var cap = Math.min(upto, dim);
      for (var d = 1; d <= cap; d++) { if (h.log[K(view.y, view.m, d)]) done++; }
      return { name: h.name, done: done, cap: cap, pct: Math.round((done / cap) * 100) };
    }).sort(function (a, b) {
      return (b.pct - a.pct) || (b.done - a.done);
    }).slice(0, 10).forEach(function (r, i) {
      var li = el('li');
      li.appendChild(el('span', 'rank', String(i + 1)));
      var wrap = el('div');
      wrap.appendChild(el('div', 'tname', r.name));
      var bar = el('div', 'pbar');
      bar.style.marginTop = '4px';
      var fill = el('i');
      fill.style.width = Math.min(100, r.pct) + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
      li.appendChild(wrap);
      li.appendChild(el('span', 'tpct', r.done + '/' + r.cap));
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
    document.getElementById('tileTicks').textContent = String(ticks);
    document.getElementById('tileCons').textContent = (possible ? Math.round((ticks / possible) * 100) : 0) + '%';
    document.getElementById('tilePerfect').textContent = String(perfect);
  }

  function emptyState(host) {
    var card = el('div', 'empty-card');
    card.appendChild(el('b', null, 'No habits yet'));
    card.appendChild(el('p', 'hint', 'Add your first habit, or load a starter set to see how it works.'));
    var row = el('div', 'btn-row');
    var add = el('button', 'btn primary', '+ New habit');
    add.type = 'button';
    add.addEventListener('click', function () { openEditor(null); });
    var starters = el('button', 'btn ghost', 'Load starter habits');
    starters.type = 'button';
    starters.id = 'loadStarters';
    starters.addEventListener('click', loadStarters);
    row.appendChild(add);
    row.appendChild(starters);
    card.appendChild(row);
    host.appendChild(card);
  }

  /* ---------------- today ---------------- */
  function renderToday() {
    var now = new Date();
    var k = todayKey();
    var host = document.getElementById('todayList');
    host.textContent = '';

    var done = 0;
    habits.forEach(function (h) { if (h.log[k]) done++; });
    var total = habits.length;
    var pct = total ? Math.round((done / total) * 100) : 0;

    document.getElementById('todayDate').textContent =
      now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    document.getElementById('todayLeft').textContent = !total
      ? 'Add your first habit to begin'
      : (done === total ? 'All done — nice work' : (total - done) + ' left today');

    drawRing(pct);

    if (!total) {
      emptyState(host);
      return;
    }

    habits.forEach(function (h) {
      var on = !!h.log[k];
      var streak = streakOf(h);

      var row = el('div', 'row' + (on ? ' done' : ''));

      var btn = el('button', 'row-toggle');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', (on ? 'Untick ' : 'Tick ') + h.name + ' for today');

      var box = el('span', 'checkbox');
      box.appendChild(checkIcon());
      btn.appendChild(box);

      var main = el('span', 'row-main');
      main.appendChild(el('span', 'row-name', h.name));
      if (streak > 1 || h.source === 'garmin-sleep') {
        var meta = el('span', 'row-meta');
        if (streak > 1) meta.appendChild(el('span', null, streak + '-day streak'));
        if (h.source === 'garmin-sleep') meta.appendChild(el('span', 'badge-garmin', 'Garmin'));
        main.appendChild(meta);
      }
      btn.appendChild(main);
      btn.addEventListener('click', function () { toggle(h, k); });
      row.appendChild(btn);

      var more = el('button', 'row-more', '⋯');
      more.type = 'button';
      more.setAttribute('aria-label', 'Open ' + h.name);
      more.addEventListener('click', function () { openHabitSheet(h.id); });
      row.appendChild(more);

      host.appendChild(row);
    });
  }

  function drawRing(pct) {
    var host = document.getElementById('todayRing');
    host.textContent = '';
    var R = 32, C = 2 * Math.PI * R, arc = (pct / 100) * C;
    var svg = svgEl('svg', { viewBox: '0 0 76 76' });
    svg.appendChild(svgEl('circle', { cx: 38, cy: 38, r: R, fill: 'none', stroke: '#e7eaf3', 'stroke-width': 7 }));
    if (pct > 0) {
      svg.appendChild(svgEl('circle', {
        cx: 38, cy: 38, r: R, fill: 'none', stroke: '#0038bd', 'stroke-width': 7,
        'stroke-dasharray': arc.toFixed(2) + ' ' + (C - arc).toFixed(2),
        'stroke-linecap': 'round', transform: 'rotate(-90 38 38)'
      }));
    }
    var t = svgEl('text', {
      x: 38, y: 42, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 800, fill: '#0038bd'
    });
    t.textContent = pct + '%';
    svg.appendChild(t);
    host.appendChild(svg);
  }

  /* ---------------- month ---------------- */
  function renderMonth() {
    var dim = daysInMonth(view.y, view.m);
    var host = document.getElementById('monthList');
    host.textContent = '';

    document.getElementById('monthHeading').textContent = MONTHS[view.m];
    document.getElementById('monthSub').textContent =
      habits.length ? dim + ' days · ' + habits.length + ' habits' : dim + ' days';
    document.getElementById('monthPct').textContent = monthPct() + '%';

    if (!habits.length) {
      emptyState(host);
      return;
    }

    habits.forEach(function (h) {
      var goal = goalFor(h, view.y, view.m);
      var done = doneInMonth(h, view.y, view.m);
      var pct = goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0;

      var row = el('button', 'mrow');
      row.type = 'button';
      row.setAttribute('aria-label', h.name + ': ' + done + ' of ' + goal + ' days. Open details');

      var top = el('div', 'mrow-top');
      top.appendChild(el('span', 'mrow-name', h.name));
      top.appendChild(el('span', 'mrow-num', done + '/' + goal));
      row.appendChild(top);

      var strip = el('div', 'strip');
      for (var d = 1; d <= dim; d++) {
        var k = K(view.y, view.m, d);
        var cls = 'dot' + (h.log[k] ? ' on' : '') +
          (inFuture(view.y, view.m, d) ? ' future' : '') +
          (isToday(view.y, view.m, d) ? ' today' : '');
        strip.appendChild(el('span', cls));
      }
      row.appendChild(strip);

      var bar = el('div', 'mbar');
      var fill = el('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      row.appendChild(bar);

      row.addEventListener('click', function () { openHabitSheet(h.id); });
      host.appendChild(row);
    });
  }

  /* ---------------- habit sheet ---------------- */
  var habitSheet = document.getElementById('habitSheet');

  function sheetHabit() {
    return habits.filter(function (h) { return h.id === sheetHabitId; })[0] || null;
  }

  function openHabitSheet(id) {
    sheetHabitId = id;
    renderHabitSheet();
    habitSheet.classList.add('open');
  }
  function closeHabitSheet() {
    habitSheet.classList.remove('open');
    sheetHabitId = null;
  }

  function renderHabitSheet() {
    var h = sheetHabit();
    if (!h) { closeHabitSheet(); return; }
    var dim = daysInMonth(view.y, view.m);
    var goal = goalFor(h, view.y, view.m);
    var done = doneInMonth(h, view.y, view.m);
    var streak = streakOf(h);

    document.getElementById('sheetTitle').textContent = h.name;
    document.getElementById('sheetMeta').textContent =
      MONTHS[view.m] + ' · ' + done + ' of ' + goal + ' days' +
      (streak > 1 ? ' · ' + streak + '-day streak' : '') +
      (h.source === 'garmin-sleep' ? ' · Garmin' : '');

    var cal = document.getElementById('sheetCal');
    cal.textContent = '';
    DOW.forEach(function (letter) { cal.appendChild(el('div', 'cal-dow', letter)); });

    var firstDow = new Date(view.y, view.m, 1).getDay();
    for (var p = 0; p < firstDow; p++) cal.appendChild(el('div', 'cal-pad'));

    for (var d = 1; d <= dim; d++) {
      var k = K(view.y, view.m, d);
      var isOn = !!h.log[k];
      var cls = 'cal-day' + (isOn ? ' on' : '') +
        (inFuture(view.y, view.m, d) ? ' future' : '') +
        (isToday(view.y, view.m, d) ? ' today' : '');
      var cell = el('button', cls, String(d));
      cell.type = 'button';
      cell.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      cell.setAttribute('aria-label', h.name + ', ' + SHORT_MONTHS[view.m] + ' ' + d + (isOn ? ', done' : ', not done'));
      cell.addEventListener('click', function (habit, key, cellEl) {
        return function () {
          toggle(habit, key);
          // keep the sheet in place while editing days
          renderHabitSheet();
        };
      }(h, k, cell));
      cal.appendChild(cell);
    }
  }

  /* ---------------- toggling ---------------- */
  function toggle(h, k) {
    if (h.log[k]) delete h.log[k];
    else h.log[k] = true;
    h.updatedAt = Date.now();
    buzz(h.log[k] ? 10 : 6);
    save();
    renderCurrentView();
    if (sheetHabitId) renderHabitSheet();
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
    scrim.classList.add('open');
    setTimeout(function () { if (!h) nameInput.focus(); }, 120);
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
    var wasNew = !editingId;

    if (editingId) {
      var id = editingId;
      habits.forEach(function (h) {
        if (h.id === id) {
          h.name = name;
          h.goals[mKey(view.y, view.m)] = goal;
          h.source = source;
          h.updatedAt = Date.now();
        }
      });
    } else {
      var goals = {};
      goals[mKey(view.y, view.m)] = goal;
      habits.push({ id: uid(), name: name, goals: goals, log: {}, source: source, updatedAt: Date.now() });
    }
    save();
    closeEditor();
    renderAll();
    toast(wasNew ? 'Habit added' : 'Saved');
    if (garmin) syncGarmin({ quiet: false });
  }

  function deleteHabit(id) {
    var target = habits.filter(function (h) { return h.id === id; })[0];
    if (!target) return;
    if (!confirm('Delete “' + target.name + '” and its whole history?')) return;
    tombstones.push({ id: id, updatedAt: Date.now() });
    habits = habits.filter(function (h) { return h.id !== id; });
    save();
    closeHabitSheet();
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
        source: name === 'Sleep 7 hours' ? 'garmin-sleep' : null,
        updatedAt: Date.now()
      });
    });
    save();
    renderAll();
    toast('Starter habits added');
    syncGarmin({ quiet: true });
  }

  /* ---------------- Garmin sleep ---------------- */
  function setSyncStatus(text, state) {
    var pill = document.getElementById('syncState');
    if (!pill) return;
    pill.textContent = text;
    pill.setAttribute('data-state', state || 'off');
  }

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
    setSyncStatus('Syncing…', 'busy');
    return fetch(SYNC_URL + '?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var days = (data && data.days) || {};
        if (!Object.keys(days).length) {
          setSyncStatus('No nights yet', 'off');
          return 0;
        }
        var changed = applyGarminDays(days);
        var when = data.generated ? new Date(data.generated) : null;
        var stamp = (when && !isNaN(when.getTime()))
          ? when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Synced';
        setSyncStatus(stamp, 'ok');
        if (changed && !quiet) toast(changed + ' night' + (changed === 1 ? '' : 's') + ' synced');
        return changed;
      })
      .catch(function (err) {
        setSyncStatus('Not connected', 'off');
        if (!quiet) toast('Garmin sync unavailable: ' + err.message);
        return 0;
      });
  }

  /* ---------------- cloud sync ---------------- */
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
  function stampNow() {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function markSynced() {
    try { localStorage.setItem(SYNC_LAST_STORAGE, String(Date.now())); } catch (e) { /* ignore */ }
    setCloudState('Synced · ' + stampNow(), 'ok');
  }
  function schedulePush() {
    if (!hasSync()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushRemote(); }, 1500);
  }

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
      id: newer.id, name: newer.name, goals: goals, log: log,
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
      if (tomb[id] && tomb[id] >= (h.updatedAt || 0)) return;   // delete wins
      merged.push(h);
    });
    var deleted = Object.keys(tomb).map(function (id) { return { id: id, updatedAt: tomb[id] }; });
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
        if (!data || !data.payload) { pushRemote(); return false; }
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
      headers: { Authorization: 'Bearer ' + syncKey(), 'Content-Type': 'application/json' },
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
    var forget = document.getElementById('cloudForget');
    var note = document.getElementById('storageNote');
    if (hasSync()) {
      var last = 0;
      try { last = Number(localStorage.getItem(SYNC_LAST_STORAGE)) || 0; } catch (e) { last = 0; }
      setCloudState(last ? 'Synced · ' + stampNow() : 'Connected', 'ok');
      document.getElementById('cloudBtn').textContent = 'Change key';
      if (nowBtn) nowBtn.hidden = false;
      if (forget) forget.hidden = false;
      if (note) note.textContent = 'Synced through your Cloudflare Worker — every connected device sees the same habits.';
    } else {
      setCloudState('Sync off', 'off');
      document.getElementById('cloudBtn').textContent = 'Connect';
      if (nowBtn) nowBtn.hidden = true;
      if (forget) forget.hidden = true;
      if (note) note.textContent = 'Data is stored in this browser only.';
    }
  }

  var cloudScrim = document.getElementById('cloudScrim');

  function openCloudModal() {
    document.getElementById('cloudKey').value = syncKey();
    cloudScrim.classList.add('open');
    setTimeout(function () { document.getElementById('cloudKey').focus(); }, 120);
  }
  function closeCloudModal() { cloudScrim.classList.remove('open'); }

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
    refreshCloudUI();
    toast('Cloud sync disconnected');
  }

  /* ---------------- views ---------------- */
  function showView(name, opts) {
    var names = ['today', 'month', 'stats', 'settings'];
    if (names.indexOf(name) < 0) name = 'today';
    currentView = name;
    names.forEach(function (n) {
      var section = document.getElementById('view-' + n);
      if (section) section.hidden = (n !== name);
    });
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].dataset.view === name) tabs[i].setAttribute('aria-current', 'page');
      else tabs[i].removeAttribute('aria-current');
    }
    try { localStorage.setItem(VIEW_STORAGE, name); } catch (e) { /* ignore */ }
    renderCurrentView();
    if (!opts || !opts.keepScroll) window.scrollTo({ top: 0 });
  }

  function renderCurrentView() {
    renderMonthLabel();
    if (currentView === 'today') renderToday();
    else if (currentView === 'month') renderMonth();
    else if (currentView === 'stats') renderStats();
  }

  function renderMonthLabel() {
    var btn = document.getElementById('monthLabel');
    btn.textContent = MONTHS[view.m] + ' ' + view.y;
    var t = new Date();
    btn.title = (view.y === t.getFullYear() && view.m === t.getMonth())
      ? 'Showing this month'
      : 'Jump to the current month';
  }

  function renderAll() {
    renderMonthLabel();
    if (currentView === 'today') renderToday();
    if (currentView === 'month') renderMonth();
    if (currentView === 'stats') renderStats();
    if (sheetHabitId) renderHabitSheet();
  }

  function shiftMonth(delta) {
    var m = view.m + delta, y = view.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    view = { y: y, m: m };
    if (currentView === 'today') showView('month');
    else renderCurrentView();
  }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }

  /* ---------------- export / import ---------------- */
  function exportJSON() {
    var blob = new Blob([JSON.stringify({ version: 3, habits: habits, deleted: tombstones }, null, 2)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'habits-' + view.y + '-' + pad2(view.m + 1) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    toast('Backup downloaded');
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
          ? data.deleted.map(function (t) { return { id: String(t.id), updatedAt: Number(t.updatedAt) || 0 }; })
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
    view = { y: now.getFullYear(), m: now.getMonth() };

    document.getElementById('prevMonth').addEventListener('click', function () { shiftMonth(-1); });
    document.getElementById('nextMonth').addEventListener('click', function () { shiftMonth(1); });
    document.getElementById('monthLabel').addEventListener('click', function () {
      var t = new Date();
      if (view.y !== t.getFullYear() || view.m !== t.getMonth()) {
        view = { y: t.getFullYear(), m: t.getMonth() };
        renderCurrentView();
        toast('Back to ' + MONTHS[view.m]);
      }
    });
    document.getElementById('addBtn').addEventListener('click', function () { openEditor(null); });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { showView(tab.dataset.view); });
    });

    document.getElementById('syncBtn').addEventListener('click', function () { syncGarmin({ quiet: false }); });
    document.getElementById('cloudBtn').addEventListener('click', openCloudModal);
    document.getElementById('cloudSyncNow').addEventListener('click', function () { pullRemote().then(function (c) { toast(c ? 'Pulled changes' : 'Up to date'); }); });
    document.getElementById('cloudForget').addEventListener('click', disconnectCloud);
    document.getElementById('cloudCancel').addEventListener('click', closeCloudModal);
    document.getElementById('cloudSave').addEventListener('click', connectCloud);
    cloudScrim.addEventListener('click', function (ev) { if (ev.target === cloudScrim) closeCloudModal(); });
    document.getElementById('cloudKey').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); connectCloud(); }
    });

    document.getElementById('cancelBtn').addEventListener('click', closeEditor);
    document.getElementById('saveBtn').addEventListener('click', commitEditor);
    scrim.addEventListener('click', function (ev) { if (ev.target === scrim) closeEditor(); });
    document.getElementById('nameInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitEditor(); }
    });

    document.getElementById('sheetClose').addEventListener('click', closeHabitSheet);
    document.getElementById('sheetEdit').addEventListener('click', function () {
      var h = sheetHabit();
      closeHabitSheet();
      if (h) openEditor(h);
    });
    document.getElementById('sheetDelete').addEventListener('click', function () {
      if (sheetHabitId) deleteHabit(sheetHabitId);
    });
    habitSheet.addEventListener('click', function (ev) { if (ev.target === habitSheet) closeHabitSheet(); });

    document.getElementById('exportBtn').addEventListener('click', exportJSON);
    document.getElementById('importBtn').addEventListener('click', function () {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', function (ev) {
      importJSON(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeEditor(); closeHabitSheet(); closeCloudModal(); }
    });

    // shadow under the app bar once the content scrolls
    window.addEventListener('scroll', function () {
      var bar = document.querySelector('.appbar');
      if (bar) bar.classList.toggle('scrolled', window.scrollY > 4);
    }, { passive: true });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (currentView === 'stats') renderStats(); }, 180);
    });

    var savedView = 'today';
    try { savedView = localStorage.getItem(VIEW_STORAGE) || 'today'; } catch (e) { /* ignore */ }

    load();
    showView(savedView, { keepScroll: true });
    refreshCloudUI();
    if (hasSync()) pullRemote();
    syncGarmin({ quiet: true });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        renderAll();                      // day rollover while open
        if (hasSync()) pullRemote();
      }
    });

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0 &&
        location.hostname !== '127.0.0.1') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache optional */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
