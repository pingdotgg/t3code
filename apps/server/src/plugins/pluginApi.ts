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
/**
 * Reads the settings declared under `settings` in the manifest. Present with
 * the `settings` capability.
 */
interface PluginSettingsApi {
  /**
   * The saved value of a declared setting, else its default, else undefined.
   * A secret resolves to its saved text. Rejects for an undeclared key.
   */
  get(key: string): Promise<string | number | boolean | undefined>;
}

/**
 * Small JSON values the plugin keeps between runs, private to this
 * installation and deleted when it is removed. Bounded: keys up to 128
 * characters, values up to 64 KiB of JSON, 256 keys and 1 MiB in total; a
 * write past a bound rejects. Present with the `settings` capability.
 */
interface PluginStorageApi {
  get(key: string): Promise<PluginJson | undefined>;
  set(key: string, value: PluginJson): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<ReadonlyArray<string>>;
}

type PluginTone = "neutral" | "info" | "success" | "warning" | "error";

// Statuses require the capability, remain bounded and rate-limited, and clear when the process stops.
// Text is one plain line, truncated to 80 characters; empty text clears its key.
interface PluginStatusApi {
  set(status: {
    readonly threadId: string;
    /** Up to 64 characters; setting an existing key replaces it. */
    readonly key: string;
    readonly text: string;
    readonly tone?: PluginTone;
    /** Up to 240 characters. */
    readonly tooltip?: string;
  }): Promise<void>;
  clear(status: { readonly threadId: string; readonly key: string }): Promise<void>;
}

/**
 * A short notification, shown as a toast on connected clients. Present with
 * the `notifications` capability. Best-effort, not durable: clients that are
 * not connected may never see it. 5 at once, then one every 5 seconds;
 * past that the call rejects.
 */
type PluginNotifyInput = {
  /** One line, up to 80 characters. */
  readonly title: string;
  /** Up to 240 characters. */
  readonly body?: string;
  readonly tone?: PluginTone;
  /** A thread the notification is about; clients offer to open it. */
  readonly threadId?: string;
};

export interface PluginProposedApi {
  /**
   * Registers the entry point the server calls by `name`. Names are unique per
   * plugin; names starting with `t3.` are reserved, except the ones the server
   * calls for a declared contribution: `t3.tool.<name>` and `t3.transform.enrich`.
   */
  handle(name: string, handler: PluginHandler): PluginDisposable;
  // Register during activate; a failed handler retries the whole page.
  // Delivery is at-least-once: deduplicate by deliveryId and ignore unknown event types.
  onEvent(handler: PluginEventHandler): PluginDisposable;
  readonly settings: PluginSettingsApi | undefined;
  readonly storage: PluginStorageApi | undefined;
  readonly status: PluginStatusApi | undefined;
  readonly notify: ((notification: PluginNotifyInput) => Promise<void>) | undefined;
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
