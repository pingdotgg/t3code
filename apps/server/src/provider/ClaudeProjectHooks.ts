import {
  ClaudeProjectHooksError,
  type ClaudeProjectHook,
  managedPolicyDeniedMessage,
  ProjectId,
  type WorkspaceClaudeProjectHooksResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";

/** Where a session reads its project configuration from in place of its folder. */
export interface ClaudeSessionProjectConfig {
  /**
   * Claude Code's `projectConfigRoot`: a folder T3 Code wrote that holds the folder's Claude Code
   * settings as they were when the session was checked, with their hooks and helper commands only
   * where a person approved exactly those, and links to the rest of the folder.
   */
  readonly projectConfigRoot: string;
  /** The line the thread shows when the hooks and helper commands were left out. */
  readonly notice: string | null;
}

/**
 * Whether a Claude session runs the commands its folder's `.claude/settings.json` and
 * `.claude/settings.local.json` name for Claude Code to run by itself, which are their hooks and
 * helper commands: only once a person approved exactly these for the project, or in a thread in
 * Full access. Read side only; `ClaudeProjectHookApprovalWrites` records an approval.
 */
export class ClaudeProjectHooks extends Context.Service<
  ClaudeProjectHooks,
  {
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
    }) => Effect.Effect<WorkspaceClaudeProjectHooksResult, ClaudeProjectHooksError>;
    /**
     * For a session about to open in `cwd`. Null opens it on the folder as it is: it declares
     * nothing to approve, or the thread is in Full access now, which is what `fullAccess` says.
     * Otherwise the session reads the settings this call read, so what was checked is what runs.
     */
    readonly forSession: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
      readonly fullAccess: boolean;
    }) => Effect.Effect<ClaudeSessionProjectConfig | null, ClaudeProjectHooksError>;
  }
>()("t3/provider/ClaudeProjectHooks") {}

export const failed = (detail: string) => (cause: unknown) =>
  new ClaudeProjectHooksError({ detail, cause });

const NEEDS_APPROVAL_NOTICE =
  "This project's Claude Code hooks and helper commands are not approved, so this session runs without them. Review and approve them in this thread or in the project's settings; they run from the next session on.";

type Settings = Readonly<Record<string, unknown>>;

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Key order is not part of what a person approved. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : Predicate.isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

const hookDetail = (hook: unknown) => {
  if (Predicate.isObject(hook)) {
    for (const key of ["command", "url", "prompt"] as const) {
      const text = hook[key];
      if (typeof text === "string") return text;
    }
  }
  return encodeJson(hook);
};

/** Every hook a settings file's `hooks` holds. A shape Claude Code may not know is shown as it is written. */
const listHooks = (
  source: ClaudeProjectHook["source"],
  hooks: unknown,
): ReadonlyArray<ClaudeProjectHook> => {
  if (hooks === undefined || hooks === null) return [];
  if (!Predicate.isObject(hooks)) {
    return [{ kind: "hook", source, event: "", detail: encodeJson(hooks) }];
  }
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : [groups]).flatMap(
      (group): ReadonlyArray<ClaudeProjectHook> => {
        if (!Predicate.isObject(group) || !Array.isArray(group.hooks)) {
          return [{ kind: "hook", source, event, detail: encodeJson(group) }];
        }
        const matcher =
          typeof group.matcher === "string" && group.matcher.length > 0
            ? { matcher: group.matcher }
            : {};
        return group.hooks.map((hook) => ({
          kind: "hook" as const,
          source,
          event,
          ...matcher,
          detail: hookDetail(hook),
        }));
      },
    ),
  );
};

/**
 * Settings that name a command Claude Code runs by itself to fetch credentials or headers. A
 * project's own `env` can select the provider or exporter that makes Claude Code run one.
 */
const HELPER_KEYS = [
  "apiKeyHelper",
  "proxyAuthHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
] as const;

/** The keys of a settings file an approval covers, and a session without one leaves out. */
const APPROVED_KEYS: ReadonlyArray<string> = ["hooks", ...HELPER_KEYS];

