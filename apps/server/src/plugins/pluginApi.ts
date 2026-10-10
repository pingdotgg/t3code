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

interface PluginProposedApi {
  /** Registers the entry point the server calls by `name`. Names are unique per plugin. */
  handle(name: string, handler: PluginHandler): PluginDisposable;
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
