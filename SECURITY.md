# Security

This is a single-deployment demo, not a multi-tenant production bank app.

- **Read-only.** The Investec client requests the `accounts` scope only. There is no payment, transfer, or card-control call.
- **Sandbox data.** The published demo uses Investec's public sandbox credentials against `openapisandbox.investec.com`. Do not point `INVESTEC_BASE_URL` at production with real customer credentials in this repo.
- **Secrets stay on Convex.** `INVESTEC_CLIENT_SECRET`, `INVESTEC_API_KEY`, and `OPENAI_API_KEY` are deployment env vars. The frontend only receives `VITE_CONVEX_URL`. The chat status action returns whether a key is set, never the key.
- **The model cannot move money or invent balances.** Chat tools call the same forecast and category queries the dashboard uses. Tool calls are shown in the UI.
- **No auth.** Anyone who can open the deployment can read the synced sandbox accounts. Do not sync a real private account into this demo.

Report issues on the GitHub repo.
