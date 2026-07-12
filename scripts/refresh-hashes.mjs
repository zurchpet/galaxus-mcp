/**
 * Re-captures the persisted GraphQL operation hashes from the live storefront.
 *
 * The shop only accepts pre-registered operations: the hash is part of the request URL and rotates
 * whenever a new frontend is deployed. When a tool starts failing with a 404, run this:
 *
 *   npx playwright install chromium   # once
 *   npm run refresh-hashes
 *
 * Hashes are read two ways, because neither alone is complete:
 *   1. from the Relay artifacts in the JS bundles (`params:{id:"<hash>",...,name:"<operation>"}`)
 *   2. from the GraphQL requests the pages actually fire (`/graphql/o/<hash>/<operation>`)
 *
 * A headless browser is refused by the site's bot protection, so this runs headed.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPERATIONS_FILE = fileURLToPath(new URL("../src/operations.json", import.meta.url));
const HOST = process.env.GALAXUS_HOST ?? "https://www.galaxus.ch";

// Pages chosen so that between them they exercise every operation the server relies on.
const PAGES = [
  `${HOST}/en/search?q=logitech%20mx%20master`,
  `${HOST}/en/s1/producttype/mouse-62`,
  `${HOST}/en/s1/product/logitech-mx-master-3s-wireless-mouse-61318913`,
  `${HOST}/en/brand/logitech-292`,
];

const current = JSON.parse(readFileSync(OPERATIONS_FILE, "utf8"));
const wanted = Object.keys(current.operations);
const found = {};
let clientVersion = current._clientVersion;

const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1440, height: 1000 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = await context.newPage();

const ARTIFACT_RE = /params:\s*\{id:\s*"([a-f0-9]{32})",\s*metadata:\{[^}]*\},\s*name:\s*"(\w+)"/g;

page.on("response", async (response) => {
  const url = response.url();

  const request = url.match(/\/graphql\/o\/([a-f0-9]{32})\/(\w+)/);
  if (request) {
    found[request[2]] ??= request[1];
    const version = response.request().headers()["x-dg-graphql-client-version"];
    if (version) clientVersion = version;
    return;
  }

  if (!/\.js(\?|$)/.test(url) || response.status() !== 200) return;
  let source;
  try {
    source = await response.text();
  } catch {
    return;
  }
  ARTIFACT_RE.lastIndex = 0;
  let match;
  while ((match = ARTIFACT_RE.exec(source))) found[match[2]] ??= match[1];
});

for (const url of PAGES) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6000);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(3000);
  } catch (error) {
    console.warn(`! could not load ${url}: ${error.message.split("\n")[0]}`);
  }
}
await browser.close();

const updated = {};
const missing = [];
for (const operation of wanted) {
  const hash = found[operation];
  if (!hash) {
    missing.push(operation);
    updated[operation] = current.operations[operation];
    continue;
  }
  if (hash !== current.operations[operation]) console.log(`~ ${operation}: ${current.operations[operation]} -> ${hash}`);
  updated[operation] = hash;
}

writeFileSync(
  OPERATIONS_FILE,
  `${JSON.stringify(
    {
      ...current,
      _capturedAt: new Date().toISOString().slice(0, 10),
      _clientVersion: clientVersion,
      operations: updated,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nsaw ${Object.keys(found).length} operations, wrote ${wanted.length - missing.length}/${wanted.length}.`);
if (missing.length) {
  console.warn(`! not seen, kept previous hash: ${missing.join(", ")}`);
  process.exitCode = 1;
}
