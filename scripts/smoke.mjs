/**
 * Exercises every tool against the live shop. Run with `npm run smoke` after `npm run build`.
 * Prints a compact per-tool verdict so a regression in the upstream API is obvious.
 */
import { GalaxusClient } from "../dist/client.js";
import { buildTools } from "../dist/tools.js";

const client = new GalaxusClient({ portal: "galaxus", language: "en" });
const tools = Object.fromEntries(buildTools(client).map((tool) => [tool.name, tool]));

const results = [];
async function check(name, args, describe, label = name) {
  try {
    const result = await tools[name].handler(args);
    results.push({ name: label, ok: true, detail: describe(result) });
    return result;
  } catch (error) {
    results.push({ name: label, ok: false, detail: error.message });
    return null;
  }
}

const search = await check(
  "galaxus_search",
  { query: "logitech mx master", limit: 5, sort: "RELEVANCE" },
  (r) => `${r.total_results} hits, top: ${r.products[0]?.name} CHF${r.products[0]?.price}, ${r.filters.length} facets`,
);

const productId = search?.products?.[0]?.id ?? 61318913;

await check(
  "galaxus_search",
  { query: "wireless mouse", min_price: 30, max_price: 80, sort: "LOWEST_PRICE", limit: 3 },
  (r) => `${r.total_results} hits, prices: ${r.products.map((p) => p.price).join(", ")}`,
  "galaxus_search (price+sort)",
);

await check("galaxus_get_product", { product: String(productId) }, (r) =>
  `${r.brand} ${r.name} CHF${r.price} | ${r.availability} | ${Object.keys(r.specifications).length} spec groups | history ${JSON.stringify(r.price_history)}`,
);

await check("galaxus_autocomplete", { query: "logite" }, (r) =>
  `${r.suggestions.length} suggestions (${r.suggestions[0]?.term}), ${r.products.length} products`,
);

await check("galaxus_browse_category", { category_id: 62, limit: 3, sort: "RATING" }, (r) =>
  `${r.total_results} in category, top: ${r.products[0]?.name} (${r.products[0]?.rating}★)`,
);

await check("galaxus_browse_brand", { brand_id: 292, limit: 3, sort: "NEWEST" }, (r) =>
  `${r.total_results} brand products, top: ${r.products[0]?.name}`,
);

await check("galaxus_related_products", { product: String(productId), kind: "similar" }, (r) =>
  `${r.products.length} similar, e.g. ${r.products[0]?.name}`,
);

await check("galaxus_get_review_summary", { product: String(productId) }, (r) =>
  `${r.rating}★ from ${r.rating_count} | pros: ${r.pros.slice(0, 3).join("/")} | cons: ${r.cons.slice(0, 3).join("/")}`,
);

console.log();
for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(38)} ${detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;

// The tools smoke-tested above are called directly, bypassing MCP transport; index.ts only wraps them.
