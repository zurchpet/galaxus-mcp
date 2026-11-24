/**
 * Verifies every persisted operation hash is still accepted by the shop. No browser needed.
 *
 * Trick: post an operation with empty variables. The shop validates the hash *before* the variables,
 * so a hash that still exists comes back complaining about a missing variable, while a rotated one
 * comes back with "The specified persisted operation key is invalid.". Both arrive as HTTP 200.
 * Only that missing-variable complaint proves a hash alive: anything else (HTTP 403 from the bot
 * protection, a timeout, an unknown error) says nothing about the hash and is reported as unverified.
 *
 * Exit code 0 = all hashes current, 1 = at least one rotated (run `npm run refresh-hashes`),
 * 2 = none rotated, but at least one could not be verified.
 */
import { GalaxusClient, GalaxusError, OPERATION_NAMES } from "../dist/client.js";

const MISSING_VARIABLE_RE = /Variable `\w+` is required/;

const client = new GalaxusClient({});
const stale = [];
const unverified = [];

for (const operation of OPERATION_NAMES) {
  try {
    await client.query(operation, {});
    // No error at all means the operation needs no variables — the hash answered, so it is alive.
    console.log(`ok    ${operation}`);
  } catch (error) {
    if (error instanceof GalaxusError && error.hint?.includes("refresh-hashes")) {
      stale.push(operation);
      console.log(`STALE ${operation}`);
    } else if (error instanceof GalaxusError && MISSING_VARIABLE_RE.test(error.message)) {
      console.log(`ok    ${operation}`);
    } else {
      unverified.push(operation);
      console.log(`????  ${operation}: ${error.message}`);
    }
  }
}

if (stale.length) {
  console.error(`\n${stale.length}/${OPERATION_NAMES.length} operation hashes have rotated: ${stale.join(", ")}`);
  console.error("Run `npm run refresh-hashes` to re-capture them.");
  process.exit(1);
}
if (unverified.length) {
  console.error(`\n${unverified.length}/${OPERATION_NAMES.length} operation hashes could not be verified: ${unverified.join(", ")}`);
  console.error("The shop did not answer as expected (bot protection or network?), so this run proves nothing.");
  process.exit(2);
}
console.log(`\nall ${OPERATION_NAMES.length} operation hashes are current.`);
