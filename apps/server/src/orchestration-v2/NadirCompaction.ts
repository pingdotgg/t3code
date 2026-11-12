import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Nadir compaction: Claude turns run an installed Nadir's compaction hooks, which shrink bulky
// Read and Bash output locally and keep an exact archive. Its routing hooks never run from here.
// The script pins at session start, so resumed sessions stay untouched.

const PLUGIN_ID = "nadir-route@nadir";

type ClaudeHooks = NonNullable<ClaudeSdkSettings["hooks"]>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readJson = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.readFileString(file).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeJson(text))),
    Effect.orElseSucceed(() => undefined),
  );

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const SCRIPT = "context_session.py";

/** Whether a settings file wires Nadir's compaction script, as `npx nadir-labs` installs it. */
function wiresNadirScript(settings: unknown): boolean {
  const hooks = field(settings, "hooks");
  return (
    typeof hooks === "object" &&
    hooks !== null &&
    Object.values(hooks)
      .flat()
      .some((matcher) => JSON.stringify(field(matcher, "hooks") ?? []).includes(SCRIPT))
  );
}

/** Whether settings files, highest precedence first, already run Nadir's compaction. */
function runsNadirCompaction(settingsByPrecedence: ReadonlyArray<unknown>): boolean {
  // The highest file that names the plugin decides it; hooks from every file run.
  const plugin = settingsByPrecedence
    .map((settings) => field(field(settings, "enabledPlugins"), PLUGIN_ID))
    .find((enabled) => enabled !== undefined);
  return plugin === true || settingsByPrecedence.some(wiresNadirScript);
}

/**
 * The compaction script to run, or undefined when Nadir is not installed or Claude Code already
 * runs it from a settings file it loads, so the hooks never run twice. Looks in the
 * `npx nadir-labs` install first, then the `nadir-route` plugin.
 */
export const findNadirCompactionScript = Effect.fn("NadirCompaction.findScript")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly claudeHome: string;
  readonly hostHome: string;
  /** The settings files Claude Code loads for this session, highest precedence first. */
  readonly settingsFiles: ReadonlyArray<string>;
  /** The `--settings` launch argument, which outranks every file. */
  readonly launchSettings?: unknown;
}) {
  const { fileSystem, path, claudeHome } = input;
  const settings = [
    input.launchSettings,
    ...(yield* Effect.forEach(input.settingsFiles, (file) => readJson(fileSystem, file))),
  ];
  if (runsNadirCompaction(settings)) return undefined;
  const homes = [claudeHome, path.join(input.hostHome, ".claude")];
  const pluginScripts: string[] = [];
  for (const home of homes) {
    const installed = yield* readJson(
      fileSystem,
      path.join(home, "plugins", "installed_plugins.json"),
    );
    const entries = field(field(installed, "plugins"), PLUGIN_ID);
    // Every install counts: an earlier one can be stale.
    for (const entry of Array.isArray(entries) ? entries : []) {
      const pluginPath = field(entry, "installPath");
      if (typeof pluginPath === "string")
        pluginScripts.push(path.join(pluginPath, "scripts", SCRIPT));
    }
  }
  const candidates = [...homes.map((home) => path.join(home, "nadir", SCRIPT)), ...pluginScripts];
  for (const script of candidates) {
    const isFile = yield* fileSystem.stat(script).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (isFile) return script;
  }
  return undefined;
});

/** The plugin's own compaction hook entries, in exec form so no shell parses the paths. */
export function nadirCompactionHooks(script: string, stateDir: string): ClaudeHooks {
  const hooks = [
    {
      type: "command" as const,
      command: "python3",
      args: [script, "--state-dir", stateDir, "--max-chars", "8000", "--no-policy"],
      timeout: 5,
    },
  ];
  return {
    SessionStart: [{ matcher: "startup|clear|resume|compact", hooks }],
    UserPromptSubmit: [{ hooks }],
    SubagentStart: [{ matcher: ".*", hooks }],
    PreToolUse: [{ matcher: "Read", hooks }],
    PostToolUse: [{ matcher: "Read|Bash", hooks }],
  };
}

/** Adds hook entries after any the settings already carry. */
export function withExtraHooks(
  settings: ClaudeSdkSettings | undefined,
  extra: ClaudeHooks,
): ClaudeSdkSettings {
  const hooks: ClaudeHooks = { ...settings?.hooks };
  for (const [event, matchers] of Object.entries(extra)) {
    hooks[event] = [...(hooks[event] ?? []), ...matchers];
  }
  return { ...settings, hooks };
}
