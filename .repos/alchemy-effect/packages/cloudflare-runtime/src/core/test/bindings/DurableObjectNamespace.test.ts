import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch(request) {
    const prev = (await this.ctx.storage.get("c")) ?? 0;
    if (request.method === "GET") {
      return new Response(String(prev));
    }
    const next = prev + 1;
    await this.ctx.storage.put("c", next);
    return new Response(String(next));
  }
}

export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName("singleton");
    return env.COUNTER.get(id).fetch(request);
  },
};
`;
const CROSS_SCRIPT_CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName("singleton");
    return env.COUNTER.get(id).fetch(request);
  },
};
`;

layer(localRuntimeLayer)("DurableObjectNamespace binding", (it) => {
  it.effect(
    "persists state across invocations of the same durable object",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "durable-object-binding",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "COUNTER",
              className: "Counter",
              uniqueKey: "test-counter",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
          durableObjectNamespaces: [
            { className: "Counter", sql: false, uniqueKey: "test-counter" },
          ],
        });

        const first = yield* worker.fetchText("/");
        expect(first).toBe("0");
        const second = yield* worker.fetchText("/", { method: "POST" });
        expect(second).toBe("1");
      }),
  );

  it.effect(
    "works across instances via the dev registry",
    () =>
      Effect.gen(function* () {
        // This owner name produced a negative hash, resulting in an unsafe variable name.
        // This is a regression test for that.
        const ownerName =
          "localcrossscriptdostack-hostworker-tes72imccp3xv3o4ibo";
        const owner = yield* startTestWorker({
          name: ownerName,
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "COUNTER",
              className: "Counter",
              uniqueKey: "test-cross-script-counter",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
          durableObjectNamespaces: [
            {
              className: "Counter",
              sql: false,
              uniqueKey: "test-cross-script-counter",
            },
          ],
        });
        const consumer = yield* startTestWorker({
          name: "durable-object-binding-consumer",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "COUNTER",
              className: "Counter",
              scriptName: ownerName,
              uniqueKey: "test-cross-script-counter",
            }),
          ],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: CROSS_SCRIPT_CONSUMER_SCRIPT,
            },
          ],
        });

        const expectBoth = Effect.fn(function* (value: string) {
          const owner1 = yield* owner.fetchText("/");
          expect(owner1).toBe(value);
          const consumer1 = yield* consumer.fetchText("/");
          expect(consumer1).toBe(value);
        });

        yield* expectBoth("0");
        const incrementOwner = yield* owner.fetchText("/", { method: "POST" });
        expect(incrementOwner).toBe("1");
        yield* expectBoth("1");
        const incrementConsumer = yield* consumer.fetchText("/", {
          method: "POST",
        });
        expect(incrementConsumer).toBe("2");
        yield* expectBoth("2");
      }),
    { timeout: 60_000 },
  );
});
