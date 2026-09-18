import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Nuke from "../../Nuke.ts";
import type { ProviderMode } from "../../ProviderMode.ts";
import type { ApplyStatus } from "../../Report.ts";
import { Progress, withSpanEvents } from "../Progress.ts";
import {
  buildStackProviders,
  DEFAULT_ENTRYPOINT,
  type Target,
} from "../Session.ts";

export interface ScanInput extends Target {
  readonly mode: ProviderMode;
  /** Provider-id globs to include. Omitted means every provider. */
  readonly include?: ReadonlyArray<string>;
  /** Provider-id globs to exclude. Applied after `include`. */
  readonly exclude?: ReadonlyArray<string>;
  readonly concurrency?: number | "unbounded";
  readonly providerTimeoutSeconds?: number;
}

/** One discovered cloud object, bound to the provider that can delete it. */
export type NukeResource = Nuke.Target;

export interface NukeScan {
  readonly mode: ProviderMode;
  readonly resources: ReadonlyArray<NukeResource>;
  readonly failures: ReadonlyArray<Nuke.ProviderFailure>;
  /** The built provider context {@link execute} deletes under. */
  readonly context: Context.Context<never>;
}

export interface ExecuteInput {
  readonly scan: NukeScan;
  /** The subset of `scan.resources` to delete. */
  readonly resources: ReadonlyArray<NukeResource>;
  readonly strategy: Nuke.Strategy;
  readonly concurrency?: number | "unbounded";
  readonly providerTimeoutSeconds?: number;
}

export type NukeResult = Nuke.Result;

/** Enumerate everything the stack's registered providers can see. */
export const scan = Effect.fn("Alchemist.nuke.scan")(function* (
  input: ScanInput,
) {
  const report = withSpanEvents(yield* Progress);
  const debug = yield* Config.String("DEBUG").pipe(
    Config.withDefault(""),
    Effect.map((value) => value.length > 0),
  );
  // Nuke needs the provider layer, not a stack instance: it deletes what
  // the cloud has, not what state says we own.
  const built = yield* buildStackProviders({
    main: input.entrypoint ?? DEFAULT_ENTRYPOINT,
    envFile: Option.fromNullishOr(input.envFile),
    profile: input.profile,
    logger: debug ? Logger.layer([Logger.defaultLogger]) : undefined,
    extra: Layer.succeed(MinimumLogLevel, debug ? "Debug" : "Info"),
  });
  const context = built.context as Context.Context<never>;
  const { resources, failures } = yield* Nuke.list({
    context,
    mode: input.mode,
    include: input.include,
    exclude: input.exclude,
    concurrency: input.concurrency,
    timeoutSeconds: input.providerTimeoutSeconds,
    onScan: (total) => report({ _tag: "nuke.scan.started", total }),
    onProviderStarted: (provider) =>
      report({ _tag: "nuke.scan.provider.started", provider }),
    onProvider: (provider, count, error) =>
      report({
        _tag: "nuke.scan.provider.completed",
        provider,
        resources: count,
        error,
      }),
  });
  return { mode: input.mode, resources, failures, context } satisfies NukeScan;
});

/**
 * Permanently delete the selected resources. Each confirmed deletion is
 * reported through {@link Progress} as `NukeResourceDeleted`.
 */
export const execute = Effect.fn("Alchemist.nuke.execute")(function* (
  input: ExecuteInput,
) {
  const report = withSpanEvents(yield* Progress);
  const keys = new Map(
    input.resources.map((resource, index) => [resource, `nuke/${index}`]),
  );
  const status = (
    resource: Nuke.Target,
    status: ApplyStatus,
    message?: string,
  ) =>
    report({
      _tag: "apply.resource.status",
      fqn: keys.get(resource)!,
      id: resource.providerId,
      type: resource.providerId,
      status,
      message,
    });
  return yield* Nuke.destroy({
    targets: input.resources,
    context: input.scan.context,
    strategy: input.strategy,
    concurrency: input.concurrency,
    timeoutSeconds: input.providerTimeoutSeconds,
    onPass: (pass) => report({ _tag: "nuke.pass.started", pass }),
    onDeleting: (resource) => status(resource, "deleting"),
    onHeld: (resource, blockedBy) =>
      status(resource, "skipped", `Held back by ${blockedBy.join(", ")}`),
    onDeleted: (resource) =>
      status(resource, "deleted").pipe(
        Effect.andThen(
          report({
            _tag: "nuke.resource.deleted",
            provider: resource.providerId,
            resource: resource.displayName,
          }),
        ),
      ),
    onFailed: (resource, message) =>
      status(resource, "fail", message).pipe(
        Effect.andThen(
          report({
            _tag: "nuke.resource.failed",
            provider: resource.providerId,
            resource: resource.displayName,
            message,
          }),
        ),
      ),
  });
});