/** What a settings file asks to run by itself, hooks first. */
const listCommands = (
  source: ClaudeProjectHook["source"],
  settings: Settings | undefined,
): ReadonlyArray<ClaudeProjectHook> =>
  settings === undefined
    ? []
    : [
        ...listHooks(source, settings.hooks),
        ...HELPER_KEYS.flatMap((key): ReadonlyArray<ClaudeProjectHook> => {
          const value = settings[key];
          if (value === undefined || value === null) return [];
          return [
            {
              kind: "helper",
              source,
              event: key,
              detail: typeof value === "string" ? value : encodeJson(value),
            },
          ];
        }),
      ];

const withoutCommands = (settings: Settings): Settings =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => !APPROVED_KEYS.includes(key)));

/** The part of a settings file an approval is for. Null when it asks to run nothing. */
const approvedPart = (source: ClaudeProjectHook["source"], settings: Settings | undefined) =>
  settings === undefined || listCommands(source, settings).length === 0
    ? null
    : Object.fromEntries(Object.entries(settings).filter(([key]) => APPROVED_KEYS.includes(key)));

/** Claude Code's merge of two settings files: lists join, objects merge, the later value wins. */
const mergeSettings = (lower: unknown, higher: unknown): unknown => {
  if (Array.isArray(lower) && Array.isArray(higher)) {
    const seen = new Set(lower.map((item) => encodeJson(item)));
    return [...lower, ...higher.filter((item) => !seen.has(encodeJson(item)))];
  }
  if (Predicate.isObject(lower) && Predicate.isObject(higher)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(lower), ...Object.keys(higher)])].map((key) => [
        key,
        key in lower && key in higher
          ? mergeSettings(lower[key], higher[key])
          : key in higher
            ? higher[key]
            : lower[key],
      ]),
    );
  }
  return higher;
};

