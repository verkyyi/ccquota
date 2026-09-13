// web/dist/lib/spend.js — reading real spend as its named terms.
//
// Pure, like everything else under lib/: no DOM, so it is testable under
// `node --test`. The rendering lives in ../spend.js.
//
// Real spend has three terms and they are kept apart on purpose. Subscription
// money bills monthly whether or not a token is spent; gateway money is
// metered per call; vendor-bill money is read off an invoice for paths no
// gateway can see. All three are money somebody paid — that is why they may
// be summed at all — but the FIELD NAMES are claims about provenance, and
// folding one into another is a claim the figure cannot support.

const LABEL = {
  subscription: 'subscriptions',
  gateway: 'metered · via the gateway',
  vendor_bill: 'metered · billed by the vendor directly',
};

/** spendTerms lists the non-zero terms of real spend, in display order.
 *
 *  A zero term is dropped rather than shown as $0.00: this deployment either
 *  has that kind of charge or it does not, and three rows of zero teach a
 *  reader nothing while making the real ones harder to find. */
export function spendTerms(rs) {
  if (!rs) return [];
  return ['subscription', 'gateway', 'vendor_bill']
    .map((key) => ({ key, label: LABEL[key], amount: rs[key] || 0 }))
    .filter((t) => t.amount !== 0);
}
