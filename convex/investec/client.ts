/**
 * Thin Investec Private Banking API client (read-only endpoints only).
 * Uses OAuth2 client_credentials. Token caching is injected via `TokenCache`
 * so this file has no framework dependency (ported from the household-budget
 * app's Cloudflare-Workers-specific client, which cached in KV).
 *
 * Endpoints (see docs/investec-api.md for the real sandbox response shapes):
 * - POST {base}/identity/v2/oauth2/token
 * - GET  {base}/za/pb/v1/accounts
 * - GET  {base}/za/pb/v1/accounts/:id/balance
 * - GET  {base}/za/pb/v1/accounts/:id/transactions?fromDate&toDate[&transactionType]
 * - GET  {base}/za/pb/v1/accounts/:id/pending-transactions
 * - GET  {base}/za/pb/v1/accounts/beneficiaries
 *
 * Resilience: every call has a per-request timeout and retries 429 / 5xx /
 * network failures with exponential backoff (max 3 attempts). `fetch` and
 * `sleep` are injectable so tests never touch the network or real timers.
 */

const TOKEN_SAFETY_MARGIN_S = 60;
/** Upstream calls must never hang a sync open indefinitely. */
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 500;

export type InvestecAccount = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  referenceName?: string;
  productName?: string;
  /** Not returned by the sandbox; kept for production currency pockets. */
  currency?: string;
  kycCompliant?: boolean;
  profileId?: string;
  profileName?: string;
};

export type InvestecTransaction = {
  accountId: string;
  type: string; // DEBIT | CREDIT
  /** e.g. "CardPurchases" | "DebitOrders" | "OnlineBankingPayments" | "Deposits"
   * | "FeesAndInterest" | "ATMWithdrawals" | "VASTransactions" | "FasterPay".
   * The sandbox returns `null` for savings/investment product rows. */
  transactionType?: string | null;
  status?: string | null; // "POSTED" on the transactions endpoint
  description: string;
  cardNumber?: string | null;
  postedOrder?: number | null;
  postingDate?: string | null;
  valueDate?: string | null;
  actionDate?: string | null;
  transactionDate?: string | null;
  amount: number;
  runningBalance?: number | null;
  uuid?: string | null;
  currencyCode?: string | null;
  mcc?: string | null;
};

export type InvestecPendingTransaction = {
  accountId: string;
  type: string; // DEBIT | CREDIT
  status?: string | null; // "PENDING"
  description: string;
  transactionDate?: string | null;
  amount: number;
};

export type InvestecBalance = {
  accountId: string;
  currentBalance: number;
  availableBalance: number;
  currency: string;
  budgetBalance?: number | null;
  straightBalance?: number | null;
  cashBalance?: number | null;
};

export type InvestecBeneficiary = {
  beneficiaryId: string;
  /** User-assigned label (e.g. "FNB Ben"). Can be null in the sandbox. */
  name: string | null;
  /** The beneficiary's registered name at their bank. */
  beneficiaryName: string | null;
  accountNumber: string | null;
  code: string | null;
  bank: string | null;
  /** The default `myReference` pre-filled when paying this beneficiary — it
   * is what shows up in your own statement description. */
  referenceName: string | null;
  referenceAccountNumber?: string | null;
  /** Formatted with thousands separators, e.g. "10,000.00". */
  lastPaymentAmount: string | null;
  /** "dd/MM/yyyy" or "Never been Paid". */
  lastPaymentDate: string | null;
  cellNo?: string | null;
  emailAddress?: string | null;
  categoryId?: string | null;
  profileId?: string | null;
  beneficiaryType?: string | null;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export type CachedToken = { accessToken: string; expiresAt: number };

export type TokenCache = {
  get(): Promise<CachedToken | null>;
  set(token: CachedToken): Promise<unknown>;
  clear(): Promise<unknown>;
};

type EnvelopeAccounts = { data: { accounts: InvestecAccount[] } };
type EnvelopeTransactions = {
  data: { transactions: InvestecTransaction[] };
  links?: { self?: string };
  meta?: { totalPages?: number };
};
type EnvelopePending = { data: { transactions: InvestecPendingTransaction[] } };
type EnvelopeBalance = { data: InvestecBalance };
type EnvelopeBeneficiaries = { data: InvestecBeneficiary[] };

export type InvestecClientConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
};

