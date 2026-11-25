import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// each case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const answers = (...values: Array<boolean | null>) => {
  let call = 0;
  return () => values[Math.min(call++, values.length - 1)] ?? null;
};

describe("web runtime relay telemetry policy", () => {
  it.each([
    {
      surface: "desktop opt-out",
      desktopBridge: { getRelayTelemetryEnabled: () => false },
      exports: false,
    },
    {
      surface: "desktop enabled",
      desktopBridge: { getRelayTelemetryEnabled: () => true },
      exports: true,
    },
    {
      // The desktop host reads the login shell after the renderer has started.
      surface: "desktop enabled once the login shell is read",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, true) },
      exports: true,
    },
    {
      surface: "desktop opt-out found in the login shell",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, false, true) },
      exports: false,
    },
    {
      surface: "browser before its server has answered",
      desktopBridge: undefined,
      exports: false,
    },
    {
      surface: "browser whose server opted out",
      desktopBridge: undefined,
      server: false,
      exports: false,
    },
    {
      surface: "browser whose server allows it",
      desktopBridge: undefined,
      server: true,
      exports: true,
    },
    {
      // The hosted app is served by no T3 server, so nothing can answer for it.
      surface: "hosted app",
      desktopBridge: undefined,
      location: new URL("https://app.example.test/"),
      exports: true,
    },
  ])("applies $surface before the first relay span", async (surface) => {
    const { desktopBridge, exports } = surface;
    vi.resetModules();
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "false");
    vi.stubEnv("T3CODE_OTEL_SDK_DISABLED", "true");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.example.test");
    vi.stubGlobal("window", {
      desktopBridge,
      location: "location" in surface ? surface.location : undefined,
    });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);
    // Re-import after setting runtime policy: static initialization creates the exporter layer.
    const { runtime: freshRuntime } = await import("./runtime");
    const { setDelegate } = await import("../observability/clientTracer");
    if ("server" in surface) {
      (await import("../cloud/publicConfig")).setServerRelayTelemetry(surface.server);
    }
    const userSpans: Array<string> = [];

    try {
      expect(
        await freshRuntime.runPromise(
          Effect.succeed("relay operation completed").pipe(
            Effect.withSpan("relay.first-operation"),
            withRelayClientTracing,
          ),
        ),
      ).toBe("relay operation completed");

      setDelegate(
        Tracer.make({
          span(options) {
            userSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      await freshRuntime.runPromise(Effect.void.pipe(Effect.withSpan("user.work")));
      expect(userSpans).toEqual(["user.work"]);
    } finally {
      setDelegate(null);
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
  });
});
