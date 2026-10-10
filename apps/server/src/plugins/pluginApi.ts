import type { PluginEvent as PluginEventSchema } from "@t3tools/contracts";

/**
 * The surface a plugin entry module sees, plugin API version 1.
 *
 * An entry module exports `activate(context)` and optionally `deactivate()`:
 *
 * ```js
 * export function activate(context) {
 *   context.log.info(`started ${context.plugin.id}`);
 * }
 * ```
 *
 * `activate` runs once per child process, the first time the server needs the
 * plugin. `context.signal` aborts when the plugin is disabled or the server
 * stops; `deactivate` then gets a short grace period before the process is
 * killed. Members under `context.proposed` exist only when the manifest sets
 * `proposedApi: true` and may change without an API version bump.
 *
 * Actions (capability `actions`): each action the manifest declares runs the
 * handler registered as `context.proposed.handle("action:<name>", handler)`.
 * Its input is `{ action, target }`, with `target` as described by
 * `PluginActionTargetContext` in PluginActions.ts. Return `{ message }` to
 * show the user a short result, or throw to report a failure.
 */
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

/**
 * Short advisory statuses on threads, shown beside provider statuses on every
 * client. Present with the `status` capability. Text is one plain line (up to
 * 80 characters, longer text is truncated); empty text clears the key. A
 * plugin shows at most 16 statuses at once and 10 updates at once, then 2 per
 * second; past a bound `set` rejects. Everything is cleared when the plugin's
 * process stops, so set statuses again after a restart.
 */
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

export interface PluginProposedApi {
  /**
   * Registers the entry point the server calls by `name`. Names are unique per
   * plugin; names starting with `t3.` are reserved.
   */
  handle(name: string, handler: PluginHandler): PluginDisposable;
  /**
   * Receives environment events, in log order, when the manifest declares the
   * `events` capability. Register during `activate`. The server acknowledges a
   * page of events once every handler returned for each of them; a throw or
   * rejection fails the page, and the same events arrive again later.
   * Delivery is at-least-once: deduplicate side effects by `event.deliveryId`
   * and ignore event types you do not know.
   */
  onEvent(handler: PluginEventHandler): PluginDisposable;
  readonly settings: PluginSettingsApi | undefined;
  readonly storage: PluginStorageApi | undefined;
  readonly status: PluginStatusApi | undefined;
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
