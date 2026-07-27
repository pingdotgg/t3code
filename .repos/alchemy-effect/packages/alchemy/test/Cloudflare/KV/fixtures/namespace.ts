import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Shared KV namespace bound by all six binding-test workers (read /
 * write / read-write, each over the native Worker binding and over a
 * scoped HTTP API token). A value written through a Write worker is
 * observable by a Read worker, which is what the test asserts.
 */
export const TestNamespace = Cloudflare.KV.Namespace("KVBindingTestNamespace");
