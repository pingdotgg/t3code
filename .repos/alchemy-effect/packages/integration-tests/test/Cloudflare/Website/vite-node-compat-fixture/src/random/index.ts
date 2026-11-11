import assert from "node:assert";
import nodeCrypto, { getRandomValues, webcrypto } from "node:crypto";

export default {
  async fetch() {
    return testGetRandomValues();
  },
} satisfies ExportedHandler;

function testGetRandomValues() {
  assert(
    nodeCrypto.getRandomValues === getRandomValues,
    "Unexpected identity for nodeCrypto.getRandomValues",
  );
  return Response.json([
    crypto.getRandomValues(new Uint8Array(6)).toString(), // global
    webcrypto.getRandomValues(new Uint8Array(6)).toString(), // webcrypto
    nodeCrypto.getRandomValues(new Uint8Array(6)).toString(), // namespace import
    getRandomValues(new Uint8Array(6)).toString(), // named import
  ]);
}
