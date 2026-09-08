// Reads/increments the user's Counter Durable Object (exported by
// worker-entry.ts through nitro's entry/exports seam) via the COUNTER
// namespace binding — same-worker JS RPC.
interface CounterStub {
  get: () => Promise<number>;
  increment: () => Promise<number>;
}

interface CounterNamespace {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => CounterStub;
}

export default defineEventHandler(async (event) => {
  const env = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env;
  const namespace = env?.COUNTER as CounterNamespace | undefined;
  if (namespace === undefined) {
    throw createError({ statusCode: 500, statusMessage: "COUNTER binding missing" });
  }
  const stub = namespace.get(namespace.idFromName("fixture"));
  const count = event.method === "POST" ? await stub.increment() : await stub.get();
  return { count };
});
