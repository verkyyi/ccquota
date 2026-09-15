// web/dist/repo.js — the progress tier: what the spend bought.
//
// Every other section on this page answers "what did it cost". This one
// answers "what landed", from rows a shipper pushes into the same hub under
// the same key. It is deliberately NOT a second dashboard: it sits in the
// same surface, under the same shell, reading the same binary — two
// dashboards sharing a process would be the thing this feature exists not to
// be.
//
// The one rule every card here obeys: a threshold is never a constant. Ages
// are read against the repository's OWN close-time percentiles, and when a
// shipper has not computed them the card says the scale is unknown instead of
// picking one. A confident "12 stale issues" derived from a number nobody
// measured is worse than no card, because a reader cannot tell it from a
// measured one.
import { el, escapeHTML, showTip, hideTip } from './lib/dom.js';
import { t } from './lib/i18n.js';
import { fmtInt } from './lib/format.js';
import { rankedBars } from './charts.js';
import { fmtAge, weeklyFlow, net, ageHistogram, stalled, pickRepo } from './lib/repo.js';
import { groupByOwner, untold, weeklyHuman, windowRatio, trend, pct, trimLeadingEmpty,
         OWNER_NOT_A_PERSON, OWNER_UNRESOLVED } from './lib/human.js';

const STALLED_SHOWN = 12;

/** renderRepo mounts the progress tier. It returns the {fetchers, apply} pair
 *  app.js's loader expects, or null when this hub holds no repo data at all —
 *  a hub with no shipper must look exactly as it did before this landed, not
 *  grow an empty card explaining a feature nobody turned on. */
export function renderRepo(root, state, app, repos) {
  if (!repos || !repos.length) {
    root.replaceChildren();
    return null;
  }
  const repo = pickRepo(state.repo, repos);
  const q = (extra) => new URLSearchParams({ repo, ...extra }).toString();
  return {
    fetchers: [
      (signal) => app.api('/v1/repo/flow?' + q({}), signal),
      // Open issues only, and generously capped: the age histogram needs the
      // whole open backlog to be a distribution rather than a sample, and the
      // stalled list is drawn from the same rows so the two can never
      // disagree about what is open.
      (signal) => app.api('/v1/repo/issues?' + q({ state: 'open', limit: '1000' }), signal),
      // Open manual steps plus the daily ratio behind them. A hub whose
      // shipper does not parse release fragments gets an empty pair back and
      // the card renders as nothing — same rule as the section itself.
      (signal) => app.api('/v1/repo/human-debt?' + q({}), signal),
    ],
    apply: (results) => apply(root, results, repo, repos, state, app),
  };
}

function apply(root, results, repo, repos, state, app) {
  const [flowR, issuesR, humanR] = results;
  // Three slots, and which card goes where is fixed rather than positional:
  // the picker is full width above the pair, flow and age share the two-up
  // row, and the stalled table runs full width beneath them. Slicing a flat
  // list instead put the picker in the grid and pushed the age card out of
  // it the moment a second repository appeared.
  const head = repos.length > 1 ? repoPicker(repo, repos, state, app) : null;
  const scale = flowR.status === 'fulfilled' ? flowR.value.scale : null;
  const flow = flowR.status === 'rejected'
    ? errCard(t('repo.flow.title'), flowR.reason)
    : flowCard(flowR.value);
  const issues = issuesR.status === 'fulfilled' ? (issuesR.value.issues || []) : null;
  const age = issues === null
    ? errCard(t('repo.backlog.title'), issuesR.reason)
    : ageCard(issues, scale);
  const below = issues === null ? [] : [stalledCard(issues, scale, repo)];
  // The manual-step card goes FIRST when there is anything in it. Everything
  // below says how fast the machine half is moving; this says whether the
  // release is moving at all — and a batch with an unfinished manual step
  // does not ship, however green every check above it is.
  const human = humanR.status === 'rejected'
    ? errCard(t('repo.human.title'), humanR.reason)
    : humanCard(humanR.value);
  root.replaceChildren(...(head ? [head] : []), ...(human ? [human] : []),
                       el('div', { class: 'grid2' }, flow, age), ...below);
}

function errCard(title, reason) {
  return el('div', { class: 'card' },
    el('h2', {}, title),
    el('div', { class: 'empty' }, t('common.queryFailed', { error: (reason && reason.message) || String(reason) })));
}

