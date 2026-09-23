import { describe, expect, it, vi } from "vitest";
import {
  InvestecApiError,
  InvestecClient,
  backoffDelayMs,
  classifyEnvironment,
  hostFromBaseUrl,
  isRetryableStatus,
  type CachedToken,
  type TokenCache,
} from "./client";

const config = {
  baseUrl: "https://openapisandbox.investec.com/",
  clientId: "id",
  clientSecret: "secret",
  apiKey: "key",
};

function memoryTokenCache(initial: CachedToken | null = null): TokenCache & { value: CachedToken | null } {
  const cache = {
    value: initial,
    get: async () => cache.value,
    set: async (t: CachedToken) => {
      cache.value = t;
    },
    clear: async () => {
      cache.value = null;
    },
  };
  return cache;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const tokenBody = { access_token: "tok-1", token_type: "Bearer", expires_in: 1799, scope: "accounts" };

/** Build a client whose fetch is a vi.fn and whose sleep records delays. */
function makeClient(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, cache = memoryTokenCache()) {
  const fetchMock = vi.fn(fetchImpl);
  const sleeps: number[] = [];
  const client = new InvestecClient(config, cache, {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    backoffBaseMs: 100,
  });
  return { client, fetchMock, sleeps, cache };
}

describe("InvestecClient auth", () => {
  it("requests a token once, caches it, and sends it as a Bearer", async () => {
    const { client, fetchMock, cache } = makeClient(async (url) => {
      if (url.endsWith("/identity/v2/oauth2/token")) return json(tokenBody);
      return json({ data: { accounts: [] } });
    });
    await client.listAccounts();
    await client.listAccounts();
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(cache.value?.accessToken).toBe("tok-1");
    const [, init] = fetchMock.mock.calls[1];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    // No trailing slash doubling.
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://openapisandbox.investec.com/za/pb/v1/accounts");
  });

  it("clears the cache and retries once on 401", async () => {
    let tokenN = 0;
    const { client, fetchMock } = makeClient(
      async (url, init) => {
        if (url.endsWith("/oauth2/token")) return json({ ...tokenBody, access_token: `tok-${++tokenN}` });
        const auth = (init?.headers as Record<string, string>).authorization;
        if (auth === "Bearer stale") return new Response("expired", { status: 401 });
        return json({ data: { accounts: [{ accountId: "1", accountNumber: "1", accountName: "A" }] } });
      },
      memoryTokenCache({ accessToken: "stale", expiresAt: Date.now() + 60_000 }),
    );
    const accounts = await client.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/oauth2/token"))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 401, token, retry
  });
});

describe("InvestecClient retry / backoff / timeout", () => {
  it("retries 429 and 5xx with exponential backoff, max 3 attempts", async () => {
    let n = 0;
    const { client, fetchMock, sleeps } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      n++;
      if (n === 1) return new Response("slow down", { status: 429 });
      if (n === 2) return new Response("oops", { status: 503 });
      return json({ data: { accounts: [] } });
    });
    await client.listAccounts();
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(200);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeLessThan(300);
    const record = client.calls.find((c) => c.path === "/za/pb/v1/accounts");
    expect(record).toMatchObject({ method: "GET", status: 200, attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after 3 attempts and surfaces the status", async () => {
    const { client, sleeps } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      return json({ title: "An error occurred while processing your request." }, 500);
    });
    const err = await client.listPendingTransactions("x").catch((e) => e);
    expect(err).toBeInstanceOf(InvestecApiError);
    expect((err as InvestecApiError).status).toBe(500);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry 4xx client errors", async () => {
    let n = 0;
    const { client, sleeps } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      n++;
      return new Response("The specified account is invalid. (Parameter 'accountId')", { status: 400 });
    });
    await expect(client.getBalance("000")).rejects.toThrow(/400/u);
    expect(n).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("retries network errors / timeouts and reports a clear message", async () => {
    const { client } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(client.listAccounts()).rejects.toThrow(/failed after 3 attempt\(s\).*timeout/u);
  });

  it("passes an AbortSignal (per-call timeout) to fetch", async () => {
    const { client, fetchMock } = makeClient(async () => json(tokenBody));
    await client.getAccessToken();
    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies statuses and grows backoff geometrically with a cap", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(backoffDelayMs(1, 500)).toBeGreaterThanOrEqual(500);
    expect(backoffDelayMs(3, 500)).toBeGreaterThanOrEqual(2000);
    expect(backoffDelayMs(10, 500)).toBeLessThan(8_200);
  });
});

