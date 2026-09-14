package api

import (
	"strings"
	"testing"

	"github.com/verkyyi/ccquota/internal/i18n"
	"github.com/verkyyi/ccquota/internal/pricing"
	"github.com/verkyyi/ccquota/internal/store"
)

// Each dashboard Text's English entry must BE the constant it translates, for
// the same reason the pricing ones must: a copy drifts, and the drift is
// invisible because every existing test still asserts on the constant.
func TestDashboardNotes_EnglishIsTheConstant(t *testing.T) {
	for name, pair := range map[string]struct {
		text     i18n.Text
		original string
	}{
		"real_spend": {realSpendNote, RealSpendNote},
		"across":     {acrossNoteText, acrossNote},
		"disclaimer": {shareDisclaimerText, shareDisclaimer},
		"live":       {liveNoteText, liveNote},
		"acct_usage": {accountUsageNote, accountUsageNoteEN},
		"provider":   {providerNoteText(), store.ProviderNote},
	} {
		if pair.text[i18n.EN] != pair.original {
			t.Errorf("%s: the English entry has drifted from its constant", name)
		}
		zh := pair.text[i18n.ZhCN]
		if strings.TrimSpace(zh) == "" {
			t.Errorf("%s: no Chinese text", name)
		}
		if zh == pair.original {
			t.Errorf("%s: the Chinese entry is just the English text", name)
		}
	}
}

// providerNoteText re-derives store's pair through its public accessors, since
// the map itself is that package's business.
func providerNoteText() i18n.Text {
	return i18n.Text{
		i18n.EN:   store.ProviderNoteIn(i18n.EN),
		i18n.ZhCN: store.ProviderNoteIn(i18n.ZhCN),
	}
}

// The point of the whole locale parameter: a request that asks for Chinese gets
// the server's own prose in Chinese. These notes are the ones the page CANNOT
// translate itself -- they are written where the figures are computed, and the
// page has no business restating a claim about money it did not make.
func TestSummary_LocaleTranslatesServerProse(t *testing.T) {
	h := newHarness(t)

	var en struct {
		RealSpendNote string `json:"real_spend_note"`
		PricingNote   string `json:"pricing_note"`
		Disclaimer    string `json:"disclaimer"`
	}
	h.getJSON(t, "/v1/summary?since=1d&account=all", &en)
	if en.RealSpendNote != RealSpendNote {
		t.Errorf("default real_spend_note = %q; want the English constant", en.RealSpendNote)
	}

	var zh struct {
		RealSpendNote string `json:"real_spend_note"`
		PricingNote   string `json:"pricing_note"`
		Disclaimer    string `json:"disclaimer"`
	}
	h.getJSON(t, "/v1/summary?since=1d&account=all&locale=zh-CN", &zh)
	if zh.RealSpendNote == en.RealSpendNote {
		t.Error("real_spend_note was not translated")
	}
	if zh.PricingNote == en.PricingNote {
		t.Error("pricing_note was not translated")
	}
	if zh.Disclaimer == en.Disclaimer {
		t.Error("disclaimer was not translated")
	}
	if !strings.Contains(zh.RealSpendNote, "真实支出") {
		t.Errorf("real_spend_note does not read as Chinese: %q", zh.RealSpendNote)
	}
}

// Per-source provenance travels as a list, and every entry's note must follow
// the locale while its identifiers do not.
func TestSummary_LocaleTranslatesEveryProvenanceNote(t *testing.T) {
	h := newHarness(t)
	var got struct {
		Pricing []pricing.SourceProvenance `json:"pricing"`
	}
	h.getJSON(t, "/v1/summary?since=1d&account=all&locale=zh-CN", &got)
	if len(got.Pricing) == 0 {
		t.Fatal("no provenance in the response")
	}
	for _, p := range got.Pricing {
		if p.Note == pricing.Note(p.Source) {
			t.Errorf("%s: note was not translated", p.Source)
		}
		// The source key is a filter value and a grep target; it never changes.
		if p.Source != strings.ToLower(p.Source) {
			t.Errorf("source identifier was rewritten: %q", p.Source)
		}
	}
}