function repoPicker(repo, repos, state, app) {
  const sel = el('select', {
    'aria-label': t('repo.pick'),
    onchange: (e) => app.setState({ ...state, repo: e.target.value }),
  }, repos.map((r) => el('option', { value: r.repo, selected: r.repo === repo || null }, r.repo)));
  return el('div', { class: 'card' },
    el('div', { class: 'controls' }, el('span', { class: 'label' }, t('repo.pick')), sel));
}

/* ------------------------------------------------------------------ flow */

function flowCard(flow) {
  const card = el('div', { class: 'card', id: 'repo-flow' },
    el('h2', {}, t('repo.flow.title')),
    el('p', { class: 'hint' }, t('repo.flow.hint')));
  const weeks = weeklyFlow(flow.days);
  if (!weeks.length) {
    card.appendChild(el('div', { class: 'empty' }, t('repo.flow.empty')));
    return card;
  }
  card.appendChild(flowChart(weeks));

  // The one sentence a reader actually wants: is the backlog growing?
  const recent = weeks.slice(-4);
  const delta = recent.reduce((a, w) => a + net(w), 0);
  const last = [...weeks].reverse().find((w) => w.openAtEnd != null);
  const bits = [t(delta > 0 ? 'repo.flow.growing' : delta < 0 ? 'repo.flow.shrinking' : 'repo.flow.level',
    { n: Math.abs(delta), weeks: recent.length })];
  if (last) bits.push(t('repo.flow.openNow', { n: fmtInt(last.openAtEnd) }));
  card.appendChild(el('p', { class: 'hint' }, bits.join(' ')));
  return card;
}

/** flowChart draws opened above the axis and closed below it, with the
 *  open-issue level as a line on its own scale.
 *
 *  Mirrored bars rather than a stack, because opened and closed are opposing
 *  flows: stacking them would put a tall bar on a week where a lot happened
 *  and nothing changed, which is the opposite of what the reader is looking
 *  for. The level gets its own axis and is drawn as a line, because it is not
 *  a rate and must not be read against the same gridlines. */
function flowChart(weeks) {
  const W = 560, H = 210, PAD = { t: 16, r: 42, b: 24, l: 44 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const mid = PAD.t + ih / 2;
  const half = ih / 2;
  const maxFlow = Math.max(1, ...weeks.map((w) => Math.max(w.opened, w.closed)));
  const maxOpen = Math.max(1, ...weeks.map((w) => w.openAtEnd || 0));
  const n = weeks.length;
  const step = iw / n;
  const bw = Math.max(2, step / 2 - 2);

  const g = el('g', {});
  // Three gridlines only: the zero axis and the two flow extremes.
  for (const [v, y] of [[maxFlow, mid - half], [0, mid], [maxFlow, mid + half]]) {
    g.appendChild(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: 'var(--grid)' }));
    g.appendChild(el('text', { x: PAD.l - 8, y: y + 3.5, 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': '10.5' }, fmtInt(v)));
  }

  weeks.forEach((w, i) => {
    const x = PAD.l + i * step;
    const tip = `<b>${escapeHTML(w.week)}</b><br>` +
      escapeHTML(t('repo.tip.opened', { n: w.opened })) + '<br>' +
      escapeHTML(t('repo.tip.closed', { n: w.closed })) +
      (w.openAtEnd != null ? '<br>' + escapeHTML(t('repo.tip.open', { n: w.openAtEnd })) : '');
    const hover = { onmousemove: (e) => showTip(e, tip), onmouseleave: hideTip };
    const oh = (w.opened / maxFlow) * half;
    const ch = (w.closed / maxFlow) * half;
    g.appendChild(el('rect', { x, y: mid - oh, width: bw, height: Math.max(w.opened ? 1.5 : 0, oh), rx: 2, fill: 'var(--s2)', ...hover },
      el('title', {}, t('repo.tip.opened', { n: w.opened }))));
    g.appendChild(el('rect', { x: x + bw + 2, y: mid, width: bw, height: Math.max(w.closed ? 1.5 : 0, ch), rx: 2, fill: 'var(--s3)', ...hover },
      el('title', {}, t('repo.tip.closed', { n: w.closed }))));
  });

  // The level line, on the right-hand axis.
  const pts = weeks
    .map((w, i) => (w.openAtEnd == null ? null : `${PAD.l + i * step + step / 2},${PAD.t + ih - (w.openAtEnd / maxOpen) * ih}`))
    .filter(Boolean);
  if (pts.length > 1) {
    g.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--s1)', 'stroke-width': '1.6' }));
  }
  g.appendChild(el('text', { x: W - PAD.r + 6, y: PAD.t + 4, fill: 'var(--ink-3)', 'font-size': '10.5' }, fmtInt(maxOpen)));

  const label = (i, anchor) => el('text', {
    x: PAD.l + i * step + step / 2, y: H - 6, 'text-anchor': anchor, fill: 'var(--ink-3)', 'font-size': '10.5',
  }, weeks[i].week.slice(5));
  g.appendChild(label(0, 'start'));
  if (n > 1) g.appendChild(label(n - 1, 'end'));

  return el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img',
    'aria-label': t('repo.flow.aria', { weeks: n, open: fmtInt(maxOpen) }),
  }, g);
}

