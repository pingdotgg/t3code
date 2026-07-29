import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Shared R2 bucket bound by all six binding-test workers (read /
 * write / read-write, each over the native Worker binding and over a
 * scoped HTTP API token). Because every worker binds this same
 * bucket, a value written through a Write worker is observable by a
 * Read worker — which is what the test asserts.
 */
export const TestBucket = Cloudflare.R2.Bucket("R2BindingTestBucket");
