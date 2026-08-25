/**
 * Thin Investec Private Banking API client (read-only endpoints only).
 * Uses OAuth2 client_credentials. Token caching is injected via `TokenCache`
 * so this file has no framework dependency (ported from the household-budget
 * app's Cloudflare-Workers-specific client, which cached in KV).
 *
 * Based on the public Investec Programmable Banking Postman collection:
 * - POST {base}/identity/v2/oauth2/token
 * - GET  {base}/za/pb/v1/accounts
 * - GET  {base}/za/pb/v1/accounts/:id/transactions?fromDate&toDate
 */

const TOKEN_SAFETY_MARGIN_S = 60;

export type InvestecAccount = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  referenceName?: string;
  productName?: string;
  currency?: string;
};

export type InvestecTransaction = {
  accountId: string;
  type: string; // DEBIT | CREDIT
  transactionType?: string;
  status?: string;
  description: string;
  cardNumber?: string;
  postedOrder?: number;
  postingDate?: string;
  valueDate?: string;
  actionDate?: string;
  transactionDate?: string;
  amount: number;
  runningBalance?: number;
  uuid?: string;
  currencyCode?: string;
  mcc?: string;
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

export type InvestecClientConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
};

export class InvestecClient {
  private config: InvestecClientConfig;
  private tokenCache: TokenCache;

  constructor(config: InvestecClientConfig, tokenCache: TokenCache) {
    this.config = config;
    this.tokenCache = tokenCache;
  }

  private get baseUrl() {
    return this.config.baseUrl.replace(/\/$/u, "");
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
    const res = await fetch(`${this.baseUrl}/identity/v2/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        "x-api-key": this.config.apiKey,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Investec token error ${res.status}: ${text}`);
    }
    return (await res.json()) as TokenResponse;
  }

  private async apiFetch<T>(path: string): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    if (res.status === 401) {
      // Token may have expired unexpectedly; purge cache and retry once.
      await this.tokenCache.clear();
      const retryToken = await this.getAccessToken();
      const res2 = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${retryToken}`,
          accept: "application/json",
        },
      });
      if (!res2.ok) {
        throw new Error(`Investec API error ${res2.status}: ${await res2.text()}`);
      }
      return (await res2.json()) as T;
    }
    if (!res.ok) {
      throw new Error(`Investec API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async listAccounts(): Promise<InvestecAccount[]> {
    const env = await this.apiFetch<EnvelopeAccounts>("/za/pb/v1/accounts");
    return env.data.accounts;
  }

  async listTransactions(
    accountId: string,
    fromDate: string,
    toDate: string,
  ): Promise<InvestecTransaction[]> {
    const qs = new URLSearchParams({ fromDate, toDate });
    const env = await this.apiFetch<EnvelopeTransactions>(
      `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/transactions?${qs}`,
    );
    return env.data.transactions;
  }
}
