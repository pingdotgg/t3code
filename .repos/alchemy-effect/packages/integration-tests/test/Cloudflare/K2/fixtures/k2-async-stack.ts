import * as Cloudflare from "@alchemy.run/cloudflare";

/** A K2 stream bound into an async (non-Effect) Worker through `env`. */
export const AsyncOrders = Cloudflare.K2.Stream("K2AsyncOrders");

export const K2AsyncWorker = Cloudflare.Worker("K2AsyncWorker", {
  main: `${import.meta.dirname}/k2-async-worker.ts`,
  env: {
    ORDERS: AsyncOrders,
  },
});

export type K2AsyncWorkerEnv = Cloudflare.InferEnv<typeof K2AsyncWorker>;
