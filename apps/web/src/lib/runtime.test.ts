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
    { surface: "desktop opt-out", desktopBridge: { getRelayTelemetryEnabled: () => false } },
    { surface: "desktop enabled", desktopBridge: { getRelayTelemetryEnabled: () => true } },
    {
      surface: "desktop login-shell reload",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, true) },
    },
    { surface: "ordinary browser", desktopBridge: undefined },
  ])("never exports relay spans from $surface", async ({ desktopBridge }) => {
    vi.resetModules();
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubGlobal("window", { desktopBridge });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);
    // Re-import after setting runtime policy: static initialization creates the exporter layer.
    const { runtime: freshRuntime } = await import("./runtime");
    const { setDelegate } = await import("../observability/clientTracer");
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
      await freshRuntime.dispose();
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
