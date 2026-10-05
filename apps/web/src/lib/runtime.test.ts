import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as ClientTracer from "../observability/clientTracer";
import { runtime } from "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web runtime", () => {
  it("routes client spans to the exporter client tracing configured", async () => {
    const exported: Array<string> = [];
    ClientTracer.setDelegate(
      Tracer.make({
        span(options) {
          exported.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );

    try {
      await runtime.runPromise(Effect.void.pipe(Effect.withSpan("client.work")));
    } finally {
      ClientTracer.setDelegate(null);
    }

    expect(exported).toEqual(["client.work"]);
  });
});

describe("web runtime relay telemetry policy", () => {
  it.each([
    { surface: "desktop opt-out", desktopEnabled: false, serverEnabled: true, exports: false },
    { surface: "desktop enabled", desktopEnabled: true, serverEnabled: true, exports: true },
    {
      surface: "desktop policy precedence",
      desktopEnabled: true,
      serverEnabled: false,
      exports: true,
    },
    {
      surface: "local web opt-out",
      desktopEnabled: undefined,
      serverEnabled: false,
      exports: false,
    },
    {
      surface: "hosted web default",
      desktopEnabled: undefined,
      serverEnabled: true,
      exports: true,
    },
  ])(
    "applies $surface before the first relay span",
    async ({ desktopEnabled, serverEnabled, exports }) => {
      vi.resetModules();
      vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
      vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
      vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
      vi.stubGlobal("window", {
        desktopBridge:
          desktopEnabled === undefined
            ? undefined
            : { getRelayTelemetryEnabled: () => desktopEnabled },
      });
      vi.stubGlobal("document", {
        querySelector: (selector: string) =>
          selector === 'meta[name="t3code-relay-telemetry-enabled"]' && !serverEnabled
            ? { getAttribute: () => "false" }
            : null,
      });
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
      vi.stubGlobal("fetch", fetchFn);
      // Re-import after setting runtime policy: static initialization creates the exporter layer.
      const { runtime: freshRuntime } = await import("./runtime");

      try {
        expect(
          await freshRuntime.runPromise(
            Effect.succeed("relay operation completed").pipe(
              Effect.withSpan("relay.first-operation"),
              withRelayClientTracing,
            ),
          ),
        ).toBe("relay operation completed");
      } finally {
        // Closing the runtime flushes the exporter without waiting for its batch timer.
        await freshRuntime.dispose();
      }

      if (exports) {
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://telemetry.example.test/v1/traces");
        const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
        expect(payload).toContain('"name":"relay.first-operation"');
      } else {
        expect(fetchFn).not.toHaveBeenCalled();
      }
    },
  );
});
