import { z } from "zod";
import { GalaxusClient, GalaxusError, globalId, productIdFromInput } from "./client.js";
import { shapeFilters, shapeProductDetail, shapeProductList, shapeProductSummary } from "./shape.js";

export const SORT_ORDERS = ["RELEVANCE", "LOWEST_PRICE", "HIGHEST_PRICE", "RATING", "NEWEST", "AVAILABILITY"] as const;

/**
 * Filters are passed through to the shop verbatim. `filter_id` / `option_ids` come from the
 * `filters` block returned by search and browse results, so a caller can always discover them.
 */
const filterSchema = z
  .object({
    filter_id: z
      .string()
      .describe('Filter identifier from a previous result, e.g. "bra" (brand), "pt" (category), "pr" (price), "rating", or a numeric spec filter id.'),
    option_ids: z.array(z.string()).optional().describe("Option identifiers for checkbox/rating filters."),
    min: z.number().optional().describe("Lower bound for range filters such as `pr` (price)."),
    max: z.number().optional().describe("Upper bound for range filters such as `pr` (price)."),
  })
  .describe("A single facet constraint.");

type FilterInput = z.infer<typeof filterSchema>;

function toGraphqlFilters(filters: FilterInput[] | undefined) {
  return (filters ?? []).map((f) => {
    const out: Record<string, unknown> = { filterIdentifier: f.filter_id };
    if (f.option_ids?.length) out.optionIdentifiers = f.option_ids;
    if (f.min !== undefined) out.min = f.min;
    if (f.max !== undefined) out.max = f.max;
    return out;
  });
}

/** Convenience: let callers say `min_price` instead of hand-assembling the `pr` range filter. */
function withPriceFilter(filters: FilterInput[] | undefined, minPrice?: number, maxPrice?: number): FilterInput[] {
  const list = [...(filters ?? [])];
  if ((minPrice !== undefined || maxPrice !== undefined) && !list.some((f) => f.filter_id === "pr")) {
    list.push({ filter_id: "pr", min: minPrice, max: maxPrice });
  }
  return list;
}

/**
 * The shop's price filter matches a product if *any* variant of it falls in the range, while the
 * price shown for that product is the cheapest variant. A CHF 100-200 search therefore surfaces an
 * CHF 82.90 mouse that happens to have a CHF 3860 colourway. Callers almost always mean the price
 * they will actually pay, so drop the out-of-range rows unless they opt out.
 */
function priceRangeIsStrict(args: { min_price?: number; max_price?: number; strict_price?: boolean }): boolean {
  return args.strict_price !== false && (args.min_price !== undefined || args.max_price !== undefined);
}

function enforcePriceRange<T extends { price: number | null }>(
  products: T[],
  args: { min_price?: number; max_price?: number; strict_price?: boolean; limit?: number },
): T[] {
  if (!priceRangeIsStrict(args)) return products;
  const { min_price, max_price } = args;
  return products
    .filter(
      (p) =>
        p.price !== null &&
        (min_price === undefined || p.price >= min_price) &&
        (max_price === undefined || p.price <= max_price),
    )
    .slice(0, args.limit ?? 20);
}

interface ListArgs {
  min_price?: number;
  max_price?: number;
  strict_price?: boolean;
  limit?: number;
  cursor?: string | null;
}

interface RawPage {
  totalCount?: number;
  edges?: any[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  productFilters?: { edges?: any[] };
}

/**
 * Out-of-range rows are dropped only after the shop has paginated, and under LOWEST_PRICE they
 * crowd the front of the page — a strict CHF 100-200 search can filter a whole page down to
 * nothing. So walk forward a bounded number of pages until the caller's page is full.
 */
async function collectPages(
  fetchPage: (after: string | null, size: number) => Promise<RawPage | undefined>,
  args: ListArgs,
  client: GalaxusClient,
) {
  const limit = args.limit ?? 20;
  const strict = priceRangeIsStrict(args);
  const pageSize = strict ? Math.min(limit * 3, 60) : limit;
  const maxPages = strict ? 4 : 1;

  let after = args.cursor ?? null;
  let totalCount = 0;
  let filters: unknown[] = [];
  let hasNextPage = false;
  const collected: ReturnType<typeof shapeProductList> = [];

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchPage(after, pageSize);
    if (!raw) break;

    totalCount = raw.totalCount ?? totalCount;
    if (!filters.length) filters = shapeFilters(raw.productFilters?.edges);
    collected.push(...enforcePriceRange(shapeProductList(raw.edges, client), { ...args, limit: undefined }));

    hasNextPage = Boolean(raw.pageInfo?.hasNextPage);
    after = raw.pageInfo?.endCursor ?? null;
    if (!hasNextPage || !after || collected.length >= limit) break;
  }

  return {
    total_results: totalCount,
    products: collected.slice(0, limit),
    filters,
    next_cursor: hasNextPage ? after : null,
  };
}

