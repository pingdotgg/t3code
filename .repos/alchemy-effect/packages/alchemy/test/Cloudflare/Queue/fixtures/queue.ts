import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Shared queue bound by the two producer binding-test workers. The
 * Cloudflare Queue runtime binding is producer-only, so there is no
 * Read/ReadWrite split — only a Write producer, exercised over the
 * native Worker binding and over a scoped HTTP API token.
 */
export const TestQueue = Cloudflare.Queues.Queue("QueueBindingTestQueue");
