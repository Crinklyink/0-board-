// Ready-made widgets, shared by the Pi (the assistant's add_widget tool) and the board (the Add widget picker).
// Each template is plain code that runs inside the widget frame with the `ob` runtime; its settings are passed in as P.
// The `main` functions are serialised with toString(), so they must not use anything from this module's scope.

export class TemplateError extends Error {}

const text = (max, { required = false, pattern = null, upper = false, hint = '' } = {}) => ({ kind: 'text', max, required, pattern, upper, hint });
const choice = (options, def) => ({ kind: 'choice', options, def });
const number = (min, max, def) => ({ kind: 'number', min, max, def });

// ---------------------------------------------------------------------------------------------------- stock

function stockMain(P) {
  const { fmt, set, lineChart } = ob.kit;
  const INTERVAL = { '1d': '5m', '5d': '30m', '1mo': '1d', '6mo': '1d', '1y': '1wk' };
  const RANGE = { '1d': 'today', '5d': '5 days', '1mo': '1 month', '6mo': '6 months', '1y': '1 year' };
  set('#sym', P.symbol);
  set('#range', `Yahoo Finance · ${RANGE[P.range]}`);
  let chart = null;
  ob.every(P.range === '1d' ? 60 : 900, async () => {
    const d = await ob.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(P.symbol)}?range=${P.range}&interval=${INTERVAL[P.range]}`, { cache: 60 });
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) throw new Error((d && d.chart && d.chart.error && d.chart.error.description) || `No data for ${P.symbol}`);
    const m = r.meta;
    const closes = (r.indicators.quote[0] || {}).close || [];
    const pts = (r.timestamp || []).map((t, i) => [t, closes[i]]).filter((p) => p[1] != null);
    const price = m.regularMarketPrice;
    const base = P.range === '1d' ? (m.chartPreviousClose ?? m.previousClose ?? price) : (pts.length ? pts[0][1] : price);
    const diff = price - base;
    const up = diff >= 0;
    set('#name', m.longName || m.shortName || m.fullExchangeName || '');
    set('#price', fmt.money(price, m.currency || 'USD'));
    set('#delta', `${fmt.signed(diff)} (${fmt.pct(base ? (diff / base) * 100 : 0)})`, `kit-delta ${up ? 'up' : 'down'}`);
    const period = m.currentTradingPeriod && m.currentTradingPeriod.regular;
    const now = Date.now() / 1000;
    const open = !!period && now >= period.start && now < period.end;
    set('#state', open ? 'Market open' : 'Market closed');
    document.getElementById('dot').className = open ? 'dot' : 'dot off';
    set('#when', fmt.time(Date.now()));
    const labels = pts.map((x) => (P.range === '1d' ? fmt.time(x[0] * 1000) : fmt.date(x[0] * 1000)));
    const color = up ? ob.theme.up : ob.theme.down;
    if (!chart) chart = lineChart(document.getElementById('chart'), { color });
    chart.update(labels, pts.map((x) => x[1]), color);
  });
}

const PRICE_MARKUP = `<div class="kit">
  <div class="kit-head"><span class="kit-title" id="sym"></span><span class="kit-sub" id="name"></span></div>
  <div class="kit-row"><span class="kit-big" id="price">—</span><span class="kit-delta" id="delta"></span></div>
  <div class="kit-chart"><canvas id="chart"></canvas></div>
  <div class="kit-foot"><span><i class="dot off" id="dot"></i><span id="state">Loading…</span> · <span id="when"></span></span><span id="range"></span></div>
</div>`;

// ---------------------------------------------------------------------------------------------------- crypto

function cryptoMain(P) {
  const { fmt, set, lineChart } = ob.kit;
  const KNOWN = {
    btc: ['bitcoin', 'Bitcoin'], eth: ['ethereum', 'Ethereum'], sol: ['solana', 'Solana'], doge: ['dogecoin', 'Dogecoin'],
    ada: ['cardano', 'Cardano'], xrp: ['ripple', 'XRP'], bnb: ['binancecoin', 'BNB'], ltc: ['litecoin', 'Litecoin'],
    dot: ['polkadot', 'Polkadot'], avax: ['avalanche-2', 'Avalanche'], link: ['chainlink', 'Chainlink'], trx: ['tron', 'TRON'],
    ton: ['the-open-network', 'Toncoin'], shib: ['shiba-inu', 'Shiba Inu'], xlm: ['stellar', 'Stellar'], atom: ['cosmos', 'Cosmos'],
  };
  const vs = P.currency.toLowerCase();
  const known = KNOWN[P.coin.toLowerCase()] || Object.values(KNOWN).find((k) => k[0] === P.coin.toLowerCase());
  let id = known ? known[0] : null;
  set('#sym', known ? Object.keys(KNOWN).find((k) => KNOWN[k] === known).toUpperCase() : P.coin.toUpperCase());
  set('#name', known ? known[1] : '');
  set('#range', `CoinGecko · ${P.days === 1 ? '24 hours' : `${P.days} days`}`);
  let chart = null;
  ob.every(120, async () => {
    if (!id) {
      const s = await ob.fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(P.coin)}`, { cache: 86400 });
      const hit = (s.coins || [])[0];
      if (!hit) throw new Error(`CoinGecko does not know "${P.coin}"`);
      id = hit.id;
      set('#sym', String(hit.symbol || P.coin).toUpperCase());
      set('#name', hit.name || '');
    }
    const [q, h] = await Promise.all([
      ob.fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}&include_24hr_change=true`, { cache: 60 }),
      ob.fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=${P.days}`, { cache: 300 }),
    ]);
    const row = q[id];
    if (!row || row[vs] == null) throw new Error(`No ${vs.toUpperCase()} price for ${id}`);
    const change = row[`${vs}_24h_change`] || 0;
    const up = change >= 0;
    set('#price', fmt.money(row[vs], vs.toUpperCase()));
    set('#delta', `${fmt.pct(change)} 24h`, `kit-delta ${up ? 'up' : 'down'}`);
    set('#state', 'Live');
    document.getElementById('dot').className = 'dot';
    set('#when', fmt.time(Date.now()));
    const pts = h.prices || [];
    const color = up ? ob.theme.up : ob.theme.down;
    if (!chart) chart = lineChart(document.getElementById('chart'), { color });
    chart.update(pts.map((p) => (P.days === 1 ? fmt.time(p[0]) : fmt.date(p[0]))), pts.map((p) => p[1]), color);
  });
}

