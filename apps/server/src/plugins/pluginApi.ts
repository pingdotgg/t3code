import type { PluginEvent as PluginEventSchema } from "@t3tools/contracts";

// Activation runs once per child on first use; the signal aborts before bounded deactivation.
// Proposed APIs require manifest opt-in and can change without an API-version bump.
export type PluginJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<PluginJson>
  | { readonly [key: string]: PluginJson };

interface PluginLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface PluginHandlerContext {
  /** Aborts when the server cancels the call; the handler should settle promptly. */
  readonly signal: AbortSignal;
}

export type PluginHandler = (
  input: PluginJson,
  context: PluginHandlerContext,
) => PluginJson | Promise<PluginJson>;

interface PluginDisposable {
  dispose(): void;
}

/** One event from the environment, as JSON (see `PluginEvent` in contracts). */
export type PluginEvent = typeof PluginEventSchema.Encoded;

export type PluginEventHandler = (
  event: PluginEvent,
  context: PluginHandlerContext,
) => void | Promise<void>;

interface PluginProposedApi {
  /**
   * Registers the entry point the server calls by `name`. Names are unique per
   * plugin; names starting with `t3.` are reserved.
   */
  handle(name: string, handler: PluginHandler): PluginDisposable;
  // Register during activate; a failed handler retries the whole page.
  // Delivery is at-least-once: deduplicate by deliveryId and ignore unknown event types.
  onEvent(handler: PluginEventHandler): PluginDisposable;
}

export interface PluginContext {
  readonly apiVersion: 1;
  readonly plugin: { readonly id: string; readonly version: string };
  readonly signal: AbortSignal;
  readonly log: PluginLog;
  readonly proposed: PluginProposedApi | undefined;
}

export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
