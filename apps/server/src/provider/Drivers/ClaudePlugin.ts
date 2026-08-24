/**
 * ClaudePlugin — locates the `t3` Claude Code plugin that ships with the
 * server (`apps/server/claude-plugin`), injected into every session via the
 * Agent SDK `plugins` option. The plugin carries T3-owned skills (currently
 * `t3:handoff`) without writing into the user's own `~/.claude`.
 *
 * @module provider/Drivers/ClaudePlugin
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Plugin name as declared in `.claude-plugin/plugin.json`. */
export const T3_CLAUDE_PLUGIN_NAME = "t3";

/** Where the shipped plugin lives, and how its `bin/t3` shim reaches this server's CLI. */
export interface T3ClaudePluginLocation {
  /**
   * Directory handed to the SDK `plugins` option and scanned for the skill
   * list. Never a path inside an asar archive: `claude` is a plain subprocess
   * and cannot read one, so an archived plugin loads nowhere.
   */
  readonly pluginDir: string;
  /**
   * Server CLI entry the plugin's `bin/t3` shim execs. Resolved next to the
   * running bundle, so in a packaged app it stays inside the archive — the
   * shim runs it through this process's own executable, which is asar-aware
   * when that executable is Electron.
   */
  readonly cliEntryPath?: string;
}

/**
 * `…/app.asar/rest` → `…/app.asar.unpacked/rest`, or undefined when the path
 * is not inside an archive. Covers both the desktop `app.asar` and the Windows
 * `server.asar` sidecar.
 */
export const asarUnpackedTwin = (candidate: string): string | undefined => {
  const match = /\.asar[/\\]/.exec(candidate);
  if (!match) {
    return undefined;
  }
  const boundary = match.index + ".asar".length;
  return `${candidate.slice(0, boundary)}.unpacked${candidate.slice(boundary)}`;
};

/** CLI entry points, relative to the plugin directory: source layout, then bundled. */
const CLI_ENTRY_CANDIDATES = ["../src/bin.ts", "../bin.mjs"] as const;

/**
 * Resolve the shipped plugin. Mirrors `resolveStaticDir`: prefer a bundled copy
 * next to the built entry, fall back to the monorepo source layout, and return
 * `undefined` when the plugin is unusable so a missing plugin never blocks
 * session start.
 */
export const resolveT3ClaudePluginLocation = Effect.fn("resolveT3ClaudePluginLocation")(
  function* (): Effect.fn.Return<
    T3ClaudePluginLocation | undefined,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

    const candidates = [
      // Bundled layout: dist/claude-plugin next to dist/bin.mjs.
      path.resolve(path.join(import.meta.dirname, "claude-plugin")),
      // Monorepo layout: apps/server/claude-plugin from src/provider/Drivers.
      path.resolve(path.join(import.meta.dirname, "../../../claude-plugin")),
    ];

    for (const candidate of candidates) {
      const manifestPath = path.join(candidate, ".claude-plugin", "plugin.json");
      if (!(yield* exists(manifestPath))) {
        continue;
      }

      // In a packaged app this candidate resolves through Electron's
      // asar-aware fs, so it exists for us but not for the `claude`
      // subprocess. Only the unpacked twin is a real directory; without it
      // the plugin would load nowhere while still showing up in the picker.
      const unpackedCandidate = asarUnpackedTwin(candidate);
      if (unpackedCandidate !== undefined) {
        if (!(yield* exists(path.join(unpackedCandidate, ".claude-plugin", "plugin.json")))) {
          yield* Effect.logWarning(
            `[claude] t3 plugin at ${candidate} is packed inside an asar archive and was not unpacked — t3:handoff is unavailable.`,
          );
          return undefined;
        }
      }

      // Resolved from the archived candidate rather than the twin: only
      // claude-plugin is unpacked, the server bundle itself stays packed.
      let cliEntryPath: string | undefined;
      for (const relativeEntry of CLI_ENTRY_CANDIDATES) {
        const entry = path.resolve(path.join(candidate, relativeEntry));
        if (yield* exists(entry)) {
          cliEntryPath = entry;
          break;
        }
      }

      return {
        pluginDir: unpackedCandidate ?? candidate,
        ...(cliEntryPath ? { cliEntryPath } : {}),
      };
    }
    return undefined;
  },
);