// ---------------------------------------------------------------------------------------------------- weather

function weatherMain(P) {
  const { set, weather, fmt } = ob.kit;
  const F = P.units === 'fahrenheit';
  let place = null;
  ob.every(900, async () => {
    if (!place) {
      const g = await ob.fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(P.place)}&count=1&language=en&format=json`, { cache: 86400 });
      place = (g.results || [])[0];
      if (!place) throw new Error(`Could not find a place called "${P.place}"`);
      set('#place', place.name);
      set('#region', [place.admin1, place.country].filter(Boolean).join(', '));
    }
    const unit = F ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '';
    const d = await ob.fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5${unit}`, { cache: 600 });
    const c = d.current;
    set('#temp', `${Math.round(c.temperature_2m)}°`);
    set('#cond', weather(c.weather_code));
    set('#feels', `Feels like ${Math.round(c.apparent_temperature)}° · Wind ${Math.round(c.wind_speed_10m)} ${F ? 'mph' : 'km/h'} · Humidity ${c.relative_humidity_2m}%`);
    const days = document.getElementById('days');
    days.textContent = '';
    d.daily.time.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'kit-tile';
      for (const [cls, txt] of [['day', i === 0 ? 'Today' : new Date(`${t}T12:00`).toLocaleDateString([], { weekday: 'short' })],
        ['muted', weather(d.daily.weather_code[i])], ['hl', `${Math.round(d.daily.temperature_2m_max[i])}° ${Math.round(d.daily.temperature_2m_min[i])}°`]]) {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = txt;
        el.append(s);
      }
      days.append(el);
    });
    set('#when', `Updated ${fmt.time(Date.now())} · Open-Meteo`);
  });
}

// ---------------------------------------------------------------------------------------------------- clock

