import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { settleAsyncResult, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import * as ClientTracer from "./clientTracer";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;
const CLIENT_TRACING_RESOURCE = {
  serviceName: "t3code-web",
  attributes: {
    "service.namespace": "t3code",
    "service.runtime": "t3-web",
    "service.mode": isElectron ? "electron" : "browser",
    "service.version": APP_VERSION,
  },
} as const;

const delegateRuntimeLayer = Layer.mergeAll(
  primaryEnvironmentHttpLayer,
  OtlpExporter.layerFlusher,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

export function configureClientTracing(config: ClientTracingConfig = {}): Promise<void> {
  if (config.exportIntervalMs === undefined && activeConfigKey !== null) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  const otlpTracesUrl = resolvePrimaryEnvironmentHttpUrl("/api/observability/v1/traces");
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && ClientTracer.hasDelegate()) {
    return;
  }

  activeConfigKey = nextConfigKey;
  const generation = ++configurationGeneration;

  const previousRuntime = activeRuntime;
  const previousScope = activeScope;

  ClientTracer.setDelegate(null);
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(previousRuntime, previousScope);

  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());

  const delegateResult = await settleAsyncResult(() =>
    runtime.runPromiseExit(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: otlpTracesUrl,
          exportInterval: `${exportIntervalMs} millis`,
          resource: CLIENT_TRACING_RESOURCE,
        }),
      ),
    ),
  );
  if (delegateResult._tag === "Failure") {
    await disposeTracerRuntime(runtime, scope);

    if (generation === configurationGeneration) {
      const error = squashAtomCommandFailure(delegateResult);
      const tracesUrl = new URL(otlpTracesUrl);
      console.warn("Failed to configure client tracing exporter", {
        scheme: tracesUrl.protocol.replace(/:$/, ""),
        host: tracesUrl.hostname,
        port: tracesUrl.port || undefined,
        exportIntervalMs,
        ...safeErrorLogAttributes(error),
      });
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await disposeTracerRuntime(runtime, scope);
    return;
  }

  ClientTracer.setDelegate(delegateResult.value);
  activeRuntime = runtime;
  activeScope = scope;
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }

  await settleAsyncResult(() => runtime.runPromiseExit(Scope.close(scope, Exit.void)));
  runtime.dispose();
}
