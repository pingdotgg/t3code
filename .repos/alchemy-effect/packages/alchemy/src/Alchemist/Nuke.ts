import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Nuke from "../Nuke.ts";
import type { ProviderMode } from "../ProviderMode.ts";
import type { ConfiguredStack } from "../Stack.ts";
import { buildProviders, type ConfigOptions } from "./Operations.ts";

export interface ScanOptions extends ConfigOptions {
  /** The stack whose providers are scanned; nothing reads its state. */
  readonly stack: ConfiguredStack<unknown, unknown>;
  /** Scan the emulators `alchemy dev` runs instead of the real cloud. */
  readonly dev?: boolean;
  /** Provider-id globs to include. Omitted means every provider. */
  readonly include?: ReadonlyArray<string>;
  /** Provider-id globs to exclude. Applied after `include`. */
  readonly exclude?: ReadonlyArray<string>;
  /** Providers scanned in parallel. @default 16 */
  readonly concurrency?: number | "unbounded";
  /** Timeout for each provider's `list`. @default 120 */
  readonly providerTimeoutSeconds?: number;
}

/** One discovered cloud object, bound to the provider that can delete it. */
export type Resource = Nuke.Target;

/** Everything a stack's providers can see; only {@link execute} deletes it. */
export interface NukeScan {
  /** `local` when the scan ran with `dev: true`, otherwise `live`. */
  readonly mode: ProviderMode;
  readonly resources: ReadonlyArray<Resource>;
  /** Providers whose `list` failed; they contribute no resources. */
  readonly failures: ReadonlyArray<Nuke.ProviderFailure>;
  /**
   * The built provider context; lives in the caller's `Scope`.
   * @internal {@link execute} deletes under it.
   */
  readonly context: Context.Context<never>;
}

/**
 * List everything the stack's registered providers can see in the account.
 * The stack is imported only for its providers: nothing here reads state or
 * is scoped to a stage.
 */
export const scan = Effect.fn("Alchemist.Nuke.scan")(function* (options: ScanOptions) {
  const mode: ProviderMode = options.dev ? "local" : "live";
  const context = yield* buildProviders(options.stack, options);
  const { resources, failures } = yield* Nuke.list({
    context,
    mode,
    include: options.include,
    exclude: options.exclude,
    concurrency: options.concurrency,
    timeoutSeconds: options.providerTimeoutSeconds,
  });
  return { mode, resources, failures, context } satisfies NukeScan;
});

export interface ExecuteOptions {
  /** The scan whose resources are deleted. */
  readonly scan: NukeScan;
  /** The subset of `scan.resources` to delete. @default every planned resource */
  readonly resources?: ReadonlyArray<Resource>;
  /**
   * `coordinated` deletes in passes until one makes no progress;
   * `independent` retries each resource on its own.
   * @default { type: "coordinated" }
   */
  readonly strategy?: Nuke.Strategy;
  /** Providers deleted in parallel. @default 16 */
  readonly concurrency?: number | "unbounded";
  /** Timeout for each `delete`. @default 120 */
  readonly providerTimeoutSeconds?: number;
}

export type Result = Nuke.Result;

/**
 * Permanently delete scanned resources. Progress is emitted through
 * events: `apply.resource.status` and `nuke.*` events.
 */
export const execute = Effect.fn("Alchemist.Nuke.execute")(function* (options: ExecuteOptions) {
  return yield* Nuke.destroy({
    targets: options.resources ?? options.scan.resources,
    context: options.scan.context,
    strategy: options.strategy ?? { type: "coordinated" },
    concurrency: options.concurrency,
    timeoutSeconds: options.providerTimeoutSeconds,
  });
});
