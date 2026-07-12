# galaxus-mcp

An MCP server for product search and discovery on [Galaxus](https://www.galaxus.ch) and
[Digitec](https://www.digitec.ch). Read-only: search, browse, compare, look up prices and specs.
Nothing that requires a login (no cart, no orders, no account data).

## Tools

| Tool | What it does |
| --- | --- |
| `galaxus_search` | Full-text search. Returns products plus the facets you can narrow with. |
| `galaxus_get_product` | Everything about one product: price, stock, specs, variants, price history, warranty. |
| `galaxus_autocomplete` | Type-ahead: search-term suggestions and a few direct product hits. |
| `galaxus_browse_category` | List a category (product type) without a search term. |
| `galaxus_browse_brand` | List a brand's products. |
| `galaxus_related_products` | Alternatives (`similar`), complements (`bought_together`), add-ons (`accessories`). |
| `galaxus_get_review_summary` | Average rating, rating count, and the pros/cons reviewers mention most. |

Every list tool supports `filters`, `min_price` / `max_price`, `sort`
(`RELEVANCE`, `LOWEST_PRICE`, `HIGHEST_PRICE`, `RATING`, `NEWEST`, `AVAILABILITY`), `limit` and
cursor pagination.

Filters are discoverable rather than hardcoded: search and browse results carry a `filters` block
listing each facet's id and its options with counts (`bra` = brand, `pt` = category, `pr` = price
range, `rating`, plus per-category spec filters such as "Signal transmission"). Feed those ids
straight back in:

```json
{ "query": "wireless mouse", "filters": [{ "filter_id": "bra", "option_ids": ["292"] }], "max_price": 80 }
```

## Setup

```bash
npm install
npm run build
npm run smoke     # exercises all 7 tools against the live shop
```

Then register it with Claude Code:

```bash
claude mcp add galaxus -- node /absolute/path/to/galaxus-mcp/dist/index.js
```

Or drop it in an MCP client config (this repo also ships a project-scoped `.mcp.json`):

```json
{
  "mcpServers": {
    "galaxus": {
      "command": "node",
      "args": ["/absolute/path/to/galaxus-mcp/dist/index.js"],
      "env": { "GALAXUS_PORTAL": "galaxus", "GALAXUS_LANGUAGE": "en" }
    }
  }
}
```

| Env var | Values | Default |
| --- | --- | --- |
| `GALAXUS_PORTAL` | `galaxus`, `digitec` | `galaxus` |
| `GALAXUS_LANGUAGE` | `en`, `de`, `fr`, `it` | `en` |

The language affects product names, specification labels and facet titles.

## Using it

Once registered, just ask in natural language — the tools chain on their own:

- *"Find me a wireless mouse under CHF 100 with good reviews"* → `galaxus_search` with `max_price`
  and `sort: RATING`, then `galaxus_get_review_summary` on the pick.
- *"What are the specs of the Logitech MX Master 3S, and has it been cheaper?"* →
  `galaxus_get_product`, which carries the specs and the price-history summary.
- *"Show me alternatives to this one that are cheaper"* → `galaxus_related_products` with
  `kind: similar`.
- *"What Logitech keyboards are in stock?"* → `galaxus_browse_brand` with `sort: AVAILABILITY`.

Product ids are the trailing number in any Galaxus URL, and the product tools accept the full URL
too, so pasting a link works.

## How it talks to the shop

The storefront exposes a GraphQL API that only accepts **persisted operations**: the operation's
hash is part of the URL (`/graphql/o/<hash>/<operationName>`) and the request body carries variables
only. Query text is rejected with a 404, so there is no schema introspection and no arbitrary
queries — this server replays the same operations the website itself uses.

The shop is also behind bot protection that rejects plain `curl` and headless Chromium alike. The
persisted endpoints, however, answer ordinary `fetch` calls, so **the running server needs no
browser** — a browser is only involved when refreshing hashes, below.

## Hash rotation: the one thing that will break this

The operation hashes live in `src/operations.json`. They are tied to the deployed frontend build, so
**Galaxus rotates them whenever it ships a new frontend** — which happens often. When that occurs,
the URLs this server calls no longer exist and *every* tool starts failing at once.

**Symptom.** Every tool call comes back with:

> The persisted hash for "useSearchDataQuery" is no longer accepted by the shop. Galaxus deployed a
> new frontend and rotated its query hashes. Run `npm run refresh-hashes` (then `npm run build`) to
> re-capture them.

Note the shop reports this *in-band*: HTTP 200 with the GraphQL error
`The specified persisted operation key is invalid.` — not a 404. So it cannot be mistaken for a
network problem.

**Checking, without a browser.** Because the shop validates the hash before the variables, posting an
operation with empty variables tells you whether its hash is alive: a live one complains about a
missing variable, a rotated one rejects the key. That is one tiny request per operation:

```bash
npm run check-hashes    # exits 0 if all hashes are current, 1 if any rotated
```

**Fixing.** Re-capture and rebuild:

```bash
npx playwright install chromium   # once, if you have not already
npm run refresh-hashes            # opens a real browser window — let it finish
npm run build
npm run smoke                     # confirm all 7 tools are green again
```

`refresh-hashes` drives a real browser across a search page, a category page, a product page and a
brand page. It harvests hashes two ways, because neither alone catches everything: from the Relay
artifacts embedded in the JS bundles (`params:{id:"<hash>",…,name:"<operation>"}`) and from the
GraphQL requests those pages actually fire. It then rewrites `src/operations.json` in place, logging
every hash that moved, and keeps the previous value (exiting non-zero) for any operation it did not
see, rather than writing a broken one.

It runs **headed on purpose** — headless Chromium gets blocked. Expect a browser window for about a
minute; don't close it. Commit the resulting `src/operations.json` diff.

**Automatically.** `.github/workflows/refresh-hashes.yml` runs `check-hashes` daily. That step needs
no browser, so the usual run is cheap and silent. Only when a hash has actually rotated does it
install Chromium, re-capture the hashes with a headed browser on a virtual display
(`xvfb-run`, since headless is blocked), re-verify with `check-hashes` and `smoke`, and open a PR
with the new `src/operations.json`. You can also trigger it by hand from the Actions tab, with
`force` to re-capture even while the current hashes still work.

One caveat: the workflow talks to Galaxus from a GitHub-hosted runner, and the shop's bot protection
judges by IP as well as by browser. If those datacenter IPs turn out to be blocked, the capture step
will fail there — run `npm run refresh-hashes` locally instead (or point the workflow at a
self-hosted runner). Nothing else about the server depends on this: it is a maintenance path only.

## Two behaviours worth knowing

**Search redirects.** A generic query like `mouse` makes the shop return a category redirect instead
of products. The server always sends `skipRedirect`, so you get products back.

**The price filter is family-wide.** The shop matches a product when *any* of its variants falls in
the price range, while the price it shows is the cheapest variant — so a CHF 100–200 filter would
otherwise surface an CHF 82.90 mouse that happens to have a CHF 3860 colourway. The list tools
therefore drop products whose own price falls outside `min_price`/`max_price`, and page forward to
refill the page. Pass `strict_price: false` to see the shop's raw behaviour.

## Scope

Search and discovery only. Anything behind a login — cart, checkout, orders, wishlists, writing
reviews — is deliberately out of scope. `total_results` reflects the shop's own count, which counts
product families, so it can exceed the number of rows returned once strict price filtering applies.

Individual review texts are not exposed: the shop renders them server-side and no persisted
operation returns them, so `galaxus_get_review_summary` gives the rating summary and the aggregated
pros/cons keywords instead.