// An unknown locale is answered in English rather than refused: a stale
// bookmark or a typo in a hand-built URL should still render a page.
func TestSummary_UnknownLocaleIsEnglish(t *testing.T) {
	h := newHarness(t)
	var got struct {
		RealSpendNote string `json:"real_spend_note"`
	}
	h.getJSON(t, "/v1/summary?since=1d&account=all&locale=klingon", &got)
	if got.RealSpendNote != RealSpendNote {
		t.Errorf("unknown locale = %q; want the English text", got.RealSpendNote)
	}
}

// scope_note answers "what does this total span". It only exists for an
// all-accounts scope, and that must stay true in both languages -- a caveat
// about cross-subscription totals on a single-subscription request is noise.
func TestScopeNote_OnlyWhenItSpansSubscriptions(t *testing.T) {
	if scopeNoteIn(store.AllAccounts, i18n.ZhCN) == "" {
		t.Error("all-accounts scope has no note in Chinese")
	}
	if got := scopeNoteIn("some-account-uuid", i18n.ZhCN); got != "" {
		t.Errorf("single-account scope got a note: %q", got)
	}
	if scopeNoteIn(store.AllAccounts, i18n.ZhCN) == scopeNoteIn(store.AllAccounts, i18n.EN) {
		t.Error("scope_note was not translated")
	}
}

// The two prose surfaces the dashboard prints verbatim from the server but
// which are chosen at RUNTIME rather than being one constant: why a quota
// reading is missing, and why a request has no price. Both were English on a
// Chinese page until they carried a code instead of a sentence.
func TestLimitsReasonIn_EveryCodeIsTranslated(t *testing.T) {
	for code := range limitsReasons {
		en, zh := LimitsReasonIn(code, i18n.EN), LimitsReasonIn(code, i18n.ZhCN)
		if en == "" || zh == "" {
			t.Errorf("%s: empty (en=%q zh=%q)", code, en, zh)
		}
		if en == zh {
			t.Errorf("%s: not translated", code)
		}
	}
	// An unknown code explains nothing rather than inventing an explanation:
	// the card falls back to its own plain "no reading available", which is
	// true, where a guessed sentence would not be.
	if got := LimitsReasonIn("no_such_code", i18n.ZhCN); got != "" {
		t.Errorf("unknown code invented a reason: %q", got)
	}
}

// An endpoint's own reported reason is relayed, never rewritten: an agent said
// those words. Only the frame around them is this hub's wording.
func TestEndpointReports_RelaysTheAgentsOwnWords(t *testing.T) {
	const said = "HTTP 429 from the account endpoint"
	for _, loc := range []string{i18n.EN, i18n.ZhCN} {
		got := endpointReports("mac-studio", said, loc)
		if !strings.Contains(got, said) {
			t.Errorf("%s: the endpoint's words were rewritten: %q", loc, got)
		}
		if !strings.Contains(got, "mac-studio") {
			t.Errorf("%s: the endpoint name was lost: %q", loc, got)
		}
	}
	if endpointReports("m", said, i18n.EN) == endpointReports("m", said, i18n.ZhCN) {
		t.Error("the frame was not translated")
	}
}

func TestUnpricedReasons_TranslatedWithoutTouchingIdentifiers(t *testing.T) {
	rows := []store.UnpricedReason{
		{Source: "gateway", Model: "qwen-plus", Code: store.UnpricedNoGatewayRate, Events: 3},
		{Source: "claude", Model: "claude-opus-5", Code: store.UnpricedPruned, Events: 7},
	}
	got := localizedReasons(rows, i18n.ZhCN)
	if len(got) != len(rows) {
		t.Fatalf("got %d rows; want %d", len(got), len(rows))
	}
	for i, r := range got {
		if r.Source != rows[i].Source || r.Model != rows[i].Model || r.Events != rows[i].Events {
			t.Errorf("row %d: identifiers or counts changed: %+v", i, r)
		}
		if r.Reason == store.UnpricedReasonIn(r.Code, i18n.EN) {
			t.Errorf("row %d: reason was not translated", i)
		}
		if r.Reason == "" {
			t.Errorf("row %d: blank reason in a table that exists to explain an absence", i)
		}
	}
	// The input is not mutated: the caller may still hold the English rows.
	if rows[0].Reason != "" {
		t.Error("localizedReasons wrote through to its input")
	}
}
