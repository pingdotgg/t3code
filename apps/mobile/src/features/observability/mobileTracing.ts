// @effect-diagnostics globalConsole:off
import Constants from "expo-constants";
import { AppState, type AppStateStatus } from "react-native";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

import { hasMobileTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

const EXPORT_INTERVAL = "1 second";

const delegateRuntimeLayer = Layer.mergeAll(
  remoteHttpClientLayer(fetch),
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let lifecycleInstalled = false;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

export const MobileTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

export function resolveMobileTracingConfig() {
  const config = resolveCloudPublicConfig();
  if (!hasMobileTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export const mobileTracingLayer = resolveMobileTracingConfig() === null ? null : MobileTracingLive;

export function installMobileTracing(): void {
  if (lifecycleInstalled) {
    return;
  }
  if (mobileTracingLayer === null) {
    const config = resolveCloudPublicConfig().observability;
    console.log("[mobile-tracing] disabled", {
      hasDataset: config.tracesDataset !== null,
      hasToken: config.tracesToken !== null,
      hasUrl: config.tracesUrl !== null,
    });
    return;
  }
  lifecycleInstalled = true;
  console.log("[mobile-tracing] installing");
  void configureMobileTracing();
  AppState.addEventListener("change", handleAppStateChange);
}

function handleAppStateChange(state: AppStateStatus): void {
  if (state === "active") {
    void configureMobileTracing();
    return;
  }
  if (state === "background") {
    void shutdownMobileTracing();
  }
}

export function configureMobileTracing(): Promise<void> {
  pendingConfiguration = pendingConfiguration.finally(applyMobileTracingConfig);
  return pendingConfiguration;
}

async function applyMobileTracingConfig(): Promise<void> {
  const config = resolveMobileTracingConfig();
  if (config === null || activeDelegate !== null) {
    return;
  }

  console.log("[mobile-tracing] configuring OTLP exporter", {
    dataset: config.tracesDataset,
    exportInterval: EXPORT_INTERVAL,
    tracesUrl: config.tracesUrl,
  });
  const generation = ++configurationGeneration;
  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());
  const appVariant =
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown";

  try {
    const delegate = await runtime.runPromise(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: config.tracesUrl,
          headers: {
            Authorization: `Bearer ${config.tracesToken}`,
            "X-Axiom-Dataset": config.tracesDataset,
          },
          exportInterval: EXPORT_INTERVAL,
          resource: {
            serviceName: "t3-mobile",
            serviceVersion: Constants.expoConfig?.version,
            attributes: {
              "service.runtime": "react-native",
              "service.component": "mobile",
              "deployment.environment.name": appVariant,
            },
          },
        }),
      ),
    );

    if (generation !== configurationGeneration) {
      await disposeTracerRuntime(runtime, scope);
      return;
    }

    activeDelegate = delegate;
    activeRuntime = runtime;
    activeScope = scope;
    console.log("[mobile-tracing] OTLP exporter ready", {
      dataset: config.tracesDataset,
      tracesUrl: config.tracesUrl,
    });
  } catch (error) {
    await disposeTracerRuntime(runtime, scope);
    console.warn("[mobile-tracing] failed to configure OTLP exporter", {
      error: error instanceof Error ? error.message : String(error),
      tracesUrl: config.tracesUrl,
    });
  }
}

export function shutdownMobileTracing(): Promise<void> {
  pendingConfiguration = pendingConfiguration.finally(async () => {
    configurationGeneration++;
    activeDelegate = null;
    const runtime = activeRuntime;
    const scope = activeScope;
    activeRuntime = null;
    activeScope = null;
    await disposeTracerRuntime(runtime, scope);
  });
  return pendingConfiguration;
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }
  await runtime
    .runPromise(Scope.close(scope, Exit.void))
    .catch(() => undefined)
    .finally(() => runtime.dispose());
}
