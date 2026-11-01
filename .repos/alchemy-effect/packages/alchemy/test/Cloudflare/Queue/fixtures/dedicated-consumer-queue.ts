import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * The queue shared by the dedicated producer and consumer Workers of
 * `DedicatedConsumer.test.ts`. Declared in its own module so each Worker
 * fixture stays a single-default-export `main` bundle.
 */
export const DedicatedQueue = Cloudflare.Queues.Queue("DedicatedQueue");
