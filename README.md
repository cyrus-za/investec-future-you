# Future You

> Built for the Investec Developer Community's **Q3 2026 "Future You" Bounty**.
> Most banking apps tell you what happened. This one tells you what's likely to happen next.

**Live demo:** https://investec-future-you.vercel.app

Forecasts your available balance forward, detects recurring payments and
debit orders from your Investec transaction history, flags cashflow risk
before it happens, and answers "can I afford this?" before you spend.

## 1. What problem does this solve?

Bank apps are great at showing a list of things that already happened.
They're bad at answering the question people actually care about: *will I
still have money before my next payday if I spend this now?* This app turns
raw Investec transaction history into a forward-looking projection, so a
cashflow squeeze shows up as a warning on a dashboard instead of a declined
card at the till.

## 2. Who is it for?

Anyone who gets paid on a fixed-ish schedule and has a handful of recurring
debit orders (rent, insurance, subscriptions, a home loan) and wants a
plain-English answer to "how much of this is actually mine to spend before
payday?" — the same use case as the bounty's "Starter" and "Intermediate"
tiers (runway calculator, subscription tracker, cashflow risk warnings).

## 3. Which Investec API data does it use?

- **OAuth2 `client_credentials`** — `POST /identity/v2/oauth2/token`
  (`convex/investec/client.ts`)
- **Accounts** — `GET /za/pb/v1/accounts`
- **Transactions** — `GET /za/pb/v1/accounts/:id/transactions?fromDate&toDate`,
  including each transaction's `runningBalance`, which is used as the
  starting point for the forecast (no separate balance call needed)

This app runs against the **Investec Sandbox** (`openapisandbox.investec.com`)
with the publicly-documented sandbox demo credentials — no real account data
is used. A synthetic, deterministically-generated demo account (see
`convex/seed.ts`) is also included so the forecasting logic can be exercised
even without any Investec credentials at all.

## 4. How does it detect recurring payments and forecast future balances?

Detection (`convex/recurring/detect.ts`):

1. Group transactions by a normalised merchant name (strip trailing order
   numbers, uppercase, etc. — reused logic from an earlier Investec project)
   and by debit/credit direction.
2. Require at least 2 occurrences of the same merchant/direction.
3. Compute the median number of days between occurrences and classify the
   cadence as `weekly` (~7d), `biweekly` (~14d), `monthly` (~28-31d, aligned
   to day-of-month rather than a fixed day count so it survives different
   month lengths), or `irregular` if the interval doesn't fit any bucket.
4. Score a **confidence** (0-1) from three factors: how many times it's been
   seen, how consistent the interval is, and how consistent the amount is
   (a variable electricity bill still counts as monthly, just with lower
   confidence than a fixed rent payment).
5. The largest-amount **monthly credit** series is flagged as payday.

Forecasting (`convex/forecast/engine.ts`):

1. Start from the most recent transaction's `runningBalance`.
2. Walk forward day-by-day for the chosen horizon (default 30 days),
   projecting each non-irregular recurring series' future occurrences
   (monthly series step by calendar month so a "28th of the month" bill
   stays on the 28th).
3. Sum up the projected daily balance, and record the first date it would
   dip to or below a configurable safety threshold (default R0).

"Can I afford this?" (`convex/forecast/queries.ts: checkAffordability`) reruns
the same projection with one extra hypothetical debit inserted on a chosen
date, and compares the projected minimum balance with and without it.

## 5. What assumptions does it make?

- Recurring amounts and dates are assumed to repeat going forward exactly as
  detected historically — no seasonality, raises, or once-off changes are
  modelled.
- A merchant needs **2+ occurrences** in the synced history to be considered
  recurring at all; a first-ever debit order won't show up until it repeats.
- Monthly cadence is inferred from a 24-34 day gap between occurrences, which
  can occasionally misclassify a payment that's a few days early/late in a
  given month.
- The forecast has no visibility into card authorisation holds, pending
  transactions, or anything that hasn't posted yet.
- Confidence scores are a heuristic, not a statistical guarantee — they're
  meant to help a user judge how much to trust a given prediction, not to be
  read as a precise probability.

## 6. How can someone install and run it?

Requirements: Node.js 18+, a free [Convex](https://www.convex.dev) account.

```bash
npm install
npx convex dev   # first run: log in via browser, creates a Convex project
```

In a second terminal:

```bash
npm run dev      # Vite dev server on http://localhost:5173
```

The Investec **sandbox** credentials are already public (see
[.env.example](./.env.example) and the community's
[Investec sandbox docs](https://investec.gitbook.io/programmable-banking-community-wiki/get-started/api-quick-start-guide/how-to-authenticate));
set them on your Convex deployment once:

```bash
npx convex env set INVESTEC_BASE_URL "https://openapisandbox.investec.com"
npx convex env set INVESTEC_CLIENT_ID "yAxzQRFX97vOcyQAwluEU6H6ePxMA5eY"
npx convex env set INVESTEC_CLIENT_SECRET "4dY0PjEYqoBrZ99r"
npx convex env set INVESTEC_API_KEY "eUF4elFSRlg5N3ZPY3lRQXdsdUVVNkg2ZVB4TUE1ZVk6YVc1MlpYTjBaV010ZW1FdGNHSXRZV05qYjNWdWRITXRjMkZ1WkdKdmVBPT0="
```

Then either click **"Sync now"** in the app, or seed synthetic demo data
instead/as well:

```bash
npx convex run seed:seedDemoAccount '{}'
```

A cron job (`convex/crons.ts`) also re-syncs every 4 hours automatically.

## 7. What does it not do?

- No payment initiation, transfers, or programmable card rules — read-only.
- No production-grade auth/multi-tenancy — this is a single-deployment demo
  covering whichever accounts the configured Investec credentials expose.
- No machine-learning model — recurring detection and forecasting are both
  deterministic, explainable heuristics by design, so every number on the
  dashboard can be traced back to a rule in this README.
- No financial advice: the affordability calculator shows a projection based
  on stated assumptions, not a guarantee, and says so in the UI.
- AI is **not used** in this build — the "Advanced" tier's natural-language
  chat is a natural next step but was left out in favour of getting the
  forecasting engine and UX right first (see `./knowledge`).

## Tech stack

- **Backend:** [Convex](https://www.convex.dev) — database, scheduled
  functions (cron sync), and server functions (queries/mutations/actions),
  all in TypeScript
- **Frontend:** React + Vite + Tailwind CSS + Recharts

## Project layout

```
convex/
  schema.ts              -- accounts, transactions, recurringSeries, syncRuns, investecToken
  investec/               -- Investec OAuth client, transaction mapping, sync pipeline
  recurring/detect.ts     -- recurring payment/income detection
  forecast/engine.ts      -- pure balance-projection engine
  forecast/queries.ts     -- getForecast / checkAffordability / listRecurringSeries
  seed.ts                 -- synthetic demo data generator
  crons.ts                -- periodic Investec sync
src/
  components/             -- dashboard UI (chart, timeline, affordability calculator, sync button)
  App.tsx
```

## License

[MIT](./LICENSE)
