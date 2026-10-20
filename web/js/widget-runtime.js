// Runs inside every widget frame (sandboxed, no same-origin, no network). Gives widget code the `ob` object and
// reports how the widget is doing, so the assistant can see its own mistakes and fix them.
(() => {
  'use strict';
  const up = window.parent;
  const send = (msg) => up.postMessage({ __ob: 1, ...msg }, '*');
  const pending = new Map();
  const resizeFns = new Set();
  const stateFns = new Set();
  const loops = new Set();
  let seq = 0;
  let started = false;
  let readySent = false;
  let readyTimer = 0;
  let firstFetchDone = false;
  let fetchesInFlight = 0;
  let errorsSent = 0;
  let lastErrorAt = 0;
  let visible = true;
  let needsKey = null;

  const ob = {
    id: '', title: '', mode: 'edit', size: { w: innerWidth, h: innerHeight }, state: {}, theme: {},

    /** Fetch through the Pi. {{KEY}} placeholders in the URL or headers are filled in there, never here. */
    fetch(url, opts = {}) {
      return new Promise((resolve, reject) => {
        const rid = ++seq;
        fetchesInFlight++;
        pending.set(rid, { resolve, reject, as: opts.as === 'text' ? 'text' : 'json' });
        send({ type: 'fetch', rid, url: String(url), headers: opts.headers || {}, cache: opts.cache ?? 10 });
      });
    },

    /** Run fn now and every `seconds` (min 10). Skips runs while the widget is off screen. */
    every(seconds, fn) {
      const ms = Math.max(10, Number(seconds) || 60) * 1000;
      const loop = { ms, fn, last: 0, timer: 0 };
      const tick = async () => {
        if (!visible) return;
        loop.last = Date.now();
        try { await fn(); } catch (e) { fail(e); }
      };
      loop.tick = tick;
      loop.timer = setInterval(tick, ms);
      loops.add(loop);
      tick();
      return () => { clearInterval(loop.timer); loops.delete(loop); };
    },

    setState(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(ob.state, patch);
      send({ type: 'state', state: ob.state });
    },
    onState(fn) { stateFns.add(fn); return () => stateFns.delete(fn); },
    onResize(fn) { resizeFns.add(fn); return () => resizeFns.delete(fn); },
    log(...args) { send({ type: 'report', level: 'log', message: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 500) }); },
  };
  window.ob = ob;

  // ------------------------------------------------------------------ kit: small helpers that make widgets look right

  const minus = '−';
  ob.kit = {
    fmt: {
      /** $1,234.56 (small prices keep more digits, e.g. $0.004213). */
      money(n, currency = 'USD') {
        const v = Number(n);
        const digits = Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 6;
        try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v); } catch { return `${v.toFixed(digits)} ${currency}`; }
      },
      num: (n, dp = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }),
      /** +1.23 / −0.45 with a real minus sign. */
      signed: (n, dp = 2) => `${n >= 0 ? '+' : minus}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`,
      pct: (n, dp = 2) => `${n >= 0 ? '+' : minus}${Math.abs(n).toFixed(dp)}%`,
      compact: (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n),
      time: (d, opts = {}) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...opts }),
      date: (d, opts = {}) => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', ...opts }),
      ago(d) {
        const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
        return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
      },
    },
    /** Set an element's text (and optionally its class) by selector. */
    set(sel, text, cls) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return;
      el.textContent = text;
      if (cls !== undefined) el.className = cls;
    },
    /**
     * A calm line chart in the board's style: thin line, soft fill, few ticks, no legend, prices on the right.
     * Returns { chart, update(labels, values, color) }.
     */
    lineChart(canvas, { labels = [], values = [], color, fill = true, yRight = true, ticks = 4, tooltips = true } = {}) {
      const t = ob.theme;
      const c0 = color || t.accent;
      const chart = new window.Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: values, borderColor: c0, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.25, fill,
            backgroundColor: (ctx) => {
              const col = ctx.chart.data.datasets[0].borderColor;
              const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 200);
              g.addColorStop(0, /^#[0-9a-f]{6}$/i.test(col) ? `${col}55` : 'rgba(86,137,186,0.3)');
              g.addColorStop(1, /^#[0-9a-f]{6}$/i.test(col) ? `${col}00` : 'rgba(86,137,186,0)');
              return g;
            },
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { display: false }, tooltip: { enabled: tooltips && ob.mode !== 'tv', displayColors: false } },
          scales: {
            x: { ticks: { color: t.muted, maxTicksLimit: ticks, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false }, border: { display: false } },
            y: { position: yRight ? 'right' : 'left', ticks: { color: t.muted, maxTicksLimit: ticks }, grid: { color: t.grid }, border: { display: false } },
          },
        },
      });
      return {
        chart,
        update(nextLabels, nextValues, nextColor) {
          chart.data.labels = nextLabels;
          chart.data.datasets[0].data = nextValues;
          if (nextColor) chart.data.datasets[0].borderColor = nextColor;
          chart.update('none');
        },
      };
    },
    /** Plain-words description of a WMO weather code (used by Open-Meteo). */
    weather(code) {
      const c = Number(code);
      if (c === 0) return 'Clear';
      if (c === 1) return 'Mostly clear';
      if (c === 2) return 'Partly cloudy';
      if (c === 3) return 'Overcast';
      if (c === 45 || c === 48) return 'Fog';
      if (c >= 51 && c <= 57) return 'Drizzle';
      if (c >= 61 && c <= 67) return c >= 66 ? 'Freezing rain' : c >= 65 ? 'Heavy rain' : 'Rain';
      if (c >= 71 && c <= 77) return 'Snow';
      if (c >= 80 && c <= 82) return 'Showers';
      if (c === 85 || c === 86) return 'Snow showers';
      if (c >= 95) return 'Thunderstorm';
      return 'Mixed';
    },
  };

  function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

  // ------------------------------------------------------------------ status messages

  function message(kind, title, sub) {
    let el = document.querySelector('.ob-msg');
    if (!el) { el = document.createElement('div'); el.className = 'ob-msg'; document.body.append(el); }
    el.className = `ob-msg ${kind}`;
    el.innerHTML = '<i></i><b></b><span></span>';
    el.querySelector('b').textContent = title;
    el.querySelector('span').textContent = sub || '';
  }
  function clearMessage() { document.querySelector('.ob-msg')?.remove(); }

  function bar(text) {
    let el = document.querySelector('.ob-bar');
    if (!text) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'ob-bar'; document.body.append(el); }
    el.textContent = text;
  }

  function visibleText() {
    const t = (document.getElementById('ob-root')?.innerText || '').replace(/\s+/g, ' ').trim();
    const charts = document.querySelectorAll('canvas').length;
    return (t + (charts ? ` [${charts} chart${charts > 1 ? 's' : ''}]` : '')).slice(0, 400);
  }

  function fail(err) {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeJson(err));
    if (e.code === 'needs_key') {
      if (needsKey !== e.key) {
        needsKey = e.key;
        message('', 'Waiting for an API key', `Add ${e.key} in the O Board app. This widget starts by itself once it is saved.`);
        send({ type: 'report', level: 'needs_key', message: e.key });
      }
      return;
    }
    // Point at the widget's own code; a location inside this runtime (e.g. a failed ob.fetch) would only mislead.
    const where = e.stack ? (e.stack.split('\n').find((l) => /:\d+:\d+/.test(l) && !/widget-runtime\.js|chart\.umd/.test(l)) || '').trim() : '';
    const msg = `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}${where ? ` (${where.replace(/^at\s+/, '').slice(0, 120)})` : ''}`;
    const now = Date.now();
    if (errorsSent < 3 || now - lastErrorAt > 30_000) {
      errorsSent++;
      lastErrorAt = now;
      send({ type: 'report', level: 'error', message: msg.slice(0, 600) });
    }
    if (!readySent) message('err', 'This widget hit a problem', 'Ask the assistant to fix it.');
    else bar(`Couldn't update: ${e.message}`.slice(0, 140));
  }

  window.addEventListener('error', (ev) => { ev.preventDefault?.(); fail(ev.error || new Error(ev.message || 'Script error')); });
  window.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); fail(ev.reason); });

  function markReadySoon(ms) {
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (readySent || needsKey || document.querySelector('.ob-msg.err')) return;
      readySent = true;
      send({ type: 'report', level: 'ready', text: visibleText() });
    }, ms);
  }

  // ------------------------------------------------------------------ messages from the board page

  window.addEventListener('message', (ev) => {
    if (ev.source !== up) return;
    const m = ev.data;
    if (!m || !m.__ob) return;
    switch (m.type) {
      case 'init': start(m); break;
      case 'fetch:result': {
        const p = pending.get(m.rid);
        if (!p) return;
        pending.delete(m.rid);
        fetchesInFlight--;
        if (m.error) {
          const e = new Error(m.error);
          e.code = m.code; e.key = m.key;
          p.reject(e);
          return;
        }
        if (!m.ok) { p.reject(Object.assign(new Error(`HTTP ${m.status} from ${host(m.url)}: ${String(m.body || '').slice(0, 160)}`), { status: m.status })); return; }
        let value = m.body;
        if (p.as === 'json') {
          try { value = JSON.parse(m.body); } catch { p.reject(new Error(`Expected JSON from ${host(m.url)} but got: ${String(m.body).slice(0, 120)}`)); return; }
        }
        if (needsKey) { needsKey = null; clearMessage(); }
        bar('');
        p.resolve(value);
        if (!firstFetchDone) { firstFetchDone = true; markReadySoon(500); }
        break;
      }
      case 'resize':
        ob.size = { w: m.w, h: m.h };
        for (const fn of resizeFns) { try { fn(ob.size); } catch (e) { fail(e); } }
        break;
      case 'state':
        ob.state = m.state || {};
        for (const fn of stateFns) { try { fn(ob.state); } catch (e) { fail(e); } }
        break;
      case 'visible': {
        const was = visible;
        visible = !!m.on;
        if (visible && !was) for (const l of loops) if (Date.now() - l.last >= l.ms) l.tick();
        break;
      }
      default: break;
    }
  });

  function host(u) { try { return new URL(u).hostname; } catch { return 'the server'; } }

  function start(m) {
    if (started) return;
    started = true;
    Object.assign(ob, { id: m.id, title: m.title || '', mode: m.mode || 'edit', state: m.state || {}, size: { w: m.w, h: m.h }, theme: m.theme || {} });
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(ob.theme)) if (typeof v === 'string') root.setProperty(`--${k}`, v);
    document.title = ob.title;

    const tpl = document.createElement('template');
    tpl.innerHTML = String(m.html || '');
    const scripts = [...tpl.content.querySelectorAll('script')];
    for (const s of scripts) s.remove();
    document.getElementById('ob-root').append(tpl.content);
    for (const s of scripts) {
      const code = s.textContent;
      const el = document.createElement('script');
      // Classic scripts keep global functions working for onclick="..."; top-level await needs a module instead.
      if (s.type === 'module' || needsModule(code)) el.type = 'module';
      el.textContent = code;
      document.body.append(el);
    }
    // No data requested within a moment: it is a self-contained widget (timer, calculator...).
    setTimeout(() => { if (!fetchesInFlight && !firstFetchDone) markReadySoon(300); }, 1200);
  }

  function needsModule(code) {
    try { new Function(code); return false; } catch (e) {
      if (!(e instanceof SyntaxError)) return false;
      try { new (Object.getPrototypeOf(async () => {}).constructor)(code); return true; } catch { return false; }
    }
  }

  send({ type: 'hello' });
})();
