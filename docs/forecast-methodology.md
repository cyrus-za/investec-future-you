# Forecast methodology

How Future You projects your balance, and exactly what each number means. Everything here is a
deterministic estimate derived from your Investec transaction history — **not a guarantee and not
financial advice**.

## Inputs

- **Current balance** — the latest available balance from your Investec account (balance endpoint
  when available, otherwise the running balance on the most recent transaction).
- **Recurring series** — payments and income detected from your transaction history, each with a
  cadence (weekly / biweekly / monthly), a typical amount, a predicted next date, a confidence
  score (0–1), and an amount-variance score (0 = fixed amount, higher = more variable).
- **Variable spend** (optional) — your typical day-to-day spending, computed as the **median daily
  debit over the last 8 weeks**, excluding every transaction that belongs to a detected recurring
  series. Days with no spend count as R0, so the median reflects a *typical* day rather than an
  average inflated by big one-offs.

## The projection

Starting from today's balance, the engine steps day by day through the horizon (30/60/90 days),
applying each predicted recurring event on its date and — when enabled — draining the
variable-spend estimate once per day (starting tomorrow, so today always equals your real balance).
Monthly series step by calendar months so day-of-month stays aligned.

## What the numbers mean

- **Expected line** — all detected series at their typical amounts.
- **Optimistic band** — only series with confidence ≥ 0.6, and no discretionary spend at all.
  This is a ceiling, not a target.
- **Pessimistic band** — every debit scaled up by `1 + amountVariance` (variable bills come in
  high). Income is *never* scaled up, so the pessimistic case stays conservative.
- **Safe to spend** — `max(0, lowest expected balance before the next payday − safety buffer)`.
  If no payday is detected, the window is the full horizon. It answers "how much extra could I
  spend right now without my projected balance dipping below my buffer before I'm next paid?".
- **Runway** — the number of days until the expected projection first touches your safety buffer,
  or "never within the horizon".

## Scenarios

Pausing a recurring series or adding a one-off what-if expense/income re-runs the same engine with
those changes and shows the live safe-to-spend delta. Scenarios change the projection only — they
never touch real payments.

## Assumptions and limitations

- Detection can miss irregular payments or misclassify a one-off as recurring; confidence scores
  expose that uncertainty rather than hiding it.
- The variable-spend baseline assumes the next 8 weeks look roughly like the last 8.
- Predicted dates are estimates; a debit order landing a day early can shift the low point.
- Nothing here accounts for overdraft limits, fees, interest, or pending authorisations beyond
  what has already posted.