/* ------------------------------------------------------------------- age */

function ageCard(issues, scale) {
  const card = el('div', { class: 'card', id: 'repo-age' },
    el('h2', {}, t('repo.age.title')),
    el('p', { class: 'hint' }, t('repo.age.hint')));
  const hist = ageHistogram(issues, scale);
  if (!hist) {
    // Not an empty chart: "no scale" and "no issues" are different answers,
    // and rendering them the same would let a reader take one for the other.
    card.appendChild(el('div', { class: 'empty' }, t('repo.age.noScale')));
    return card;
  }
  const rows = hist.map((b, i) => ({
    key: b.key,
    label: b.to === null ? t('repo.age.over', { edge: b.edge }) : t('repo.age.upTo', { age: fmtAge(b.to, t), edge: b.edge }),
    value: b.count,
    right: fmtInt(b.count),
    color: i === hist.length - 1 ? 'var(--s2)' : 'var(--s1)',
    tip: escapeHTML(t('repo.age.tip', { n: b.count })),
  }));
  card.appendChild(rankedBars(rows));
  card.appendChild(el('p', { class: 'hint' }, scaleLine(scale)));
  return card;
}

/** scaleLine states the distribution every band above was cut from, and how
 *  many closes it was measured over. A reader who cannot see the sample size
 *  cannot tell a distribution from an anecdote. */
function scaleLine(scale) {
  const parts = [];
  for (const [name, key] of [['p50', 'p50_seconds'], ['p90', 'p90_seconds'], ['p95', 'p95_seconds']]) {
    if (typeof scale[key] === 'number') parts.push(`${name} ${fmtAge(scale[key], t)}`);
  }
  const line = t('repo.age.scale', { parts: parts.join(' · '), day: scale.day });
  return scale.closed_sample ? line + ' ' + t('repo.age.sample', { n: fmtInt(scale.closed_sample) }) : line;
}

/* --------------------------------------------------------------- stalled */

function stalledCard(issues, scale, repo) {
  const card = el('div', { class: 'card', id: 'repo-stalled' },
    el('h2', {}, t('repo.stalled.title')),
    el('p', { class: 'hint' }, t('repo.stalled.hint')));
  const { rows, reason } = stalled(issues, scale);
  if (reason === 'no-scale') {
    card.appendChild(el('div', { class: 'empty' }, t('repo.stalled.noScale')));
    return card;
  }
  if (!rows.length) {
    card.appendChild(el('div', { class: 'empty' }, t('repo.stalled.none')));
    return card;
  }
  const head = el('tr', {},
    el('th', {}, t('repo.col.issue')),
    el('th', {}, t('repo.col.age')),
    el('th', {}, t('repo.col.comments')),
    el('th', {}, t('repo.col.shipped')));
  const body = rows.slice(0, STALLED_SHOWN).map((i) => el('tr', {},
    el('td', {}, i.url
      ? el('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer' }, `#${i.number} ${i.title || ''}`.trim())
      : `#${i.number} ${i.title || ''}`.trim()),
    el('td', { class: 'num' }, fmtAge(i.age_seconds, t)),
    el('td', { class: 'num' }, fmtInt(i.comments || 0)),
    // The actionable half: the work already landed and nobody closed it.
    // That is a close, not an investigation, so it is called out rather than
    // left for a reader to notice.
    el('td', {}, i.shipped_at
      ? el('span', { class: 'warn', title: i.shipped_ref || '' }, t('repo.stalled.shipped'))
      : '')));
  card.appendChild(el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, head), el('tbody', {}, body))));
  if (rows.length > STALLED_SHOWN) {
    card.appendChild(el('p', { class: 'hint' }, t('repo.stalled.more', { n: rows.length - STALLED_SHOWN, repo })));
  }
  return card;
}

