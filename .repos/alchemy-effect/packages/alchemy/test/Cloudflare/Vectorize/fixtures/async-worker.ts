/// <reference types="@cloudflare/workers-types" />

import type { AsyncWorkerEnv } from "./stack.ts";
import { seedVectors, vector } from "./vectors.ts";

const LABEL = "async";

/**
 * Async (non-Effect) Worker style: the Vectorize index is declared on the
 * Worker `env` (`env: { INDEX: TestIndex }` in stack.ts). `WorkerAsyncBindings`
 * resolves it via the `isIndex` predicate and registers the native
 * `vectorize` binding, so the handler calls the runtime `Vectorize` binding
 * (`env.INDEX.upsert(...)`, `.describe()`, `.query(...)`, `.getByIds(...)`)
 * directly with plain `await`.
 *
 * `InferEnv` has no Vectorize mapping yet, so `env.INDEX` is typed as the
 * alchemy resource at compile time; cast to the runtime `Vectorize` binding.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const index = env.INDEX as unknown as Vectorize;

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/upsert") {
      const mutation = await index.upsert(seedVectors(LABEL));
      return Response.json({ mutationId: mutation.mutationId });
    }

    if (request.method === "GET" && url.pathname === "/describe") {
      const info = await index.describe();
      return Response.json({
        dimensions: info.dimensions,
        vectorCount: info.vectorCount,
      });
    }

    if (request.method === "GET" && url.pathname === "/query") {
      const matches = await index.query(vector(0.1, 0.2, 0.3), {
        topK: 20,
        returnMetadata: "all",
      });
      const mine = matches.matches.filter((m) => m.id.startsWith(`${LABEL}-`));
      return Response.json({
        count: mine.length,
        ids: mine.map((m) => m.id),
      });
    }

    if (request.method === "GET" && url.pathname === "/query-filtered") {
      const matches = await index.query(vector(0.1, 0.2, 0.3), {
        topK: 3,
        returnMetadata: "all",
        filter: { kind: { $eq: "second" } },
      });
      const mine = matches.matches.filter((m) => m.id.startsWith(`${LABEL}-`));
      return Response.json({
        count: mine.length,
        ids: mine.map((m) => m.id),
        kinds: mine.map(
          (m) => (m.metadata as { kind?: string } | undefined)?.kind,
        ),
      });
    }

    if (request.method === "GET" && url.pathname === "/get") {
      const vectors = await index.getByIds([`${LABEL}-a`, `${LABEL}-b`]);
      return Response.json({ ids: vectors.map((v) => v.id).sort() });
    }

    return new Response("Not Found", { status: 404 });
  },
};