const SETTINGS_FILE = "settings.json";
const LOCAL_SETTINGS_FILE = "settings.local.json";
const MCP_CONFIG_FILE = ".mcp.json";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const offBy = ManagedPolicy.deniedBy(managedPolicy, "claudeProjectHooks");

  const sha256Bytes = (bytes: Uint8Array) =>
    digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));
  const sha256 = (value: unknown) =>
    sha256Bytes(new TextEncoder().encode(encodeJson(canonical(value)))).pipe(
      Effect.mapError(failed("Could not hash the project's hooks.")),
    );

  const findApproval = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, hooksHash: Schema.String }),
    Result: Schema.Struct({ hooksHash: Schema.String }),
    execute: ({ projectId, hooksHash }) => sql`
      SELECT hooks_hash AS "hooksHash" FROM claude_project_hook_approvals
      WHERE project_id = ${projectId} AND hooks_hash = ${hooksHash}
    `,
  });
  const countApprovals = SqlSchema.findOne({
    Request: ProjectId,
    Result: Schema.Struct({ approvals: Schema.Number }),
    execute: (projectId) => sql`
      SELECT COUNT(*) AS "approvals" FROM claude_project_hook_approvals
      WHERE project_id = ${projectId}
    `,
  });

  // A file Claude Code cannot read as settings gives it no hooks either, so it counts as absent.
  const readSettings = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => Option.getOrUndefined(decodeSettings(text))),
      Effect.orElseSucceed(() => undefined),
    );

  /** The settings files Claude Code reads for a session in `cwd`. */
  const readFolder = Effect.fn("ClaudeProjectHooks.readFolder")(function* (cwd: string) {
    const localDirectory = yield* claudeLocalSettingsDirectory(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const readLocal = (directory: string) =>
      readSettings(path.join(directory, ".claude", LOCAL_SETTINGS_FILE));
    const project = yield* readSettings(path.join(cwd, ".claude", SETTINGS_FILE));
    // In a worktree Claude Code reads the main checkout's local file, and one left in cwd under it.
    const worktreeLocal = localDirectory === cwd ? undefined : yield* readLocal(cwd);
    const local = yield* readLocal(localDirectory);
    const hooks = [
      ...listCommands("project", project),
      ...listCommands("local", worktreeLocal),
      ...listCommands("local", local),
    ];
    // One place per file, so a file that asks to run nothing counts the same as no file.
    const hooksHash = yield* sha256([
      approvedPart("project", project),
      approvedPart("local", worktreeLocal),
      approvedPart("local", local),
    ]);
    // Lowest precedence first.
    const locals = [worktreeLocal, local].filter((settings) => settings !== undefined);
    return { project, locals, hooks, hooksHash };
  });

  const statusOf = Effect.fn("ClaudeProjectHooks.statusOf")(function* (
    projectId: ProjectId,
    folder: { readonly hooks: ReadonlyArray<ClaudeProjectHook>; readonly hooksHash: string },
  ) {
    if (folder.hooks.length === 0) return "none" as const;
    if (offBy !== undefined) return "off" as const;
    const approval = yield* findApproval({ projectId, hooksHash: folder.hooksHash }).pipe(
      Effect.mapError(failed("Could not read the approvals of the project's hooks.")),
    );
    return approval._tag === "Some" ? ("approved" as const) : ("needs-approval" as const);
  });

  /** Names every file under `directory` and what it holds. */
  const digestTree = Effect.fnUntraced(function* (directory: string) {
    const names = (yield* fileSystem.readDirectory(directory, { recursive: true })).toSorted();
    return yield* Effect.forEach(names, (name) =>
      fileSystem.readFile(path.join(directory, name)).pipe(
        Effect.flatMap(sha256Bytes),
        // A folder has no contents of its own.
        Effect.orElseSucceed(() => null),
        Effect.map((contents) => [name, contents] as const),
      ),
    );
  });

  /**
   * Writes the folder Claude Code reads project configuration from in place of `cwd`: the two
   * settings files as `folder` holds them, with what they ask to run only when `approved`. Named
   * by what it holds, so sessions that agree share one and none sees another's half-written files.
   */
  const writeConfigRoot = Effect.fn("ClaudeProjectHooks.writeConfigRoot")(
    function* (
      cwd: string,
      folder: Effect.Success<ReturnType<typeof readFolder>>,
      approved: boolean,
    ) {
      const kept = (settings: Settings) => (approved ? settings : withoutCommands(settings));
      const files = new Map<string, string>();
      if (folder.project !== undefined) {
        files.set(SETTINGS_FILE, encodeJson(kept(folder.project)));
      }
      if (folder.locals.length > 0) {
        files.set(
          LOCAL_SETTINGS_FILE,
          encodeJson(folder.locals.map(kept).reduce<unknown>(mergeSettings, {})),
        );
      }
      const listed = (directory: string) =>
        fileSystem.readDirectory(directory).pipe(
          Effect.map((entries) => entries.toSorted()),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      const claudeDirectory = path.join(cwd, ".claude");
      const entries = (yield* listed(claudeDirectory)).filter(
        (entry) => entry !== SETTINGS_FILE && entry !== LOCAL_SETTINGS_FILE,
      );
      // Claude Code runs hooks and `.mcp.json` servers in this folder and names it in
      // `CLAUDE_PROJECT_DIR`, so the project's own files are linked in for the paths they use.
      // Not `.git`: Git run here would take the links for the project's files.
      const projectEntries = (yield* listed(cwd)).filter(
        (entry) => entry !== ".claude" && entry !== ".git",
      );
      const parent = path.join(stateDir, "claude-project-config");
      const name = (yield* sha256([cwd, [...files], entries, projectEntries])).slice(0, 32);

      // A session may have written to the settings it was given. The next one starts from these.
      const restoreSettings = (root: string) =>
        Effect.forEach(
          [SETTINGS_FILE, LOCAL_SETTINGS_FILE],
          Effect.fnUntraced(function* (file) {
            const target = path.join(root, ".claude", file);
            const expected = files.get(file);
            const held = yield* fileSystem
              .readFileString(target)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (held === expected) return;
            if (expected === undefined) return yield* fileSystem.remove(target, { force: true });
            const replacement = yield* fileSystem.makeTempFile({
              directory: parent,
              prefix: "settings-",
            });
            yield* fileSystem.writeFileString(replacement, expected);
            yield* fileSystem.rename(replacement, target);
          }),
          { discard: true },
        ).pipe(Effect.as(root));

      const linked = path.join(parent, name);
      if (yield* fileSystem.exists(linked)) return yield* restoreSettings(linked);
      yield* fileSystem.makeDirectory(parent, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectory({
        directory: parent,
        prefix: "staging-",
      });
      const discardStaging = fileSystem.remove(staging, { recursive: true, force: true });
      // Where links are not allowed, as on Windows without developer mode, a copy stands in.
      let copied = false;
      const link = (from: string, to: string) =>
        fileSystem.symlink(from, to).pipe(
          Effect.catch(() => {
            copied = true;
            return fileSystem.copy(from, to, { overwrite: true });
          }),
        );
      yield* fileSystem.makeDirectory(path.join(staging, ".claude"));
      yield* Effect.forEach(
        files,
        ([file, text]) => fileSystem.writeFileString(path.join(staging, ".claude", file), text),
        { discard: true },
      );
      yield* Effect.forEach(
        entries,
        (entry) => link(path.join(claudeDirectory, entry), path.join(staging, ".claude", entry)),
        { discard: true },
      );
      if (projectEntries.includes(MCP_CONFIG_FILE)) {
        yield* link(path.join(cwd, MCP_CONFIG_FILE), path.join(staging, MCP_CONFIG_FILE));
      }
      // The project is not copied: without links, paths here do not lead to its files.
      if (!copied) {
        yield* Effect.forEach(
          projectEntries.filter((entry) => entry !== MCP_CONFIG_FILE),
          (entry) =>
            fileSystem
              .symlink(path.join(cwd, entry), path.join(staging, entry))
              .pipe(Effect.ignore),
          { discard: true },
        );
      }
      // A copy does not follow the project, so it is named by what was copied as well: a session
      // reads the files as they were when it started, and one that starts later reads them anew.
      const root = copied
        ? path.join(
            parent,
            `copy-${(yield* sha256([name, yield* digestTree(staging)])).slice(0, 32)}`,
          )
        : linked;
      if (copied && (yield* fileSystem.exists(root))) {
        yield* discardStaging;
        return yield* restoreSettings(root);
      }
      yield* fileSystem.rename(staging, root).pipe(
        Effect.catch((cause) =>
          discardStaging.pipe(
            Effect.andThen(fileSystem.exists(root)),
            // Another session may have put the same folder in place meanwhile.
            Effect.flatMap((published) => (published ? Effect.void : Effect.fail(cause))),
          ),
        ),
      );
      return root;
    },
    Effect.mapError(
      failed("Could not prepare the project's Claude Code settings for the session."),
    ),
  );

  return ClaudeProjectHooks.of({
    read: Effect.fn("ClaudeProjectHooks.read")(function* ({ projectId, cwd }) {
      const folder = yield* readFolder(cwd);
      const { approvals } = yield* countApprovals(projectId).pipe(
        Effect.mapError(failed("Could not read the approvals of the project's hooks.")),
      );
      return {
        status: yield* statusOf(projectId, folder),
        hooks: folder.hooks,
        hooksHash: folder.hooksHash,
        approvals,
      };
    }),
    forSession: Effect.fn("ClaudeProjectHooks.forSession")(function* ({
      projectId,
      cwd,
      fullAccess,
    }) {
      const folder = yield* readFolder(cwd);
      const status = yield* statusOf(projectId, folder);
      if (status === "none") return null;
      if (status !== "off" && fullAccess) return null;
      // Approved hooks run from the settings read here, not from the folder: it can change before
      // Claude Code starts, and Claude Code follows its settings files while it runs.
      const approved = status === "approved";
      return {
        projectConfigRoot: yield* writeConfigRoot(cwd, folder, approved),
        notice: approved
          ? null
          : offBy === undefined
            ? NEEDS_APPROVAL_NOTICE
            : `${managedPolicyDeniedMessage(offBy, "the hooks in a project's Claude Code settings")} This session runs without them.`,
      };
    }),
  });
});

export const layer = Layer.effect(ClaudeProjectHooks, make);

/** For code that opens Claude sessions where no project hooks are in play, as in tests. */
export const layerNoProjectHooks = Layer.mock(ClaudeProjectHooks)({
  forSession: () => Effect.succeed(null),
});
