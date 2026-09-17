/**
 * Heuristic, explainable categorisation of recurring series.
 *
 * Two signals: merchant/description keywords (below) and the Investec
 * `transactionType` (e.g. "DebitOrders", "FeesAndInterest"). Keywords are
 * matched as whole words/phrases (case-insensitive, optional plural "s") so
 * "fee" does not match "COFFEE" and "rain" does not match "TRAIN".
 *
 * To extend: add a keyword to the relevant entry, or add a new entry. Earlier
 * entries win when several match, so keep the more specific ones first.
 */

export type SeriesCategory =
  | "subscription"
  | "utility"
  | "insurance"
  | "loan"
  | "rent"
  | "income"
  | "fees"
  | "groceries"
  | "telecom"
  | "other";

export const CATEGORY_KEYWORDS: ReadonlyArray<{
  category: SeriesCategory;
  keywords: readonly string[];
}> = [
  {
    category: "subscription",
    keywords: [
      "netflix",
      "spotify",
      "showmax",
      "dstv",
      "multichoice",
      "apple",
      "google",
      "microsoft",
      "youtube",
      "amazon prime",
      "prime video",
      "disney",
      "gym",
      "virgin active",
      "planet fitness",
    ],
  },
  {
    category: "loan",
    keywords: [
      "home loan",
      "h loan",
      "nedbhl",
      "vehicle finance",
      "wesbank",
      "mfc",
      "bond",
      "absa hl",
      "fnb h loan",
      "loan",
    ],
  },
  {
    category: "insurance",
    keywords: [
      "outsurance",
      "discovery",
      "momentum",
      "santam",
      "liberty",
      "sanlam",
      "old mutual",
      "medical",
      "mommed",
      "insurance",
      "assurance",
    ],
  },
  {
    category: "utility",
    keywords: [
      "city power",
      "eskom",
      "electricity",
      "water",
      "municipality",
      "rates",
      "prepaid",
      "joburg",
      "ekurhuleni",
      "tshwane",
      "city of cape town",
    ],
  },
  {
    category: "rent",
    keywords: ["rent", "rental", "levy", "levies", "hoa", "body corporate"],
  },
  {
    category: "income",
    keywords: ["salary", "salaries", "wages", "payroll"],
  },
  {
    category: "telecom",
    keywords: [
      "vodacom",
      "mtn",
      "cell c",
      "telkom",
      "rain",
      "airtime",
      "fibre",
      "afrihost",
      "webafrica",
      "vumatel",
    ],
  },
  {
    category: "groceries",
    keywords: [
      "woolworths",
      "checkers",
      "pnp",
      "pick n pay",
      "spar",
      "shoprite",
      "food lover",
    ],
  },
  {
    category: "fees",
    keywords: ["service charge", "service fee", "fee", "interest", "bank charges"],
  },
];

/** Investec transactionType → category, used when no keyword matches. */
const TRANSACTION_TYPE_CATEGORY: Readonly<Record<string, SeriesCategory>> = {
  FeesAndInterest: "fees",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const compiled = CATEGORY_KEYWORDS.map((entry) => ({
  category: entry.category,
  patterns: entry.keywords.map(
    (k) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(k.toLowerCase())}s?(?![a-z0-9])`, "i"),
  ),
}));

export type CategoriseInput = {
  /** Merchant name and/or description text (concatenated is fine). */
  text: string;
  transactionType?: string | null;
  direction: "debit" | "credit";
  isPayday?: boolean;
};

/** Returns the matching category and the keyword that matched (for explainability). */
export function categoriseSeries(input: CategoriseInput): {
  category: SeriesCategory;
  matchedKeyword: string | null;
} {
  const text = input.text.toLowerCase();
  for (let i = 0; i < compiled.length; i++) {
    const { category, patterns } = compiled[i];
    for (let j = 0; j < patterns.length; j++) {
      if (patterns[j].test(text)) {
        // "rent"/"loan" etc. on a credit are refunds or transfers, not bills.
        if (input.direction === "credit" && category !== "income") continue;
        return { category, matchedKeyword: CATEGORY_KEYWORDS[i].keywords[j] };
      }
    }
  }
  if (input.isPayday) return { category: "income", matchedKeyword: null };
  const byType = input.transactionType ? TRANSACTION_TYPE_CATEGORY[input.transactionType] : undefined;
  if (byType) return { category: byType, matchedKeyword: null };
  return { category: "other", matchedKeyword: null };
}
