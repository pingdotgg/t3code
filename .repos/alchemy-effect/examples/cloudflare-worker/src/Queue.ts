import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Queue resource used by the Api worker as a producer (via
 * `Cloudflare.QueueBinding.bind(Queue)`). Exercises the Queue + QueueBinding
 * resources end-to-end in the Effect-based example.
 *
 * The async example (`examples/cloudflare-worker-async`) demonstrates the
 * consumer side via a native `queue()` handler on the default export — the
 * Effect worker's `Main` type currently only exposes a `fetch` handler, so
 * consumer-side wiring on Effect workers is a follow-up.
 */
export const Queue = Cloudflare.Queue("Queue");
