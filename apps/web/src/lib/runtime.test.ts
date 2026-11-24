import { afterEach, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// the case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("sends no relay spans even when every legacy telemetry setting enables them", async () => {
  vi.resetModules();
  vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "true");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
  vi.stubGlobal("window", { desktopBridge: { getRelayTelemetryEnabled: () => true } });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchFn);
  // Static initialization reads the settings, so import after stubbing them.
  const { runtime: freshRuntime } = await import("./runtime");

  try {
    await freshRuntime.runPromise(
      Effect.void.pipe(Effect.withSpan("relay.first-operation"), withRelayClientTracing),
    );
  } finally {
    // Disposing flushes any exporter without waiting for its batch timer.
    await freshRuntime.dispose();
  }

  expect(fetchFn).not.toHaveBeenCalled();
});
