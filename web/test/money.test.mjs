import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtMoney, fmtUSD, DEFAULT_CURRENCY } from '../dist/lib/format.js';
import { fmtRealSpend } from '../dist/lib/cost.js';
import { spendTerms } from '../dist/lib/spend.js';
import { useLocale } from '../dist/lib/i18n.js';

// The page used to stamp "$" on every figure regardless of what the data said.
// A hub whose plans are priced in CNY was shown "$46.00" for ¥46.00 — a wrong
// currency on a real invoice, which is a worse error than a wrong language.
test('an amount is rendered in the currency it was billed in', () => {
  assert.equal(fmtMoney(85.75, 'USD'), '$85.75');
  assert.match(fmtMoney(46, 'CNY'), /¥46\.00$/);
  // No currency stated is USD, matching store.DefaultCurrency in Go.
  assert.equal(DEFAULT_CURRENCY, 'USD');
  assert.equal(fmtMoney(85.75, undefined), fmtMoney(85.75, 'USD'));
  assert.equal(fmtMoney(85.75, ''), fmtMoney(85.75, 'USD'));
});

// The one thing this must NOT do. api.RealSpendOver refuses to add two
// currencies together and reports the total as incomplete instead ("this hub
// does no currency conversion"); showing a converted figure on the way out
// would reintroduce exactly the money nobody was charged that the Go side
// declines to invent.
test('the locale changes the rendering, never the amount', () => {
  try {
    for (const loc of ['en', 'zh-CN']) {
      useLocale(loc);
      for (const [n, cur] of [[85.75, 'USD'], [46, 'CNY'], [1234567.5, 'USD']]) {
        const digits = fmtMoney(n, cur).replace(/[^0-9.]/g, '');
        assert.equal(Number(digits.replace(/,/g, '')), n,
          `${loc}/${cur}: the number itself changed`);
      }
    }
  } finally {
    useLocale('en');
  }
});

test('a zh-CN viewer is told WHICH dollar', () => {
  try {
    useLocale('zh-CN');
    // "$85.75" is ambiguous to a reader who also sees ¥; "US$85.75" is not.
    assert.equal(fmtMoney(85.75, 'USD'), 'US$85.75');
    assert.equal(fmtMoney(46, 'CNY'), '¥46.00');
  } finally {
    useLocale('en');
  }
  // English output is unchanged from before this existed.
  assert.equal(fmtUSD(85.75), '$85.75');
  assert.equal(fmtUSD(0), '$0.00');
  assert.equal(fmtUSD(1234567.5), '$1,234,567.50');
});

// A junk currency code makes Intl.NumberFormat throw. The figure must still
// render: the number plus the code is more honest than a dollar sign over it.
test('an unrecognised currency code still renders', () => {
  const got = fmtMoney(12.5, 'NOT-A-CURRENCY');
  assert.match(got, /12\.50/);
  assert.match(got, /NOT-A-CURRENCY/);
  assert.ok(!got.includes('$'), `fell back to a dollar sign: ${got}`);
});

test('real spend and its terms carry the currency the total is in', () => {
  const rs = { currency: 'CNY', subscription: 40, gateway: 6, vendor_bill: 0, total: 46, complete: true };
  assert.match(fmtRealSpend(rs), /¥46\.00/);
  // Every term is a part of that total, so it cannot be in another currency.
  for (const term of spendTerms(rs)) {
    assert.equal(term.currency, 'CNY', `${term.key} lost the currency`);
  }
  // An incomplete total still says so.
  assert.match(fmtRealSpend({ ...rs, complete: false }), /≥$/);
  assert.equal(fmtRealSpend(null), '—');
});