const listShape = {
  filters: z.array(filterSchema).optional().describe("Facet constraints, taken from the `filters` block of an earlier result."),
  min_price: z.number().optional().describe("Minimum price in CHF (shorthand for the `pr` range filter)."),
  max_price: z.number().optional().describe("Maximum price in CHF (shorthand for the `pr` range filter)."),
  strict_price: z
    .boolean()
    .default(true)
    .describe(
      "Keep only products whose own price is inside min_price/max_price. The shop matches a product when any of its " +
        "variants is in range, so turning this off can surface products priced outside the range.",
    ),
  sort: z.enum(SORT_ORDERS).default("RELEVANCE").describe("Result ordering."),
  limit: z.number().int().min(1).max(60).default(20).describe("How many products to return (max 60)."),
  cursor: z.string().nullish().describe("Pass `next_cursor` from a previous result to page further."),
};

export function buildTools(client: GalaxusClient) {
  return [
    {
      name: "galaxus_search",
      title: "Search products",
      description:
        "Full-text product search across the shop. Returns matching products with prices, ratings and availability, " +
        "plus the facets (brand, category, price range, specs) that can be fed back in as `filters` to narrow the search.",
      schema: {
        query: z.string().min(1).describe('What to search for, e.g. "wireless mouse" or "logitech mx master".'),
        ...listShape,
      },
      handler: async (args: any) => {
        const page = await collectPages(
          async (after, size) => {
            const data = await client.query<any>("useSearchDataQuery", {
              query: args.query,
              // Generic queries otherwise resolve to a category redirect and return no products at all.
              searchQueryConfig: { searchQueryId: null, skipAutoFilterPrediction: false, skipRedirect: true },
              first: size,
              after,
              filters: toGraphqlFilters(withPriceFilter(args.filters, args.min_price, args.max_price)),
              sortOrder: args.sort ?? "RELEVANCE",
            });
            return data.shopSearch?.products;
          },
          args,
          client,
        );
        return { query: args.query, ...page };
      },
    },

    {
      name: "galaxus_get_product",
      title: "Get product details",
      description:
        "Full detail for one product: price and previous price, availability and stock, rating, full specifications, " +
        "variants, price-history summary, warranty and return policy. Accepts a numeric product id or a Galaxus product URL.",
      schema: {
        product: z.string().describe("Numeric product id (e.g. 61318913) or a full Galaxus product URL."),
      },
      handler: async (args: any) => {
        const id = productIdFromInput(args.product);
        const data = await client.query<any>("productDetailPageQuery", {
          // The shop resolves the slug by its trailing id, so the numeric id alone is a valid slug.
          slug: id,
          path: `/${client.language}/s1/product/${id}`,
          shopArea: "RETAIL",
          tagIds: [],
          olderThan3MonthTimestamp: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
          isSSR: true,
          hasTrustLevelLowAndIsNotEProcurement: false,
          adventCalendarEnabled: false,
        });
        const product = shapeProductDetail(data.product, client);
        if (!product) throw new GalaxusError(`No product found for "${args.product}".`);
        return product;
      },
    },

    {
      name: "galaxus_autocomplete",
      title: "Autocomplete a search term",
      description:
        "Fast type-ahead lookup. Returns search-term suggestions (with the categories they map to) and a handful of " +
        "directly matching products. Useful to resolve a vague phrase into a concrete product or category before searching.",
      schema: {
        query: z.string().min(1).describe("Partial search term."),
      },
      handler: async (args: any) => {
        const data = await client.query<any>("useInstantSearchApiQuery", { query: args.query });
        const instant = data.instantSearch ?? {};
        return {
          suggestions: (instant.suggestions ?? []).map((s: any) => ({
            term: s.title,
            categories: (s.scopes ?? []).map((sc: any) => ({ id: sc.productTypeId, name: sc.title })),
          })),
          products: (instant.products ?? []).map((p: any) => ({
            id: Number(p.trackingId),
            name: p.nameProperties?.length ? `${p.name} (${p.nameProperties.join(", ")})` : p.name,
            brand: p.brandName ?? null,
            price: p.salesPrice ? Number(p.salesPrice) : null,
            currency: p.currencyIsoCode ?? null,
            was_price: p.insteadOfPrice ? Number(p.insteadOfPrice) : null,
          })),
        };
      },
    },

    {
      name: "galaxus_browse_category",
      title: "Browse a category",
      description:
        "List products in a category (product type) without a search term — the equivalent of opening a category page. " +
        "Category ids come from `galaxus_search` results (`category_id`), the `pt` facet, or `galaxus_autocomplete`.",
      schema: {
        category_id: z.number().int().describe("Numeric product type id, e.g. 62 for Mouse."),
        ...listShape,
      },
      handler: async (args: any) => {
        const page = await collectPages(
          async (after, size) => {
            const data = await client.query<any>("productTypeProductListRelayQuery", {
              navigationItemId: globalId.productTypeNavigation(args.category_id),
              first: size,
              after,
              filters: toGraphqlFilters(withPriceFilter(args.filters, args.min_price, args.max_price)),
              sortOrder: args.sort ?? "RELEVANCE",
              sectorId: globalId.sector(1),
              tagIds: [],
              asPath: `/${client.language}/s1/producttype/-${args.category_id}`,
              debugInfoEnabled: false,
            });
            if (!data.navigationItemById) throw new GalaxusError(`No category found for id ${args.category_id}.`);
            return data.navigationItemById.products;
          },
          args,
          client,
        );
        return { category_id: args.category_id, ...page };
      },
    },

    {
      name: "galaxus_browse_brand",
      title: "Browse a brand",
      description:
        "List products from one brand. Brand ids come from the `bra` facet returned by `galaxus_search` or `galaxus_browse_category`.",
      schema: {
        brand_id: z.number().int().describe("Numeric brand id, e.g. 292 for Logitech."),
        ...listShape,
      },
      handler: async (args: any) => {
        const page = await collectPages(
          async (after, size) => {
            const data = await client.query<any>("brandProductListRelayQuery", {
              brandId: globalId.brand(args.brand_id),
              first: size,
              after,
              filters: toGraphqlFilters(withPriceFilter(args.filters, args.min_price, args.max_price)),
              sortOrder: args.sort ?? "RELEVANCE",
            });
            if (!data.brandById) throw new GalaxusError(`No brand found for id ${args.brand_id}.`);
            return data.brandById.products;
          },
          args,
          client,
        );
        return { brand_id: args.brand_id, ...page };
      },
    },

    {
      name: "galaxus_related_products",
      title: "Find related products",
      description:
        "Products related to a given one: `similar` for alternatives to compare against, `bought_together` for " +
        "complements, `accessories` for add-ons.",
      schema: {
        product: z.string().describe("Numeric product id or Galaxus product URL."),
        kind: z.enum(["similar", "bought_together", "accessories"]).default("similar").describe("Which relationship to follow."),
        limit: z.number().int().min(1).max(30).default(10).describe("How many related products to return."),
      },
      handler: async (args: any) => {
        const id = productIdFromInput(args.product);
        const productId = globalId.product(id);
        const limit = args.limit ?? 10;
        const kind: "similar" | "bought_together" | "accessories" = args.kind ?? "similar";

        // Each recommender takes a different variable set; only `similar` is paginated.
        const request = {
          similar: {
            operation: "similarProductsProductDetailPageRecommenderQuery",
            variables: { productId, first: limit, deviceType: "DESKTOP", shouldShowMiniComparison: false, sessionProductIds: [] },
          },
          bought_together: {
            operation: "productsOftenBoughtTogetherProductDetailPageRecommenderQuery",
            variables: { productId },
          },
          accessories: {
            operation: "accessoriesProductDetailPageRecommenderQuery",
            variables: { productId },
          },
        }[kind];

        const data = await client.query<any>(request.operation, request.variables);
        // Each recommender exposes its results under its own field name; there is only ever one.
        const connection = Object.values(data.productById ?? {}).find(
          (value: any) => value && typeof value === "object" && Array.isArray(value.edges),
        ) as any;

        return {
          product_id: Number(id),
          kind,
          products: shapeProductList(connection?.edges, client).slice(0, limit),
        };
      },
    },

    {
      name: "galaxus_get_review_summary",
      title: "Summarise what reviewers say",
      description:
        "What customers think of a product: the average rating, how many people rated it, and the pros and cons " +
        "reviewers mention most often. Individual review texts are not exposed by the shop's API.",
      schema: {
        product: z.string().describe("Numeric product id or Galaxus product URL."),
      },
      handler: async (args: any) => {
        const id = productIdFromInput(args.product);
        // Keywords and the rating summary live in different operations, so fetch both.
        const [keywordData, detailData] = await Promise.all([
          client.query<any>("productRatingsModuleInnerQuery", { id: globalId.product(id) }),
          client.query<any>("productDetailPageQuery", {
            slug: id,
            path: `/${client.language}/s1/product/${id}`,
            shopArea: "RETAIL",
            tagIds: [],
            olderThan3MonthTimestamp: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
            isSSR: true,
            hasTrustLevelLowAndIsNotEProcurement: false,
            adventCalendarEnabled: false,
          }),
        ]);

        const product = detailData.product;
        if (!product) throw new GalaxusError(`No product found for "${args.product}".`);
        const keywords = keywordData.productById?.reviewsKeywords;

        return {
          product_id: Number(id),
          name: product.name ?? null,
          rating: product.ratingSummary?.ratingCount ? product.ratingSummary.averageRating : null,
          rating_count: product.ratingSummary?.ratingCount ?? 0,
          pros: (keywords?.pros ?? []).map((k: any) => k.displayName),
          cons: (keywords?.contras ?? []).map((k: any) => k.displayName),
          test_report_count: product.testReports?.totalCount ?? 0,
          test_report_average_grade: product.testReports?.averageGrade ?? null,
        };
      },
    },
  ] as const;
}

export type GalaxusTool = ReturnType<typeof buildTools>[number];