describe("InvestecClient endpoints", () => {
  it("adds transactionType as a server-side filter only when given", async () => {
    const urls: string[] = [];
    const { client } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      urls.push(url);
      return json({ data: { transactions: [] }, meta: { totalPages: 1 } });
    });
    await client.listTransactions("acc 1", "2025-09-17", "2026-09-17");
    await client.listTransactions("acc 1", "2025-09-17", "2026-09-17", { transactionType: "DebitOrders" });
    expect(urls[0]).toBe(
      "https://openapisandbox.investec.com/za/pb/v1/accounts/acc%201/transactions?fromDate=2025-09-17&toDate=2026-09-17",
    );
    expect(urls[1]).toContain("&transactionType=DebitOrders");
    // Query strings (dates) are not kept in the call log.
    expect(client.calls.at(-1)?.path).toBe("/za/pb/v1/accounts/acc%201/transactions");
  });

  it("parses the balance envelope as returned by the sandbox", async () => {
    const { client } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      return json({
        data: {
          accountId: "3353431574710163189587446",
          currentBalance: 33607.16,
          availableBalance: 33607.16,
          budgetBalance: 0,
          straightBalance: 0,
          cashBalance: 0,
          currency: "ZAR",
        },
        links: { self: "..." },
        meta: { totalPages: 1 },
      });
    });
    const bal = await client.getBalance("3353431574710163189587446");
    expect(bal).toMatchObject({ currentBalance: 33607.16, availableBalance: 33607.16, currency: "ZAR" });
  });

  it("rejects a balance envelope without numeric balances", async () => {
    const { client } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      return json({ data: { accountId: "1" } });
    });
    await expect(client.getBalance("1")).rejects.toThrow(/missing balances/u);
  });

  it("parses pending transactions and the beneficiaries array envelope", async () => {
    const { client } = makeClient(async (url) => {
      if (url.endsWith("/oauth2/token")) return json(tokenBody);
      if (url.endsWith("/pending-transactions")) {
        return json({
          data: {
            transactions: [
              {
                accountId: "1",
                type: "DEBIT",
                status: "PENDING",
                description: "Amazon Retail            Lagos        ZA",
                transactionDate: "2026-09-17",
                amount: 999,
              },
            ],
          },
        });
      }
      if (url.endsWith("/accounts/beneficiaries")) {
        return json({ data: [{ beneficiaryId: "b", name: "FNB Ben", referenceName: null }] });
      }
      return json({ data: {} });
    });
    const pending = await client.listPendingTransactions("1");
    expect(pending).toHaveLength(1);
    expect(pending[0].amount).toBe(999);
    const bens = await client.listBeneficiaries();
    expect(bens[0].name).toBe("FNB Ben");
  });
});

describe("environment helpers", () => {
  it("derives host + environment from INVESTEC_BASE_URL", () => {
    expect(hostFromBaseUrl("https://openapisandbox.investec.com")).toBe("openapisandbox.investec.com");
    expect(hostFromBaseUrl("https://openapi.investec.com/")).toBe("openapi.investec.com");
    expect(hostFromBaseUrl(undefined)).toBeNull();
    expect(classifyEnvironment("openapisandbox.investec.com")).toBe("sandbox");
    expect(classifyEnvironment("openapi.investec.com")).toBe("production");
    expect(classifyEnvironment("localhost:8080")).toBe("unknown");
    expect(classifyEnvironment(null)).toBe("unknown");
  });
});
