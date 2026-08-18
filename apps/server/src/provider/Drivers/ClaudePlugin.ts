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

/**
 * Resolve the shipped plugin directory. Mirrors `resolveStaticDir`: prefer a
 * bundled copy next to the built entry, fall back to the monorepo source
 * layout, and return `undefined` when neither exists so a missing plugin
 * never blocks session start.
 */
export const resolveT3ClaudePluginDir = Effect.fn("resolveT3ClaudePluginDir")(
  function* (): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const candidates = [
      // Bundled layout: dist/claude-plugin next to dist/bin.mjs.
      path.resolve(path.join(import.meta.dirname, "claude-plugin")),
      // Monorepo layout: apps/server/claude-plugin from src/provider/Drivers.
      path.resolve(path.join(import.meta.dirname, "../../../claude-plugin")),
    ];

    for (const candidate of candidates) {
      const manifestExists = yield* fileSystem
        .exists(path.join(candidate, ".claude-plugin", "plugin.json"))
        .pipe(Effect.orElseSucceed(() => false));
      if (manifestExists) {
        return candidate;
      }
    }
    return undefined;
  },
);