export type InvestecClientOptions = {
  /** Defaults to globalThis.fetch (resolved per call so test stubs work). */
  fetch?: typeof fetch;
  /** Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
};

/** One entry per logical API call, for provenance / debugging. */
export type InvestecCallRecord = {
  method: "GET" | "POST";
  path: string; // without query string
  status: number | null; // null = never got a response
  attempts: number;
  durationMs: number;
};

export class InvestecApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Investec API error ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "InvestecApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** Only the path part (no query string) — never log dates/filters. */
function pathOnly(pathWithQuery: string): string {
  const i = pathWithQuery.indexOf("?");
  return i === -1 ? pathWithQuery : pathWithQuery.slice(0, i);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** 500ms, 1s, 2s, ... capped at 8s, plus a little jitter. */
export function backoffDelayMs(attempt: number, baseMs = DEFAULT_BACKOFF_BASE_MS): number {
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 8_000);
  return exp + Math.floor(Math.random() * 100);
}

export class InvestecClient {
  private config: InvestecClientConfig;
  private tokenCache: TokenCache;
  private opts: Required<Omit<InvestecClientOptions, "fetch">> & { fetch?: typeof fetch };
  readonly calls: InvestecCallRecord[] = [];

  constructor(config: InvestecClientConfig, tokenCache: TokenCache, opts: InvestecClientOptions = {}) {
    this.config = config;
    this.tokenCache = tokenCache;
    this.opts = {
      fetch: opts.fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs: opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    };
  }

  private get baseUrl() {
    return this.config.baseUrl.replace(/\/$/u, "");
  }

  /** Hostname of the configured base URL (e.g. "openapisandbox.investec.com"). */
  get host(): string {
    return hostFromBaseUrl(this.config.baseUrl) ?? this.baseUrl;
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.opts.fetch ?? globalThis.fetch;
    return f(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
  }

  /**
   * fetch with timeout + exponential backoff. Retries on 429, 5xx and
   * network/timeout errors up to `maxAttempts` total tries. Returns the last
   * response (even if not ok) so callers can handle 401 etc.
   */
  private async fetchWithRetry(
    method: "GET" | "POST",
    pathWithQuery: string,
    init: RequestInit,
  ): Promise<Response> {
    const path = pathOnly(pathWithQuery);
    const started = Date.now();
    let attempt = 0;
    let lastError: unknown = null;
    let res: Response | null = null;
    while (attempt < this.opts.maxAttempts) {
      attempt++;
      try {
        res = await this.doFetch(`${this.baseUrl}${pathWithQuery}`, { ...init, method });
        lastError = null;
        if (!isRetryableStatus(res.status)) break;
      } catch (err) {
        lastError = err;
        res = null;
      }
      if (attempt < this.opts.maxAttempts) {
        await this.opts.sleep(backoffDelayMs(attempt, this.opts.backoffBaseMs));
      }
    }
    this.calls.push({
      method,
      path,
      status: res?.status ?? null,
      attempts: attempt,
      durationMs: Date.now() - started,
    });
    if (!res) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Investec request failed after ${attempt} attempt(s) on ${path}: ${msg}`);
    }
    return res;
  }

  async getAccessToken(): Promise<string> {
    const cached = await this.tokenCache.get();
    if (cached && cached.expiresAt > Date.now() + 5000) {
      return cached.accessToken;
    }
    const token = await this.requestNewToken();
    await this.tokenCache.set({
      accessToken: token.access_token,
      expiresAt: Date.now() + (token.expires_in - TOKEN_SAFETY_MARGIN_S) * 1000,
    });
    return token.access_token;
  }

  private async requestNewToken(): Promise<TokenResponse> {
    const creds = `${this.config.clientId}:${this.config.clientSecret}`;
    const basic = btoa(creds);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "accounts",
    });
    const path = "/identity/v2/oauth2/token";
    const res = await this.fetchWithRetry("POST", path, {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        "x-api-key": this.config.apiKey,
      },
      body,
    });
    if (!res.ok) {
      throw new InvestecApiError(res.status, path, await res.text());
    }
    return (await res.json()) as TokenResponse;
  }

  private async apiFetch<T>(pathWithQuery: string): Promise<T> {
    const path = pathOnly(pathWithQuery);
    const headersFor = (token: string) => ({
      authorization: `Bearer ${token}`,
      accept: "application/json",
    });
    const token = await this.getAccessToken();
    let res = await this.fetchWithRetry("GET", pathWithQuery, { headers: headersFor(token) });
    if (res.status === 401) {
      // Token may have expired unexpectedly; purge cache and retry once.
      await this.tokenCache.clear();
      const retryToken = await this.getAccessToken();
      res = await this.fetchWithRetry("GET", pathWithQuery, { headers: headersFor(retryToken) });
    }
    if (!res.ok) {
      throw new InvestecApiError(res.status, path, await res.text());
    }
    return (await res.json()) as T;
  }

  async listAccounts(): Promise<InvestecAccount[]> {
    const env = await this.apiFetch<EnvelopeAccounts>("/za/pb/v1/accounts");
    return env.data?.accounts ?? [];
  }

  /** GET /za/pb/v1/accounts/:id/balance — authoritative current + available balance. */
  async getBalance(accountId: string): Promise<InvestecBalance> {
    const env = await this.apiFetch<EnvelopeBalance>(
      `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/balance`,
    );
    const d = env.data;
    if (!d || typeof d.availableBalance !== "number" || typeof d.currentBalance !== "number") {
      throw new Error(`Investec balance response missing balances for account ${accountId}`);
    }
    return {
      accountId: d.accountId ?? accountId,
      currentBalance: d.currentBalance,
      availableBalance: d.availableBalance,
      currency: (d.currency ?? "ZAR").toUpperCase(),
      budgetBalance: d.budgetBalance ?? null,
      straightBalance: d.straightBalance ?? null,
      cashBalance: d.cashBalance ?? null,
    };
  }

  /**
   * GET /za/pb/v1/accounts/:id/transactions?fromDate&toDate[&transactionType]
   * `transactionType` is a server-side filter (e.g. "DebitOrders"); an
   * unknown value yields an empty list rather than an error.
   */
  async listTransactions(
    accountId: string,
    fromDate: string,
    toDate: string,
    options: { transactionType?: string } = {},
  ): Promise<InvestecTransaction[]> {
    const qs = new URLSearchParams({ fromDate, toDate });
    if (options.transactionType) qs.set("transactionType", options.transactionType);
    const env = await this.apiFetch<EnvelopeTransactions>(
      `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/transactions?${qs}`,
    );
    return env.data?.transactions ?? [];
  }

  /** GET /za/pb/v1/accounts/:id/pending-transactions — card holds etc. that
   * have not posted yet. The sandbox only implements this for one account
   * (others return 500), so callers should treat failures as "unavailable". */
  async listPendingTransactions(accountId: string): Promise<InvestecPendingTransaction[]> {
    const env = await this.apiFetch<EnvelopePending>(
      `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/pending-transactions`,
    );
    return env.data?.transactions ?? [];
  }

  /** GET /za/pb/v1/accounts/beneficiaries — saved payees (profile-wide). */
  async listBeneficiaries(): Promise<InvestecBeneficiary[]> {
    const env = await this.apiFetch<EnvelopeBeneficiaries>("/za/pb/v1/accounts/beneficiaries");
    return Array.isArray(env.data) ? env.data : [];
  }
}

export function hostFromBaseUrl(baseUrl: string | undefined | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "") || null;
  }
}

export type InvestecEnvironment = "sandbox" | "production" | "unknown";

/** The sandbox and production APIs live on different hosts (see `knowledge`). */
export function classifyEnvironment(host: string | null): InvestecEnvironment {
  if (!host) return "unknown";
  if (/sandbox/iu.test(host)) return "sandbox";
  if (/^openapi\.investec\.com$/iu.test(host)) return "production";
  return "unknown";
}
