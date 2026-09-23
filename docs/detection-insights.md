# Recurring-payment detection & proactive insights

This document describes how Future You detects recurring payments, how it
flags anomalies on them, and how the **Insights & alerts** panel turns those
into plain-language nudges. Everything here is deterministic heuristics — no
machine learning, no black boxes — so every alert can be traced back to a rule
and a threshold in code.

Code: `convex/recurring/detect.ts`, `convex/recurring/categories.ts`,
`convex/insights/derive.ts`, `convex/insights/mutations.ts`,
`convex/insights/queries.ts`. UI: `src/components/InsightsPanel.tsx`,
`src/components/RecurringTimeline.tsx`.

## 1. Detection signals

Transactions are grouped per account by **direction (debit/credit) + normalised
merchant name** (`merchantBaseName`, which strips trailing reference numbers).
Groups with fewer than two occurrences are ignored. For each group we compute
the median interval, the median amount, and a confidence score.

### Investec `transactionType` as a first-class signal

Investec labels every transaction with a `transactionType` (`DebitOrders`,
`CardPurchases`, `Deposits`, `FeesAndInterest`, …). We store the dominant value
per series and use it as a prior:

- **Debit orders** (`transactionType === "DebitOrders"`, or a description
  containing `DEBIT ORDER` / `D/O`) are almost always monthly bank-mandated
  pulls, so they get:
  - a widened "monthly" interval window of **20–40 days** (vs 24–34 for other
    series), which tolerates a late or early collection run;
  - an occurrence bonus of **+2** in the confidence formula (two debit-order
    runs count like four ordinary occurrences); and
  - a flat **+0.05** confidence bonus once a cadence is established.
- **Card purchases at supermarkets** (`CardPurchases` + `groceries` category)
  are discretionary in amount and timing, so their confidence is multiplied by
  **0.9**.

Confidence is otherwise the average of three 0–1 factors (occurrence count / 6,
interval regularity, amount stability), capped at 0.98 and shown as a bar in
the UI.

### Categories

`convex/recurring/categories.ts` holds a keyword table (extend it by adding a
keyword or an entry). Keywords match as whole words/phrases, so `FEE` doesn't
match `COFFEE` and `RAIN` doesn't match `TRAIN`. Categories: `subscription`,
`utility`, `insurance`, `loan`, `rent`, `income`, `fees`, `groceries`,
`telecom`, `other`. Fallbacks: a `FeesAndInterest` transactionType → `fees`;
the payday series → `income`. Credits that match a bill keyword (e.g. `RENT
REFUND`) are treated as `other`, not as bills.

## 2. Per-series anomalies

Each series stores `lastAmountCents` and at most one anomaly
(`anomalyKind` + human-readable `anomalyDetail`). A stopped series takes
precedence over an amount change.

