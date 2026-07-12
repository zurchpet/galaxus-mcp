import type { GalaxusClient } from "./client.js";

/**
 * The storefront returns 20-50 KB of view-model per request. Everything here trims that to the
 * fields an assistant actually reasons about, so tool results stay inside a sane token budget.
 */

const AVAILABILITY_TEXT: Record<string, string> = {
  IN_STOCK: "in stock",
  ONE_DAY: "ships in ~1 day",
  TWO_DAYS: "ships in ~2 days",
  THREE_DAYS: "ships in ~3 days",
  WITHIN7_DAYS: "ships within 7 days",
  LONGER_THAN_A_WEEK: "ships in over a week",
  ON_DEMAND: "on demand",
  NOT_AVAILABLE: "not available",
  UNKNOWN: "availability unknown",
};

function availabilityText(availability: any): string | null {
  const classification = availability?.mail?.classification ?? availability?.mailDetail?.classification;
  if (!classification) return null;
  return AVAILABILITY_TEXT[classification] ?? classification.toLowerCase().replace(/_/g, " ");
}

export interface ProductSummary {
  id: number;
  name: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  was_price: number | null;
  discount_pct: number | null;
  rating: number | null;
  rating_count: number | null;
  availability: string | null;
  category: string | null;
  category_id: number | null;
  url: string | null;
}

export function shapeProductSummary(node: any, client: GalaxusClient): ProductSummary | null {
  if (!node) return null;
  const price = node.price?.amountInclusive ?? null;
  const wasPrice = node.insteadOfPrice?.amountInclusive ?? null;
  const properties = node.nameExtensions?.properties ?? null;
  const rating = node.ratingSummary?.ratingCount ? node.ratingSummary.averageRating : null;

  return {
    id: node.databaseId ?? null,
    name: properties ? `${node.name} (${properties})` : node.name,
    brand: node.brand?.name ?? null,
    price,
    currency: node.price?.currency ?? null,
    was_price: wasPrice,
    discount_pct: price && wasPrice && wasPrice > price ? Math.round((1 - price / wasPrice) * 100) : null,
    rating,
    rating_count: node.ratingSummary?.ratingCount ?? null,
    availability: availabilityText(node.availability),
    category: node.productType?.name ?? null,
    category_id: node.productType?.databaseId ?? null,
    url: client.absoluteUrl(node.relativeUrl),
  };
}

export function shapeProductList(edges: any[] | undefined, client: GalaxusClient): ProductSummary[] {
  return (edges ?? [])
    .map((edge) => shapeProductSummary(edge?.node?.product ?? edge?.node, client))
    .filter((p): p is ProductSummary => p !== null && p.id != null);
}

/**
 * Facets are how an assistant discovers what it can filter on next: the identifiers returned here
 * feed straight back into the `filters` argument of the search and browse tools.
 */
export function shapeFilters(filterEdges: any[] | undefined, maxOptions = 8) {
  return (filterEdges ?? [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((node: any) => {
      const base = { id: node.identifier, name: node.title };
      if (node.__typename === "RangeFilter") {
        return { ...base, type: "range" as const, min: node.min, max: node.max, unit: node.unitName ?? null };
      }
      const options = [...(node.pinnedOptions ?? []), ...(node.commonOptions ?? []), ...(node.options ?? [])]
        .slice(0, maxOptions)
        .map((o: any) => ({ id: o.optionIdentifier, name: o.title ?? o.optionIdentifier, count: o.count }));
      if (!options.length) return null;
      return { ...base, type: node.__typename === "RatingFilter" ? ("rating" as const) : ("checkbox" as const), options };
    })
    .filter(Boolean);
}

/** Specification values are a typed union — flatten each variant to a plain string. */
function specValueToText(value: any): string | null {
  if (!value) return null;
  switch (value.__typename) {
    case "ProductSpecificationTextValue":
      return value.text ?? null;
    case "ProductSpecificationBrandValue":
      return value.brand?.name ?? null;
    case "ProductSpecificationProductTypeValue":
      return value.productType?.name ?? null;
    case "ProductSpecificationReleaseDateValue":
      return value.releasedAt ?? null;
    default:
      return value.text ?? value.name ?? null;
  }
}

function specsToRecord(specifications: any[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specifications ?? []) {
    const text = specValueToText(spec?.value);
    if (spec?.title && text) out[spec.title] = text;
  }
  return out;
}

function shapePriceHistory(priceHistory: any) {
  const summary = priceHistory?.summary;
  if (!summary) return null;
  const low = summary.fluctuation?.low?.amountInclusive ?? null;
  const high = summary.fluctuation?.high?.amountInclusive ?? null;
  if (low === null && high === null) return null;
  return {
    trend: summary.type ?? null,
    fluctuation: summary.fluctuation?.type ?? null,
    lowest: low,
    highest: high,
    has_history_older_than_3_months: priceHistory.hasHistoryOlderThan3Months ?? null,
  };
}

export function shapeProductDetail(product: any, client: GalaxusClient) {
  if (!product) return null;
  const summary = shapeProductSummary(product, client)!;
  const delivery = product.availability?.mailDetail?.expectedDelivery;

  return {
    ...summary,
    gtin: product.gtin ?? null,
    merchant: product.merchant?.name ?? null,
    marketplace: product.offer?.shopOfferType === "MARKETPLACE",
    stock_count: product.availability?.mailDetail?.stockDetails?.stockCount ?? null,
    expected_delivery: delivery ? { from: delivery.from, to: delivery.to } : null,
    breadcrumbs: (product.productType?.breadcrumbs ?? []).map((b: any) => b?.name).filter(Boolean),
    description: product.description ?? null,
    key_specs: specsToRecord(product.keySpecificationGroup?.specifications),
    specifications: (product.specificationGroups?.edges ?? []).reduce(
      (acc: Record<string, Record<string, string>>, edge: any) => {
        const group = edge?.node;
        const specs = specsToRecord(group?.specifications);
        if (group?.name && Object.keys(specs).length) acc[group.name] = specs;
        return acc;
      },
      {},
    ),
    price_history: shapePriceHistory(product.priceHistory),
    energy_efficiency: product.energyEfficiency?.energyEfficiencyLabel ?? null,
    warranty: product.warrantyDescription?.description ?? null,
    return_policy: product.returnPolicy?.description ?? null,
    variants: (product.variantGroups?.edges ?? []).flatMap((groupEdge: any) => {
      const group = groupEdge?.node;
      return (group?.variants?.edges ?? []).slice(0, 15).map((variantEdge: any) => ({
        group: group?.title ?? null,
        value: variantEdge?.node?.title ?? null,
        id: variantEdge?.node?.product?.databaseId ?? null,
        price: variantEdge?.node?.product?.price?.amountInclusive ?? null,
      }));
    }),
    images: (product.galleryImages?.edges ?? [])
      .slice(0, 5)
      .map((edge: any) => client.imageUrl(edge?.node?.relativeUrl))
      .filter(Boolean),
    questions_answered: product.answeredQuestions?.totalCount ?? null,
    test_reports: product.testReports?.totalCount ?? null,
  };
}
