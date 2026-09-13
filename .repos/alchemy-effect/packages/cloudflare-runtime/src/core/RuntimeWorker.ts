import type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
import type { QueueConsumer } from "./bindings/queue/QueueOptions.shared.ts";
import type { ContainerImage } from "./Docker.ts";
import type { BindingHook } from "./PluginContext.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type { OutputSink } from "./workerd/Workerd.ts";

export interface RuntimeWorker<B extends BindingHooks = BindingHooks> {
  readonly name: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly bindings: B;
  readonly modules: ReadonlyArray<Module>;
  readonly assets?: Assets;
  readonly hyperdrives?: Record<string, HyperdriveOrigin>;
  readonly durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>;
  /**
   * Workflows whose `WorkflowEntrypoint` class is exported by this worker.
   * Each entry hosts a local engine service (`workflows:<name>`) in this
   * process and is published to the dev registry for cross-instance bindings.
   */
  readonly workflows?: ReadonlyArray<Workflow>;
  /**
   * Queues this worker consumes via its `queue()` handler. Each consumed
   * queue gets an in-memory broker hosted in this worker's process; producers
   * (local or in other dev instances) deliver to it.
   */
  readonly queueConsumers?: ReadonlyArray<QueueConsumer>;
  /**
   * Cron expressions (UTC) that trigger this worker's `scheduled()` handler.
   * Each expression gets a Node-side timer that hits the entry socket's
   * `/cdn-cgi/handler/scheduled` route at every match, so crons actually
   * fire during local development. The route is also reachable manually
   * (Miniflare-compatible: `?cron=<expr>&time=<epoch-millis>`).
   */
  readonly crons?: ReadonlyArray<string>;
  /**
   * Names of tail consumer workers (the deployed `tail_consumers` setting).
   * workerd delivers this worker's trace events to each consumer's `tail()`
   * handler. Consumers are resolved through the on-disk dev registry — the
   * same path service bindings to other local workers take — so a consumer
   * may run in a separate `cloudflare-runtime` or `wrangler dev` process and
   * may (re)start at any time. Events produced while a consumer is not
   * running are dropped with a warning, matching dev-registry semantics.
   */
  readonly tails?: ReadonlyArray<string>;
  /**
   * Names of streaming tail consumer workers (the deployed
   * `streaming_tail_consumers` setting). The handler contract differs from
   * plain `tails`: a plain tail consumer exports `tail(items)` and receives an
   * array of completed `TraceItem`s after the producer's invocation has
   * finished, while a streaming tail consumer exports `tailStream(event)`,
   * which is invoked with the invocation's `onset` event as soon as the
   * producer starts executing and returns a handler (a function, or an object
   * keyed by event type) that receives every subsequent event (`spanOpen` /
   * `spanClose`, `log`, `exception`, `diagnosticChannel`, `return`, …)
   * streamed live during execution, ending with the terminal `outcome` event.
   * Consumers are resolved through the on-disk dev registry exactly like
   * `tails` — the registry proxy's `ExternalService` entrypoint forwards the
   * `tailStream()` session to the consumer's process via the workerd debug
   * port — so a consumer may run in a separate process and may (re)start at
   * any time. Sessions started while a consumer is not running are dropped
   * with a warning, matching dev-registry semantics.
   */
  readonly streamingTails?: ReadonlyArray<string>;
  /**
   * Whether the Cache API (`caches.default` / `caches.open()`) stores
   * responses. Defaults to `true`; when `false` every cache operation is a
   * no-op (matching production behaviour on `workers.dev` subdomains).
   */
  readonly cache?: boolean;
  /**
   * Per-worker `request.cf` blob. Merged the way Miniflare does — used
   * verbatim unless the request carries an `MF-CF-Blob` header. Falls back
   * to the runtime-wide `Cf` reference (a static placeholder by default).
   */
  readonly cf?: Record<string, unknown>;
  /**
   * Controls how output from the underlying `workerd` process is surfaced.
   *
   * By default, workerd does not log uncaught exceptions thrown by the
   * worker — they surface as bare `500 Internal Server Error` responses with
   * no output anywhere. Set `verbose: true` to have workerd log them
   * (message + stack) to stderr, and optionally `onOutput` to capture the
   * process output instead of inheriting the parent process's stdio.
   */
  readonly logging?: WorkerdLogging;
  readonly unsafe?: Partial<WorkerdConfig.Worker>;
}

export interface WorkerdLogging {
  /**
   * Pass `--verbose` to workerd. Enables INFO-level logging, which includes
   * uncaught exceptions thrown by the worker (message + stack, written to
   * stderr) — without it, those exceptions surface as bare
   * `500 Internal Server Error` responses with no log output anywhere.
   */
  readonly verbose?: boolean;
  /**
   * Capture the workerd process's stdout/stderr output instead of piping it
   * to the parent process's stdio. Output produced before the process
   * finishes starting is not captured; startup failures surface as typed
   * errors instead.
   */
  readonly onOutput?: OutputSink;
}

export type BindingHooks = ReadonlyArray<BindingHook<any>>;

export type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
export type { QueueConsumer } from "./bindings/queue/QueueOptions.shared.ts";

export type Module =
  | {
      name: string;
      type:
        | "ESModule"
        | "CommonJsModule"
        | "Text"
        | "Json"
        | "PythonModule"
        | "PythonRequirement";
      content: string;
    }
  | {
      name: string;
      type: "Data" | "Wasm";
      content: Uint8Array;
    };

export interface Assets {
  directory?: string;
  headers?: string;
  redirects?: string;
  htmlHandling?:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  runWorkerFirst?: Array<string> | boolean;
  serveDirectly?: boolean;
}

export interface DurableObjectNamespace {
  className: string;
  sql: boolean;
  uniqueKey?: string;
  ephemeralLocal?: true;
  /**
   * Attach a container to every Durable Object in this namespace. workerd
   * starts one per DO instance via the worker's `containerEngine` and exposes
   * it as `ctx.container`.
   */
  container?: ContainerImage;
}

export interface Workflow {
  /**
   * Logical name of the workflow. Used as the engine identity
   * (`workflows:<workflowName>`) and published to the dev registry.
   */
  workflowName: string;
  /**
   * Class name of the `WorkflowEntrypoint` exported by this worker.
   */
  className: string;
  /**
   * Optional step limit enforced by the local workflow engine.
   */
  stepLimit?: number;
}
