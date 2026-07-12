import operationsFile from "./operations.json" with { type: "json" };

const OPERATIONS: Record<string, string> = operationsFile.operations;

export type Portal = "galaxus" | "digitec";
export type Language = "en" | "de" | "fr" | "it";

const PORTALS: Record<Portal, { id: string; host: string }> = {
  galaxus: { id: "22", host: "https://www.galaxus.ch" },
  digitec: { id: "25", host: "https://www.digitec.ch" },
};

const LANGUAGE_TAGS: Record<Language, string> = {
  en: "en-US",
  de: "de-CH",
  fr: "fr-CH",
  it: "it-CH",
};

export class GalaxusError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "GalaxusError";
  }
}

/** What the shop says (inside a 200 response) when an operation hash no longer matches its build. */
export const STALE_HASH_MESSAGE = "The specified persisted operation key is invalid.";

/** Exposed so the hash checker can probe every operation without knowing its variables. */
export const OPERATION_NAMES = Object.keys(OPERATIONS);

export interface ClientOptions {
  portal?: Portal;
  language?: Language;
  timeoutMs?: number;
}

/**
 * The storefront only accepts persisted (pre-registered) GraphQL operations: the operation hash is
 * part of the URL and the request body carries variables only. Sending query text returns 404.
 */
export class GalaxusClient {
  readonly portal: Portal;
  readonly language: Language;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.portal = opts.portal ?? "galaxus";
    this.language = opts.language ?? "en";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get host(): string {
    return PORTALS[this.portal].host;
  }

  /** Absolute URL for a path the API returns relative (`/en/s1/product/...`). */
  absoluteUrl(relative: string | null | undefined): string | null {
    if (!relative) return null;
    return relative.startsWith("http") ? relative : `${this.host}${relative}`;
  }

  /** Image paths come back without a host and without an extension on some fields. */
  imageUrl(relative: string | null | undefined): string | null {
    if (!relative) return null;
    if (relative.startsWith("http")) return relative;
    const path = relative.startsWith("/im/") ? relative : `/im${relative}`;
    return `${this.host}${path}`;
  }

  async query<T = unknown>(operation: string, variables: Record<string, unknown>): Promise<T> {
    const hash = OPERATIONS[operation];
    if (!hash) throw new GalaxusError(`Unknown operation "${operation}"`);

    const { id: portalId, host } = PORTALS[this.portal];
    const languageTag = LANGUAGE_TAGS[this.language];

    const res = await fetch(`${host}/graphql/o/${hash}/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/graphql-response+json; charset=utf-8, application/json; charset=utf-8",
        "accept-language": languageTag,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "x-dg-portal": portalId,
        "x-dg-language": languageTag,
        "x-dg-graphql-client-name": "isomorph",
        origin: host,
        referer: `${host}/${this.language}/`,
      },
      body: JSON.stringify({ variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 404 || (!res.ok && res.status !== 400)) {
      throw new GalaxusError(`Galaxus API returned HTTP ${res.status} for ${operation}.`);
    }

    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      const messages = body.errors.map((e) => e.message).join("; ");
      // A rotated hash is not an HTTP error: the shop answers 200 and rejects the key in-band.
      if (messages.includes(STALE_HASH_MESSAGE)) {
        throw new GalaxusError(
          `The persisted hash for "${operation}" is no longer accepted by the shop.`,
          "Galaxus deployed a new frontend and rotated its query hashes. Run `npm run refresh-hashes` (then `npm run build`) to re-capture them.",
        );
      }
      throw new GalaxusError(`Galaxus API error on ${operation}: ${messages}`);
    }
    if (!body.data) throw new GalaxusError(`Galaxus API returned no data for ${operation}.`);
    return body.data;
  }
}

/** Relay global IDs are base64 of `<Type>\n<kind><id>` — reconstructable without a round trip. */
export const globalId = {
  product: (databaseId: number | string) => Buffer.from(`Product\nd${databaseId}`).toString("base64"),
  brand: (databaseId: number | string) => Buffer.from(`Brand\ni${databaseId}`).toString("base64"),
  sector: (databaseId: number | string) => Buffer.from(`Sector\ni${databaseId}`).toString("base64"),
  /** Navigation item for a product type; the shop also accepts this short form of the tree path. */
  productTypeNavigation: (productTypeId: number | string) =>
    Buffer.from(`NavigationItem\ndsa:retail/pt:${productTypeId}`).toString("base64"),
};

/** Product URLs look like `/en/s1/product/<slug>-<databaseId>`; the id alone resolves fine. */
export function productIdFromInput(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/(\d{4,})(?:\?|#|$)/);
  if (!match) {
    throw new GalaxusError(
      `Could not read a product id from "${input}".`,
      "Pass the numeric product id or a Galaxus product URL (the id is the trailing number).",
    );
  }
  return match[1];
}
