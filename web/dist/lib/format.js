// web/dist/lib/format.js — pure number/time formatting. No DOM.
// fmtInt, fmtUSD, fmtFull, shortProject, relTime, ago are copied verbatim from
// the <script> block of the original web/dist/index.html — they were already
// pure, just inlined there.
import { t, locale } from './i18n.js';

export const fmtInt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};
/** DEFAULT_CURRENCY mirrors store.DefaultCurrency in Go: what an amount is in
 *  when nothing says otherwise. */
export const DEFAULT_CURRENCY = 'USD';

// One formatter per (locale, currency). Intl.NumberFormat is expensive to
// build and these are rebuilt per cell otherwise.
const money = new Map();
function moneyFormat(currency) {
  const loc = locale();
  const key = loc + '|' + currency;
  let f = money.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(loc, {
        style: 'currency', currency,
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    } catch {
      // An unrecognised currency code throws rather than degrading. A figure
      // with an odd code must still render — as the number and the code,
      // which is strictly more honest than stamping a dollar sign on it.
      f = {
        format: (n) => (Number(n) || 0).toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          + ' ' + currency,
      };
    }
    money.set(key, f);
  }
  return f;
}

/** fmtMoney renders an amount IN THE CURRENCY IT WAS BILLED IN, formatted for
 *  the viewer's locale.
 *
 *  It converts nothing, and that is deliberate rather than unfinished. Go's
 *  api.RealSpendOver already refuses to add two currencies together — it reports
 *  the total as incomplete instead ("this hub does no currency conversion") —
 *  because a converted figure is money nobody was charged, at a rate nobody
 *  reviewed. The same rule has to hold on the way out: showing a Chinese reader
 *  ¥611 for an $85.75 invoice would invent both the number and the rate.
 *
 *  What DOES follow the locale is the rendering: grouping, decimal mark, and
 *  where the symbol sits. A zh-CN viewer sees "US$85.75" rather than "$85.75",
 *  which says which dollar — and a deployment that bills in CNY finally gets
 *  "¥46.00" instead of the "$46.00" this function used to print for it. */
export const fmtMoney = (n, currency) => moneyFormat(currency || DEFAULT_CURRENCY).format(Number(n) || 0);

/** fmtUSD is fmtMoney for the `cost_usd` column, which is USD by construction:
 *  every rate table resolves to USD at ingest (the gateway's own CNY rates are
 *  converted once, at a pinned and human-reviewed rate, and STORED as USD). A
 *  figure that carries its own currency — real spend, a subscription plan —
 *  must use fmtMoney and pass it. */
export const fmtUSD = (n) => fmtMoney(n, DEFAULT_CURRENCY);
// Aggregates retain the known subtotal and a separate missing-price count.
// A wholly unpriced bucket is unknown; a partial subtotal is a lower bound.
export const fmtCost = (b) => {
  if (b.cost_usd == null) return '—';
  if (b.unpriced_events > 0) {
    const count = b.events ?? b.turns;
    if (count > 0 && b.unpriced_events >= count) return '—';
    return '≥ ' + fmtUSD(b.cost_usd);
  }
  return fmtUSD(b.cost_usd);
};
export const fmtFull = (n) => (Number(n) || 0).toLocaleString();

/** shortProject trims a working directory to its last two segments. Full paths
 *  are long, and on a shared hub they leak more than they inform. */
export const shortProject = (p) => {
  if (!p) return t('common.unknown');
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  // Two segments where they fit, one where they do not. What distinguishes
  // sibling worktrees is the LAST segment, so it must never be the part that
  // gets clipped — otherwise every row reads "…/projects/24haowan-monorepo…".
  const two = parts.slice(-2).join("/");
  return "…/" + (two.length <= 30 ? two : parts[parts.length - 1]);
};

export const relTime = (iso) => {
  if (!iso) return t('reset.unknown');
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return t('reset.now');
  const m = Math.round(ms / 60000);
  if (m < 60) return t('reset.minutes', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('reset.hours', { h, m: m % 60 });
  return t('reset.days', { d: Math.floor(h / 24), h: h % 24 });
};

export const ago = (secs) => {
  if (secs == null) return "";
  if (secs < 90) return t('ago.seconds', { n: Math.round(secs) });
  if (secs < 5400) return t('ago.minutes', { n: Math.round(secs / 60) });
  return t('ago.hours', { n: Math.round(secs / 3600) });
};

export const fmtPct = (x, digits = 1) => (Number(x) * 100).toFixed(digits) + '%';
export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
// A delta against a near-zero (but not exactly zero, which `delta` below
// already renders as "no previous data") baseline is technically defined
// but carries no information beyond "there was almost nothing before" — and
// on real data has been wide enough (measured: "+295242%") to force its own
// layout wider than the column it lives in. DELTA_CAP_PCT is the magnitude
// past which the exact number stops being worth rendering; `pct` on the
// returned object is always the real, uncapped value (its SIGN still drives
// kpiTile's up/down colouring either way), only `text` is capped.
export const DELTA_CAP_PCT = 999;

// delta compares two additive values. null pct means "no previous data".
export function delta(cur, prev) {
  if (!prev || !Number.isFinite(prev)) return { pct: null, text: '—' };
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct > 0 ? '+' : '';
  if (Math.abs(pct) >= DELTA_CAP_PCT) return { pct, text: `${sign}≫${DELTA_CAP_PCT}%` };
  return { pct, text: `${sign}${Math.abs(pct) >= 10 ? Math.round(pct) : pct.toFixed(1)}%` };
}
