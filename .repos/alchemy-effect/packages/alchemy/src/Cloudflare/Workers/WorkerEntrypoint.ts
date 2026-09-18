import type { Rpc } from "@cloudflare/workers-types";
import type { Input } from "../../Input.ts";
import type { Worker } from "./Worker.ts";

type WorkerEntrypointTypeId = "Cloudflare.WorkerEntrypoint";
const WorkerEntrypointTypeId: WorkerEntrypointTypeId =
  "Cloudflare.WorkerEntrypoint";

export interface WorkerEntrypointOptions {
  /**
   * Named entrypoint on the target Worker — the exported
   * `WorkerEntrypoint` class the binding calls. Omitted → the default
   * entrypoint (equivalent to binding the Worker directly, but with
   * {@link props} support).
   */
  entrypoint?: string;
  /**
   * Properties exposed to the target entrypoint via workerd's
   * `ctx.props`. Values accept `Output` references and resolve at deploy
   * time.
   *
   * Local dev (`alchemy dev`) delivers these today. On deployed Workers
   * the Cloudflare API's binding schema does not carry `props` yet, so
   * they are typed and plumbed but dropped at upload until the distilled
   * `workers` service adds the field.
   */
  props?: Record<string, Input<unknown>>;
}

/**
 * A service binding to a specific entrypoint of another Worker — the value
 * form accepted in an async Worker's `env`. See {@link WorkerEntrypoint}.
 */
export interface WorkerEntrypointBinding<
  Entrypoint extends Rpc.WorkerEntrypointBranded | undefined = undefined,
> {
  /** Brand discriminating entrypoint bindings in `env` classification. */
  readonly kind: WorkerEntrypointTypeId;
  /** The target Worker resource. */
  readonly worker: Worker;
  /** Named entrypoint on the target, or `undefined` for the default. */
  readonly entrypoint: string | undefined;
  /** `ctx.props` delivered to the target entrypoint. */
  readonly props: Record<string, Input<unknown>> | undefined;
  /** Entry-point instance type used by `InferEnv`; absent at runtime. */
  readonly "~alchemy/entrypoint"?: Entrypoint;
}

/**
 * Bind a specific `WorkerEntrypoint` class exported by another Worker.
 *
 * Binding a Worker directly in `env` (`env: { TARGET: worker }`) targets
 * its *default* entrypoint. A Worker that exposes additional
 * `WorkerEntrypoint` classes — workerd treats every named class export of
 * an entry module as an entrypoint — is bound with `WorkerEntrypoint`,
 * which selects the class by name and can deliver `ctx.props` to it.
 *
 * ### Defining the Target Entrypoint
 * Export a class extending Cloudflare's native `WorkerEntrypoint` from
 * the target Worker's module. This `Api` class defines the RPC methods
 * that callers can invoke through a named service binding.
 *
 * **Example:** Export the Api class
 * ```typescript
 * // target/src/worker.ts
 * import { WorkerEntrypoint } from "cloudflare:workers";
 *
 * export class Api extends WorkerEntrypoint {
 *   async greet(name: string): Promise<string> {
 *     return `hello ${name}`;
 *   }
 * }
 *
 * export default {
 *   async fetch() {
 *     return new Response("ok");
 *   },
 * };
 * ```
 *
 * ### Binding a Named Entrypoint
 * Import the exported `Api` class as a type and select its named export
 * with `"Api"`. Pass its instance type (`Api`, not `typeof Api`) to get
 * Cloudflare's native `Service<Api>` RPC client. Without a type argument,
 * the binding is a bare `Fetcher`; the entrypoint name alone cannot
 * identify the class's type.
 *
 * **Example:** Bind and call the exported Api
 * ```typescript
 * // alchemy.run.ts
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import type { Api } from "./target/src/worker.ts";
 *
 * const target = yield* Cloudflare.Worker("Target", {
 *   main: "./target/src/worker.ts",
 * });
 *
 * const caller = yield* Cloudflare.Worker("Caller", {
 *   main: "./caller/src/worker.ts",
 *   env: {
 *     API: Cloudflare.WorkerEntrypoint<Api>(target, "Api"),
 *   },
 * });
 * ```
 *
 * ```typescript
 * // caller/src/worker.ts
 * import type { CallerEnv } from "../../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: CallerEnv) {
 *     return new Response(await env.API.greet("alice"));
 *   },
 * };
 * ```
 *
 * ### Delivering ctx.props
 * The options form attaches properties the target reads from
 * `this.ctx.props` — workerd's per-binding configuration channel. `Output`
 * values resolve at deploy time.
 *
 * **Example:** Entrypoint binding with props
 * ```typescript
 * env: {
 *   VENDOR: Cloudflare.WorkerEntrypoint(vendorWorker, {
 *     entrypoint: "Vendor",
 *     props: { baseUrl: site.url },
 *   }),
 * }
 * ```
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const WorkerEntrypoint = <
  Entrypoint extends Rpc.WorkerEntrypointBranded | undefined = undefined,
>(
  worker: Worker,
  entrypointOrOptions?: string | WorkerEntrypointOptions,
): WorkerEntrypointBinding<NoInfer<Entrypoint>> => {
  const options =
    typeof entrypointOrOptions === "string"
      ? { entrypoint: entrypointOrOptions }
      : (entrypointOrOptions ?? {});
  return {
    kind: WorkerEntrypointTypeId,
    worker,
    entrypoint: options.entrypoint,
    props: options.props,
  };
};

/** Structural guard for {@link WorkerEntrypointBinding} `env` values. */
export const isWorkerEntrypoint = (
  value: unknown,
): value is WorkerEntrypointBinding<any> =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === WorkerEntrypointTypeId;