/* ----------------------------------------------------------------- human */

/** humanCard is the release work that is waiting on a PERSON: what is owed
 *  right now, grouped by whose it is, and whether the share of releases that
 *  need a hand is falling.
 *
 *  ★ It shows EVERYONE'S rows, and says so in the first line. This hub's SSO
 *    ticket carries one fixed subject per (app, tenant) — every colleague's
 *    session is byte-identical here — so "yours" is not a question it can
 *    answer. Filtering anyway would put a personal claim on rows picked by a
 *    coin flip, on the one card whose entire job is saying who owes what.
 *
 *  ★ It is a VIEW, never a control. Finishing a step happens on the channel
 *    that told somebody about it; a "done" button here would be a second
 *    writer and therefore a second truth. */
function humanCard(data) {
  const steps = (data && data.steps) || [];
  const weeks = trimLeadingEmpty(weeklyHuman((data && data.days) || []));
  // Nothing shipped at all — not an empty card explaining a feature nobody
  // turned on. (Nothing OWED, with days shipped, is a real and good answer
  // and does get a card.)
  if (!steps.length && !weeks.length) return null;

  const card = el('div', { class: 'card', id: 'repo-human' },
    el('h2', {}, t('repo.human.title')),
    el('p', { class: 'hint' }, t('repo.human.hint')),
    el('p', { class: 'hint' }, t('repo.human.everyone')));

  if (!steps.length) {
    card.appendChild(el('div', { class: 'empty' }, t('repo.human.none')));
  } else {
    const n = untold(steps);
    if (n) {
      // Not a footnote: a step nobody was told about is the system failing to
      // deliver it, and the total above blames the wrong party for it.
      card.appendChild(el('p', { class: 'warn' }, t('repo.human.untold', { n })));
    }
    for (const g of groupByOwner(steps)) card.appendChild(ownerGroup(g));
  }

  card.appendChild(el('h3', {}, t('repo.human.ratio.title')));
  card.appendChild(el('p', { class: 'hint' }, t('repo.human.ratio.hint')));
  if (!weeks.length) {
    card.appendChild(el('div', { class: 'empty' }, t('repo.human.ratio.none')));
  } else {
    card.appendChild(ratioChart(weeks));
    card.appendChild(el('p', { class: 'hint' }, ratioLine(weeks)));
  }
  return card;
}

const clip = (v, n) => (String(v).length <= n ? String(v) : String(v).slice(0, n - 1) + '\u2026');

const KIND_LABEL = {
  [OWNER_NOT_A_PERSON]: 'repo.human.kind.notAPerson',
  [OWNER_UNRESOLVED]: 'repo.human.kind.unresolved',
};

function ownerGroup(g) {
  const label = el('div', { class: 'controls' },
    el('span', { class: 'label' }, g.owner),
    // The two kinds nobody can be reminded about are marked, because "waiting
    // on 发起人" and "waiting on a name nothing could resolve" look identical
    // in a list and are not the same problem at all.
    ...(KIND_LABEL[g.kind] ? [el('span', { class: 'warn' }, t(KIND_LABEL[g.kind]))] : []),
    el('span', { class: 'hint' }, t('repo.human.group', { n: g.steps.length, age: fmtAge(g.waiting, t) })));

  const head = el('tr', {},
    el('th', {}, t('repo.human.col.step')),
    el('th', {}, t('repo.human.col.waiting')),
    el('th', {}, t('repo.human.col.told')));
  const body = g.steps.map((s) => {
    const name = `#${s.fragment}.${s.ord} ${s.title || ''}`.trim();
    // The link goes back to the fragment issue, because that is where the
    // step is WRITTEN — the row here is a copy, and a reader who wants to act
    // needs the original.
    const link = s.fragment_url
      ? el('a', { href: s.fragment_url, target: '_blank', rel: 'noopener noreferrer' }, name)
      : name;
    // "How to do it" travels with the row. Without it the reader has to open
    // the issue to find out whether this is a two-second kubectl or an
    // afternoon — which is the friction this whole page exists to remove.
    // Clipped, with the whole thing (plus what counts as done, and what to do
    // if you can't) in the tooltip. A step whose instructions run to a screen
    // of text would push every other owner's rows below the fold — and the
    // rows below the fold are the ones nobody acts on.
    const how = s.how
      ? el('div', { class: 'hint', title: [s.how, s.pass, s.exit].filter(Boolean).join('\n\n') }, clip(s.how, 180))
      : el('div', { class: 'hint' }, t('repo.human.noHow'));
    return el('tr', {},
      el('td', {}, link, how),
      el('td', { class: 'num' }, fmtAge(s.waiting_seconds, t)),
      el('td', {}, s.todo_at ? '' : el('span', { class: 'warn' }, t('repo.human.notTold'))));
  });
  return el('div', {}, label,
    el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, head), el('tbody', {}, body))));
}