| Anomaly | Rule |
| --- | --- |
| `missed_payment` | Weekly/biweekly/monthly series whose `predictedNextAt` is more than **one interval + 3 days** before the **newest transaction in the account** (not the wall clock, so a stale sync can't cause false alarms). |
| `amount_spike` | Needs ≥ 3 occurrences. Latest amount vs the **median of the earlier occurrences** is ≥ **25 %** higher, ≥ **R50** higher, and ≥ **2 standard deviations** of the earlier amounts higher. |
| `amount_drop` | Same thresholds, downwards. |

The 2σ rule is what stops a naturally variable series (weekly groceries)
from alerting on an ordinary light week, while a fixed bill (σ = 0) is judged
strictly. All thresholds live in `DETECTION` in `detect.ts`.

## 3. Insights

`deriveInsights({ series, currentBalanceCents, asOfMs, forecastSummary? })`
(`convex/insights/derive.ts`) is pure and clock-free. It is run at the end of
every `internal.recurring.detect.recompute` (i.e. after each sync or seed), in
the same transaction, and rewrites the `insights` table for the account.

| Kind | Severity | When |
| --- | --- | --- |
| `cashflow_risk` | critical (breach ≤ 7 days away or already ≤ 0), else warning | The 30-day forecast (`runForecast`, excluding stopped series) drops to or below R0. |
| `missed_payment` | warning | From the series anomaly. |
| `amount_spike` | warning | From the series anomaly. |
| `upcoming_cluster` | warning if the total exceeds the current balance, else info | The **heaviest** 3-day window in the next 30 days containing ≥ 3 recurring debits (one insight, not one per busy stretch). |
| `subscription_creep` | warning if ≥ 10 % of detected monthly income, else info | ≥ 2 active `subscription` series; totals their monthly-equivalent cost (weekly × 52/12, biweekly × 26/12). Stopped subscriptions are excluded. |
| `amount_drop` | info | From the series anomaly. |

Ordering is severity → kind priority (table order) → title. Dismissing an
insight (`api.insights.mutations.dismiss`) hides it, and the dismissal is
carried across recomputes as long as the insight's kind, merchant and title are
unchanged — so it resurfaces if, say, the amount changes again.

### API

- `api.insights.queries.list({ accountId? })` → non-dismissed insights, most
  severe first (falls back to the first account, like the forecast queries).
- `api.insights.mutations.dismiss({ insightId })`.
- `internal.insights.mutations.recompute({ accountId })` (also invoked
  automatically by `internal.recurring.detect.recompute`).

## 4. UI

- **Insights & alerts** card (`InsightsPanel.tsx`), mounted directly under the
  balance summary cards: severity-coloured rows (info = muted, warning = amber,
  critical = destructive), an icon per kind, a "Check / Urgent / FYI" badge, a
  dismiss button, a loading skeleton and an empty state ("Nothing needs your
  attention right now").
- **Upcoming recurring payments** table now shows a category badge and an
  anomaly badge per row (`+45% vs usual`, `-30% vs usual`, `Missed`) and a
  footer line "Recurring debits per month (estimate) ≈ R X" (monthly
  equivalents of forecastable debit series, excluding stopped ones).

## 5. Demo data

`convex/seed.ts` sets a `transactionType` on every synthetic row (rent,
insurance, gym, Netflix, Showmax, Spotify, DSTV, electricity → `DebitOrders`;
groceries, Takealot → `CardPurchases`; salary → `Deposits`), inflates the most
recent electricity bill by 45 % of the median of the earlier ones, adds a
R99 SHOWMAX subscription, and includes a DSTV debit order that ran for three
months and then stopped. Seeding the demo account therefore produces: a DSTV
`missed_payment`, a CITY POWER `amount_spike`, one `upcoming_cluster` around
the 1st of the month, and a `subscription_creep` line ("You spend R847/month
on 4 subscriptions"). The seed is idempotent and also refreshes existing rows.

## 6. Assumptions and limitations (please read)

- **Estimates, not guarantees.** Everything is inferred from past transaction
  patterns. A "missed" payment may simply have been cancelled or moved; a
  "spike" may be a legitimate annual increase. Alerts are prompts to check, not
  financial advice.
- **Amount anomalies need ≥ 3 occurrences**; a series seen twice can't have a
  meaningful "usual" amount.
- **Missed detection is deliberately conservative** (overdue by more than a
  full interval + 3 days), so a debit order that is a week late will not alert
  yet. It is judged against the newest transaction in the account, so it only
  fires once newer activity proves the account is still live.
- **Categories are keyword heuristics** tuned for South African merchants;
  unknown merchants become `other`. `GOOGLE`/`APPLE` are assumed to be
  subscriptions, which won't always be true.
- **Grouping is by merchant name**, so two different debit orders from the same
  collector (e.g. two insurance policies) are merged into one series with a
  variable amount.
- **Cashflow risk uses the same 30-day forecast engine as the chart**, with
  the safety threshold fixed at R0 and stopped series excluded. The main
  forecast query (`api.forecast.queries.getForecast`) does not yet exclude
  series flagged `missed_payment`; that is a suggested follow-up.
- Sandbox accounts have short, sparse histories, so most of the interesting
  insights appear on the synthetic demo account.
