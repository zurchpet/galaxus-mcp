/**
 * Verifies every persisted operation hash is still accepted by the shop. No browser needed.
 *
 * Trick: post an operation with empty variables. The shop validates the hash *before* the variables,
 * so a hash that still exists comes back complaining about a missing variable, while a rotated one
 * comes back with "The specified persisted operation key is invalid.". Both arrive as HTTP 200.
 *
 * Exit code 0 = all hashes current, 1 = at least one rotated (run `npm run refresh-hashes`).
 */
import { GalaxusClient, GalaxusError, OPERATION_NAMES } from "../dist/client.js";

const client = new GalaxusClient({});
const stale = [];

for (const operation of OPERATION_NAMES) {
  try {
    await client.query(operation, {});
    // No error at all means the operation needs no variables — the hash is fine either way.
    console.log(`ok    ${operation}`);
  } catch (error) {
    const rotated = error instanceof GalaxusError && error.hint?.includes("refresh-hashes");
    if (rotated) {
      stale.push(operation);
      console.log(`STALE ${operation}`);
    } else {
      console.log(`ok    ${operation}`);
    }
  }
}

if (stale.length) {
  console.error(`\n${stale.length}/${OPERATION_NAMES.length} operation hashes have rotated: ${stale.join(", ")}`);
  console.error("Run `npm run refresh-hashes` to re-capture them.");
  process.exit(1);
}
console.log(`\nall ${OPERATION_NAMES.length} operation hashes are current.`);