function clockMain(P) {
  const { set } = ob.kit;
  const main = P.zones[0] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const city = (z) => z.split('/').pop().replace(/_/g, ' ');
  const list = document.getElementById('zones');
  const rows = P.zones.slice(1).map((z) => {
    const el = document.createElement('div');
    el.className = 'zone';
    const a = document.createElement('span');
    a.className = 'muted';
    a.textContent = city(z);
    const b = document.createElement('b');
    el.append(a, b);
    list.append(el);
    return [z, b];
  });
  const f = (z, o) => new Intl.DateTimeFormat([], { timeZone: z, ...o });
  const hm = f(main, { hour: 'numeric', minute: '2-digit' });
  const sec = f(main, { second: '2-digit' });
  const day = f(main, { weekday: 'long', month: 'long', day: 'numeric' });
  const tick = () => {
    const now = new Date();
    set('#time', hm.format(now));
    set('#sec', sec.format(now).padStart(2, '0'));
    set('#date', day.format(now));
    for (const [z, el] of rows) el.textContent = f(z, { hour: 'numeric', minute: '2-digit', weekday: 'short' }).format(now);
  };
  set('#zone', P.zones[0] ? city(main) : '');
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------------------------------- countdown

function countdownMain(P) {
  const { set } = ob.kit;
  const target = new Date(P.date).getTime();
  const when = new Date(target).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  set('#label', P.label);
  const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  const tick = () => {
    let left = Math.round((target - Date.now()) / 1000);
    const past = left < 0;
    left = Math.abs(left);
    for (const [k, s] of units) {
      set(`#${k}`, String(Math.floor(left / s)).padStart(k === 'd' ? 1 : 2, '0'));
      left %= s;
    }
    set('#status', `${past ? 'since' : 'until'} ${when}`);
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------------------------------- timer

function timerMain(P) {
  const { set } = ob.kit;
  const total = Math.round(P.minutes * 60);
  // Shared by every screen through ob.state: { endsAt } while running, { left } while paused.
  const left = () => (ob.state.endsAt ? Math.max(0, Math.round((ob.state.endsAt - Date.now()) / 1000)) : (ob.state.left ?? total));
  const go = document.getElementById('go');
  const render = () => {
    const l = left();
    const running = !!ob.state.endsAt && l > 0;
    set('#t', `${Math.floor(l / 60)}:${String(l % 60).padStart(2, '0')}`);
    go.textContent = running ? 'Pause' : l === 0 ? 'Again' : l < total ? 'Resume' : 'Start';
    document.body.classList.toggle('done', l === 0);
    document.getElementById('bar').style.width = `${Math.min(100, (1 - l / total) * 100)}%`;
  };
  go.onclick = () => {
    const l = left();
    if (ob.state.endsAt && l > 0) ob.setState({ endsAt: null, left: l });
    else ob.setState({ endsAt: Date.now() + (l === 0 ? total : l) * 1000, left: null });
    render();
  };
  document.getElementById('reset').onclick = () => { ob.setState({ endsAt: null, left: total }); render(); };
  set('#label', P.label || `${P.minutes} minute timer`);
  ob.onState(render);
  render();
  setInterval(render, 250);
}

// ---------------------------------------------------------------------------------------------------- registry

export const WIDGET_TEMPLATES = {
  stock: {
    label: 'Stock', description: 'Live price and chart for a stock, ETF or index (Yahoo Finance, no key needed).',
    params: { symbol: text(15, { required: true, pattern: /^[A-Za-z0-9.^=-]{1,15}$/, upper: true, hint: 'NVDA' }), range: choice(['1d', '5d', '1mo', '6mo', '1y'], '1d') },
    size: [440, 300], title: (p) => `${p.symbol} live`, markup: PRICE_MARKUP, css: '', main: stockMain,
  },
  crypto: {
    label: 'Crypto', description: 'Live price and chart for a cryptocurrency (CoinGecko, no key needed).',
    params: { coin: text(40, { required: true, pattern: /^[A-Za-z0-9 .-]{1,40}$/, hint: 'BTC' }), currency: choice(['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud'], 'usd'), days: choice([1, 7, 30], 1) },
    size: [440, 300], title: (p) => `${p.coin.toUpperCase()} live`, markup: PRICE_MARKUP, css: '', main: cryptoMain,
  },
  weather: {
    label: 'Weather', description: 'Current weather and a 5-day forecast for a place (Open-Meteo, no key needed).',
    params: { place: text(80, { required: true, hint: 'London' }), units: choice(['celsius', 'fahrenheit'], 'celsius') },
    size: [460, 300], title: (p) => `Weather · ${p.place.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`,
    markup: `<div class="kit">
  <div class="kit-head"><span class="kit-title" id="place">…</span><span class="kit-sub" id="region"></span></div>
  <div class="kit-row now"><span class="kit-big" id="temp">—</span><span class="kit-mid" id="cond"></span></div>
  <div class="kit-sub" id="feels"></div>
  <div class="kit-grid days" id="days"></div>
  <div class="kit-foot"><span id="when">Loading…</span></div>
</div>`,
    css: '.now{gap:14px;margin-top:2px}.days{grid-template-columns:repeat(5,minmax(0,1fr));margin-top:auto}.days .kit-tile{display:flex;flex-direction:column;gap:2px;font-size:clamp(10px,2.6vw,12.5px);overflow:hidden}.days .day{font-weight:600}.days .muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.days .hl{font-variant-numeric:tabular-nums}',
    main: weatherMain,
  },
  clock: {
    label: 'Clock', description: 'The time, with optional extra time zones.',
    params: { zones: { kind: 'zones', hint: 'Europe/London, Asia/Tokyo' } },
    size: [360, 230], title: (p) => (p.zones.length ? `Clock · ${p.zones[0].split('/').pop().replace(/_/g, ' ')}` : 'Clock'),
    markup: `<div class="kit">
  <div class="kit-head"><span class="kit-title" id="zone"></span><span class="kit-sub" id="date"></span></div>
  <div class="kit-row t"><span class="kit-big" id="time">—</span><span class="kit-mid muted" id="sec"></span></div>
  <div id="zones" class="zones"></div>
</div>`,
    css: '.t{margin-top:auto;margin-bottom:auto}.t .kit-big{font-size:clamp(34px,15vw,96px)}.zones{display:grid;gap:4px;margin-top:6px}.zone{display:flex;justify-content:space-between;font-size:clamp(12px,3.4vw,15px)}',
    main: clockMain,
  },
  countdown: {
    label: 'Countdown', description: 'Days, hours and minutes to (or since) a date.',
    params: { label: text(60, { required: true, hint: 'Launch day' }), date: { kind: 'datetime', required: true, hint: '2026-12-25' } },
    size: [440, 230], title: (p) => p.label,
    markup: `<div class="kit">
  <div class="kit-head"><span class="kit-title" id="label"></span></div>
  <div class="kit-grid cd"><div class="kit-tile"><b id="d">0</b><span>days</span></div><div class="kit-tile"><b id="h">00</b><span>hours</span></div><div class="kit-tile"><b id="m">00</b><span>min</span></div><div class="kit-tile"><b id="s">00</b><span>sec</span></div></div>
  <div class="kit-foot"><span id="status"></span></div>
</div>`,
    css: '.cd{grid-template-columns:repeat(4,minmax(0,1fr));margin:auto 0}.cd .kit-tile{display:flex;flex-direction:column;align-items:center;padding:10px 4px}.cd b{font-size:clamp(22px,8vw,48px);font-weight:600;font-variant-numeric:tabular-nums}.cd span{color:var(--muted);font-size:clamp(10px,2.8vw,13px)}',
    main: countdownMain,
  },
  timer: {
    label: 'Timer', description: 'A countdown timer with start, pause and reset, shared by every screen.',
    params: { minutes: number(1, 600, 25), label: text(60, { hint: 'Focus' }) },
    size: [320, 260], title: (p) => p.label || `${p.minutes} min timer`,
    markup: `<div class="kit">
  <div class="kit-head"><span class="kit-title" id="label"></span></div>
  <div class="kit-big tm" id="t">0:00</div>
  <div class="track"><i id="bar"></i></div>
  <div class="kit-row btns"><button id="go">Start</button><button id="reset">Reset</button></div>
</div>`,
    css: '.tm{margin:auto 0 8px;font-size:clamp(40px,20vw,110px);text-align:center;font-variant-numeric:tabular-nums}.track{height:5px;border-radius:3px;background:var(--surface-hi);overflow:hidden}.track i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s linear}.btns{justify-content:center;margin-top:12px}.btns button{min-width:84px}.done .tm{color:var(--up);animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}',
    main: timerMain,
  },
};

export const TEMPLATE_NAMES = Object.keys(WIDGET_TEMPLATES);

/** Check and complete a template's settings. Throws TemplateError with a sentence a person (or the model) can act on. */
export function normalizeParams(name, raw = {}) {
  const t = WIDGET_TEMPLATES[name];
  if (!t) throw new TemplateError(`Unknown widget template "${name}". Choose one of: ${TEMPLATE_NAMES.join(', ')}`);
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, spec] of Object.entries(t.params)) {
    let v = input[key];
    if (spec.kind === 'text') {
      v = v == null ? '' : String(v).trim();
      if (spec.upper) v = v.toUpperCase();
      if (!v) {
        if (spec.required) throw new TemplateError(`${t.label} widget needs "${key}" (for example ${spec.hint})`);
        out[key] = '';
        continue;
      }
      if (v.length > spec.max) throw new TemplateError(`"${key}" is too long (max ${spec.max} characters)`);
      if (spec.pattern && !spec.pattern.test(v)) throw new TemplateError(`"${v}" is not a valid ${key} (for example ${spec.hint})`);
      out[key] = v;
    } else if (spec.kind === 'choice') {
      if (v == null || v === '') v = spec.def;
      const hit = spec.options.find((o) => String(o) === String(v).toLowerCase());
      if (hit === undefined) throw new TemplateError(`"${key}" must be one of: ${spec.options.join(', ')}`);
      out[key] = hit;
    } else if (spec.kind === 'number') {
      const n = v == null || v === '' ? spec.def : Number(v);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new TemplateError(`"${key}" must be a number from ${spec.min} to ${spec.max}`);
      out[key] = Math.round(n * 100) / 100;
    } else if (spec.kind === 'zones') {
      const list = (Array.isArray(v) ? v : String(v || '').split(',')).map((z) => String(z).trim()).filter(Boolean).slice(0, 6);
      for (const z of list) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: z }); } catch { throw new TemplateError(`"${z}" is not a time zone. Use names like America/New_York or Asia/Tokyo.`); }
      }
      out[key] = list;
    } else if (spec.kind === 'datetime') {
      let s = String(v || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00'; // a plain date means local midnight, not UTC
      if (!s || Number.isNaN(Date.parse(s))) throw new TemplateError(`"${key}" must be a date like 2026-12-25 or 2026-12-25T09:30`);
      out[key] = s.slice(0, 40);
    }
  }
  return out;
}

