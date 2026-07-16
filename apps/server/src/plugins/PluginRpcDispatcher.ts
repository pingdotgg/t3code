import {
  PluginRpcError,
  pluginOperateScope,
  pluginReadScope,
  satisfiesScope,
  type AuthScope,
} from "@t3tools/contracts";
import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginRpcDescriptor, PluginStreamDescriptor } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makePluginLogger } from "./PluginLogger.ts";
import { PluginRuntimeRegistry, type ActivePluginRuntime } from "./PluginRuntimeRegistry.ts";

export interface PluginRpcSession {
  readonly scopes: ReadonlyArray<AuthScope>;
}

// Wall-clock ceiling for a single unary RPC handler. Aligns with the 30s
// precedent used elsewhere in the plugin host (PluginHost registration timeout /
// HttpClientCapability default). A hung `call` handler must not pin the WS
// request forever. The `subscribe` stream path is intentionally NOT bounded —
// long-lived subscriptions are legitimate.
const PLUGIN_RPC_HANDLER_TIMEOUT_MS = 30_000;

export interface PluginRpcDispatcherOptions {
  // Injectable so tests can drive the deadline branch with a short value; the
  // default is the 30s production ceiling.
  readonly handlerTimeoutMs?: number;
}

export class PluginRpcDispatcher extends Context.Service<
  PluginRpcDispatcher,
  {
    readonly call: (
      pluginId: PluginId,
      method: string,
      payload: unknown,
      session: PluginRpcSession,
    ) => Effect.Effect<unknown, PluginRpcError>;
    readonly subscribe: (
      pluginId: PluginId,
      method: string,
      payload: unknown,
      session: PluginRpcSession,
    ) => Stream.Stream<unknown, PluginRpcError>;
  }
>()("t3/plugins/PluginRpcDispatcher") {}

const pluginRpcError = (
  pluginId: PluginId,
  code: PluginRpcError["code"],
  message: string,
  data?: unknown,
) =>
  new PluginRpcError({
    pluginId,
    code,
    message,
    ...(data === undefined ? {} : { data }),
  });

const internalPluginRpcError = (pluginId: PluginId, error: unknown) =>
  pluginRpcError(pluginId, "internal", error instanceof Error ? error.message : String(error));

const pluginDefectError = (pluginId: PluginId) =>
  pluginRpcError(pluginId, "internal", "Plugin method failed.");

// A handler that blows its wall-clock deadline surfaces as an internal-class
// error — the same class mapPluginHandlerCause uses for an unexpected failure.
const pluginTimeoutError = (pluginId: PluginId) =>
  pluginRpcError(pluginId, "internal", "Plugin method timed out.");

const lookupRuntime = Effect.fn("PluginRpcDispatcher.lookupRuntime")(function* (
  registry: PluginRuntimeRegistry["Service"],
  pluginId: PluginId,
) {
  const runtime = yield* registry.get(pluginId);
  if (Option.isNone(runtime)) {
    return yield* pluginRpcError(pluginId, "not-found", "Plugin was not found.");
  }
  return runtime.value;
});

const ensureDescriptorReady = Effect.fn("PluginRpcDispatcher.ensureDescriptorReady")(function* (
  runtime: ActivePluginRuntime,
  descriptor: PluginRpcDescriptor | PluginStreamDescriptor,
) {
  if (descriptor.readiness === "always") {
    return;
  }
  const readiness = yield* Deferred.poll(runtime.readiness);
  if (Option.isNone(readiness)) {
    return yield* pluginRpcError(
      runtime.manifest.id,
      "not-ready",
      "Plugin is not ready to handle this method.",
    );
  }
});

const authorizeDescriptor = (
  runtime: ActivePluginRuntime,
  descriptor: PluginRpcDescriptor | PluginStreamDescriptor,
  session: PluginRpcSession,
) => {
  const pluginId = runtime.manifest.id;
  // Fail closed: only the exact "operate"/"read" scope literals map to a plugin
  // scope requirement. Descriptors come from dynamically loaded plugin JS where
  // the SDK's `"read" | "operate"` type is not runtime-enforced, so an
  // unrecognized value (typo/casing like "Operate") must be REJECTED rather than
  // silently treated as the weaker read requirement.
  const requiredScope =
    descriptor.scope === "operate"
      ? pluginOperateScope(pluginId)
      : descriptor.scope === "read"
        ? pluginReadScope(pluginId)
        : null;
  if (requiredScope === null) {
    return Effect.fail(
      pluginRpcError(
        pluginId,
        "unauthorized",
        `Plugin method declares an unrecognized scope: ${String(descriptor.scope)}.`,
      ),
    );
  }
  return satisfiesScope(requiredScope, session.scopes)
    ? Effect.void
    : Effect.fail(
        pluginRpcError(
          pluginId,
          "unauthorized",
          `The authenticated token is missing required scope: ${requiredScope}.`,
        ),
      );
};