/** ratioChart draws the weekly share as bars, with the week's fragment count
 *  as the tooltip's denominator.
 *
 *  A week with no fragments draws NOTHING rather than a zero-height bar: the
 *  gap is the honest rendering of "nothing to measure", and a flat zero would
 *  read as "nothing needed a human that week", which is the opposite claim. */
function ratioChart(weeks) {
  const W = 560, H = 120, PAD = { t: 12, r: 12, b: 22, l: 40 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const max = Math.max(0.05, ...weeks.map((w) => w.ratio || 0));
  const step = iw / weeks.length;
  // Capped: with three weeks of history a bar sized to its slot is 170px
  // wide, which reads as a block of colour rather than as a measurement. The
  // cap only binds early — it stops mattering the moment there is a quarter
  // of history, which is when this chart starts being worth reading.
  const bw = Math.min(34, Math.max(3, step - 6));
  const g = el('g', {});
  for (const [v, y] of [[max, PAD.t], [0, PAD.t + ih]]) {
    g.appendChild(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: 'var(--grid)' }));
    g.appendChild(el('text', { x: PAD.l - 8, y: y + 3.5, 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': '10.5' }, pct(v)));
  }
  weeks.forEach((w, i) => {
    const x = PAD.l + i * step;
    if (w.ratio == null) return;
    const h = (w.ratio / max) * ih;
    const tip = `<b>${escapeHTML(w.week)}</b><br>` +
      escapeHTML(t('repo.human.tip', { pct: pct(w.ratio), n: w.withHuman, total: w.fragments }));
    g.appendChild(el('rect', {
      x, y: PAD.t + ih - h, width: bw, height: Math.max(w.withHuman ? 1.5 : 0, h), rx: 2,
      fill: 'var(--s2)', onmousemove: (e) => showTip(e, tip), onmouseleave: hideTip,
    }, el('title', {}, t('repo.human.tip', { pct: pct(w.ratio), n: w.withHuman, total: w.fragments }))));
  });
  const label = (i, anchor) => el('text', {
    x: PAD.l + i * step + bw / 2, y: H - 6, 'text-anchor': anchor, fill: 'var(--ink-3)', 'font-size': '10.5',
  }, weeks[i].week.slice(5));
  g.appendChild(label(0, 'start'));
  if (weeks.length > 1) g.appendChild(label(weeks.length - 1, 'end'));
  return el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img',
    'aria-label': t('repo.human.ratio.aria', { weeks: weeks.length, pct: pct(windowRatio(weeks)) || '—' }),
  }, g);
}

/** ratioLine is the sentence under the chart: where the share stands, and
 *  whether it is moving. It refuses to name a direction from a single week —
 *  see trend(). */
function ratioLine(weeks) {
  const tr = trend(weeks);
  const bits = [];
  const win = windowRatio(weeks);
  if (win != null) bits.push(t('repo.human.ratio.window', { pct: pct(win), weeks: weeks.length }));
  if (tr.direction === 'unknown') {
    bits.push(t('repo.human.ratio.unknown'));
  } else {
    bits.push(t(`repo.human.ratio.${tr.direction}`, {
      pct: pct(tr.latest.ratio), before: pct(tr.before), week: tr.latest.week,
    }));
  }
  return bits.join(' ');
}