// Settings are embedded in a <script>: escape "<" (so a "</script>" in a label cannot end it early) and the two
// characters JavaScript treats as line breaks. BS is a backslash, built from its code so no tool can swallow it.
const BS = String.fromCharCode(92);
const scriptJson = (v) => JSON.stringify(v)
  .split("<").join(BS + "u003c")
  .split(String.fromCharCode(0x2028)).join(BS + "u2028")
  .split(String.fromCharCode(0x2029)).join(BS + "u2029");

/** Everything needed for a widget object: { title, html, w, h, template, params }. */
export function buildWidget(name, raw) {
  const t = WIDGET_TEMPLATES[name];
  const params = normalizeParams(name, raw);
  const extraRows = name === 'clock' ? Math.max(0, params.zones.length - 1) : 0;
  const html = `${t.css ? `<style>${t.css}</style>\n` : ''}${t.markup}\n<script>\n(${t.main.toString()})(${scriptJson(params)});\n</script>`;
  return { title: t.title(params).slice(0, 200), html, w: t.size[0], h: t.size[1] + extraRows * 26, template: name, params };
}

/** For the model's tool description and the picker: what each template needs. */
export function templateGuide() {
  return Object.entries(WIDGET_TEMPLATES).map(([name, t]) => {
    const ps = Object.entries(t.params).map(([k, s]) => {
      if (s.kind === 'choice') return `${k}: one of ${s.options.join('/')} (default ${s.def})`;
      if (s.kind === 'number') return `${k}: ${s.min}-${s.max} (default ${s.def})`;
      if (s.kind === 'zones') return `${k}: optional list of IANA time zones, first is the main one`;
      if (s.kind === 'datetime') return `${k}: date or date-time, e.g. 2026-12-25T09:30 (local time)`;
      return `${k}${s.required ? '' : ' (optional)'}: e.g. ${s.hint}`;
    }).join('; ');
    return `${name}: ${t.description} Params: ${ps}.`;
  }).join('\n');
}