const mapPluginHandlerCause = (pluginId: PluginId, cause: Cause.Cause<Error>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause as Cause.Cause<PluginRpcError>);
  }
  if (Cause.hasDies(cause)) {
    return Effect.logError("Plugin RPC handler defect", {
      pluginId,
      cause: Cause.pretty(cause),
    }).pipe(Effect.andThen(Effect.fail(pluginDefectError(pluginId))));
  }
  return Effect.fail(internalPluginRpcError(pluginId, Cause.squash(cause)));
};

const mapPluginHandlerStreamCause = (pluginId: PluginId, cause: Cause.Cause<Error>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Stream.failCause(cause as Cause.Cause<PluginRpcError>);
  }
  if (Cause.hasDies(cause)) {
    return Stream.fromEffect(
      Effect.logError("Plugin RPC stream handler defect", {
        pluginId,
        cause: Cause.pretty(cause),
      }),
    ).pipe(Stream.drain, Stream.concat(Stream.fail(pluginDefectError(pluginId))));
  }
  return Stream.fail(internalPluginRpcError(pluginId, Cause.squash(cause)));
};

export const make = Effect.fn("PluginRpcDispatcher.make")(function* (
  options?: PluginRpcDispatcherOptions,
) {
  const registry = yield* PluginRuntimeRegistry;
  const handlerTimeoutMs = options?.handlerTimeoutMs ?? PLUGIN_RPC_HANDLER_TIMEOUT_MS;

  // Error-order disclosure, by design: callers holding the transport
  // baseline scope can distinguish invalid-method from unauthorized (method
  // enumeration). Plugin method names are not secrets — manifests and web
  // bundles are user-readable — and the clearer typo diagnostics win.
  const call: PluginRpcDispatcher["Service"]["call"] = (pluginId, method, payload, session) =>
    Effect.gen(function* () {
      const runtime = yield* lookupRuntime(registry, pluginId);
      const descriptor = (runtime.registration.rpc ?? []).find((rpc) => rpc.method === method);
      if (descriptor === undefined) {
        return yield* pluginRpcError(pluginId, "invalid-method", "Plugin RPC method is invalid.");
      }
      yield* authorizeDescriptor(runtime, descriptor, session);
      yield* ensureDescriptorReady(runtime, descriptor);
      const logger = makePluginLogger(pluginId);
      return yield* Effect.suspend(() => descriptor.handler(payload, { pluginId, logger })).pipe(
        Effect.catchCause((cause) => mapPluginHandlerCause(pluginId, cause)),
        // Bound the unary handler by a wall-clock deadline: a hung `Effect.never`
        // must not pin the WS call forever. On timeout the handler fiber is
        // interrupted and we fail with a typed internal error. (The subscribe
        // path below is deliberately left unbounded.)
        Effect.timeoutOrElse({
          duration: handlerTimeoutMs,
          orElse: () => Effect.fail(pluginTimeoutError(pluginId)),
        }),
      );
    });

  const subscribe: PluginRpcDispatcher["Service"]["subscribe"] = (
    pluginId,
    method,
    payload,
    session,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const runtime = yield* lookupRuntime(registry, pluginId);
        const descriptor = (runtime.registration.streams ?? []).find(
          (stream) => stream.method === method,
        );
        if (descriptor === undefined) {
          return yield* pluginRpcError(
            pluginId,
            "invalid-method",
            "Plugin stream method is invalid.",
          );
        }
        yield* authorizeDescriptor(runtime, descriptor, session);
        yield* ensureDescriptorReady(runtime, descriptor);
        const logger = makePluginLogger(pluginId);
        return Stream.suspend(() => descriptor.handler(payload, { pluginId, logger })).pipe(
          Stream.catchCause((cause) => mapPluginHandlerStreamCause(pluginId, cause)),
        );
      }),
    );

  return PluginRpcDispatcher.of({ call, subscribe });
});

export const layer = Layer.effect(PluginRpcDispatcher, make());
