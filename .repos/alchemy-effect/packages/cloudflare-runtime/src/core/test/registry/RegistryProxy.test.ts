import { execFileSync } from "node:child_process";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import * as Registry from "../../registry/Registry.ts";
import { resolvedTargetKey, type Subscriber } from "../../registry/RegistryTypes.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const OWNER_SCRIPT = `
import { DurableObject } from "cloudflare:workers";
export class Pinger extends DurableObject {
  ping() {
    return "pong";
  }
}
export default {
  fetch() {
    return new Response("owner");
  },
};
`;

const CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.PINGER.get(env.PINGER.idFromName("singleton"));
    const n = Number(url.searchParams.get("n") ?? 1);
    if (url.pathname === "/parallel") {
      await Promise.all(Array.from({ length: n }, () => stub.ping()));
    } else {
      for (let i = 0; i < n; i++) await stub.ping();
    }
    return new Response("done");
  },
};
`;

const subscriber: Subscriber.DurableObject = {
  kind: "durable-object",
  scriptName: "registry-proxy-owner",
  className: "Pinger",
  uniqueKey: "registry-proxy-pinger",
};

/**
 * Counts established TCP connections on a local port. Both ends of a
 * loopback connection are listed, so one connection counts twice.
 */
const establishedConnections = (port: string) =>
  Effect.sync(() => {
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"], {
        encoding: "utf8",
      });
      return output.trim().split("\n").length - 1;
    } catch {
      // lsof exits non-zero when nothing matches.
      return 0;
    }
  });

layer(localRuntimeLayer, { excludeTestServices: true })("RegistryProxy", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "reuses one connection to a cross-script Durable Object across calls",
    () =>
      Effect.gen(function* () {
        yield* startTestWorker({
          name: "registry-proxy-owner",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: OWNER_SCRIPT }],
          durableObjectNamespaces: [
            { className: "Pinger", sql: false, uniqueKey: "registry-proxy-pinger" },
          ],
        });
        const consumer = yield* startTestWorker({
          name: "registry-proxy-consumer",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "PINGER",
              className: "Pinger",
              scriptName: "registry-proxy-owner",
              uniqueKey: "registry-proxy-pinger",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: CONSUMER_SCRIPT }],
        });
        const registry = yield* Registry.Registry;
        const targets = yield* registry.read([subscriber]);
        const port = targets[resolvedTargetKey(subscriber)]!.debugPortAddress.split(":")[1]!;

        for (let i = 0; i < 50; i++) {
          expect(yield* consumer.fetchText("/sequential")).toBe("done");
        }
        expect(yield* consumer.fetchText("/sequential?n=500")).toBe("done");
        expect(yield* consumer.fetchText("/parallel?n=500")).toBe("done");

        // A connection per call would leave hundreds open here.
        expect(yield* establishedConnections(port)).toBeLessThanOrEqual(4);
      }),
    { timeout: 60_000 },
  );
});
