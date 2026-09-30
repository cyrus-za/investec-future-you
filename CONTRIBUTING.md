# Contributing

This is a bounty demo, but the same checks CI runs should pass before you push.

```bash
npm install
npm test
npm run lint
npx tsc -p convex/tsconfig.json --noEmit && npx tsc -b
```

`npm run typecheck` also runs `npx convex codegen`, which needs a Convex login and the dev deployment in `.env.local`. Commit any `convex/_generated` diff that codegen produces.

## Layout

- Pure logic (detection, forecast, categorisation rules, chat prompt/tools) lives next to its Convex wrappers so it can be tested without a deployment. Prefer `convex-test` for anything that reads or writes the database.
- Do not call `ctx.runAction` / `ctx.runMutation` back into the same file. Extract a plain function. See `knowledge`.
- Investec calls stay in `convex/investec/`. Sandbox host is `openapisandbox.investec.com`, not `openapi.investec.com`.

## What not to commit

- `.env.local` (dev deployment URL is fine in `.env.production`; it is public).
- `OPENAI_API_KEY` or any non-sandbox credential. Sandbox demo credentials in the README are Investec's published ones.
