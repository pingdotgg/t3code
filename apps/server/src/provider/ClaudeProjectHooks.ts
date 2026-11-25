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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";

/** What a session that leaves the folder's hooks out is told to read instead of the folder. */
export interface ClaudeSessionWithoutProjectHooks {
  /**
   * Claude Code's `projectConfigRoot`: a folder T3 Code wrote that holds the folder's Claude Code
   * settings without their `hooks`, and links to everything else in its `.claude`.
   */
  readonly projectConfigRoot: string;
  /** The line the thread shows for it. */
  readonly notice: string;
}

/**
 * Whether a Claude session runs the hooks its folder's `.claude/settings.json` and
 * `.claude/settings.local.json` declare: only once a person approved exactly these for the project,
 * or in a thread in Full access. Read side only; `ClaudeProjectHookApprovalWrites` records one.
 */
export class ClaudeProjectHooks extends Context.Service<
  ClaudeProjectHooks,
  {
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
    }) => Effect.Effect<WorkspaceClaudeProjectHooksResult, ClaudeProjectHooksError>;
    /**
     * For a session about to open in `cwd`. Null opens it on the folder as it is: it declares no
     * hooks, or they may run. `fullAccess` is whether the thread is in Full access now.
     */
    readonly forSession: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
      readonly fullAccess: boolean;
    }) => Effect.Effect<ClaudeSessionWithoutProjectHooks | null, ClaudeProjectHooksError>;
  }
>()("t3/provider/ClaudeProjectHooks") {}

export const failed = (detail: string) => (cause: unknown) =>
  new ClaudeProjectHooksError({ detail, cause });

const NEEDS_APPROVAL_NOTICE =
  "This project's Claude Code hooks are not approved, so this session runs without them. Review and approve them in this thread or in the project's settings; they run from the next session on.";

type Settings = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Settings =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Key order is not part of what a person approved. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

const hookDetail = (hook: unknown) => {
  if (isRecord(hook)) {
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
  if (!isRecord(hooks)) return [{ source, event: "", detail: encodeJson(hooks) }];
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : [groups]).flatMap(
      (group): ReadonlyArray<ClaudeProjectHook> => {
        if (!isRecord(group) || !Array.isArray(group.hooks)) {
          return [{ source, event, detail: encodeJson(group) }];
        }
        const matcher =
          typeof group.matcher === "string" && group.matcher.length > 0
            ? { matcher: group.matcher }
            : {};
        return group.hooks.map((hook) => ({ source, event, ...matcher, detail: hookDetail(hook) }));
      },
    ),
  );
};

const withoutHooks = ({ hooks: _hooks, ...rest }: Settings): Settings => rest;

/** Claude Code's merge of two settings files: lists join, objects merge, the later value wins. */
const mergeSettings = (lower: unknown, higher: unknown): unknown => {
  if (Array.isArray(lower) && Array.isArray(higher)) {
    const seen = new Set(lower.map((item) => encodeJson(item)));
    return [...lower, ...higher.filter((item) => !seen.has(encodeJson(item)))];
  }
  if (isRecord(lower) && isRecord(higher)) {
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const offBy = ManagedPolicy.deniedBy(managedPolicy, "claudeProjectHooks");

  const sha256 = (value: unknown) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(encodeJson(canonical(value))))
      .pipe(Effect.map(Hex.encode), Effect.mapError(failed("Could not hash the project's hooks.")));

  const findApproval = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, hooksHash: Schema.String }),
    Result: Schema.Struct({ hooksHash: Schema.String }),
    execute: ({ projectId, hooksHash }) => sql`
      SELECT hooks_hash AS "hooksHash" FROM claude_project_hook_approvals
      WHERE project_id = ${projectId} AND hooks_hash = ${hooksHash}
    `,
  });

  // A file Claude Code cannot read as settings gives it no hooks either, so it counts as absent.
  const readSettings = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => decodeSettings(text)),
      Effect.map((decoded) =>
        decoded._tag === "Some" && isRecord(decoded.value) ? decoded.value : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  /** The settings files Claude Code reads for a session in `cwd`, lowest precedence first. */
  const readFolder = Effect.fn("ClaudeProjectHooks.readFolder")(function* (cwd: string) {
    const localDirectory = yield* claudeLocalSettingsDirectory(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const project = yield* readSettings(path.join(cwd, ".claude", SETTINGS_FILE));
    // In a worktree Claude Code reads the main checkout's local file, and one left in cwd under it.
    const locals = (yield* Effect.forEach(
      [...(localDirectory === cwd ? [] : [cwd]), localDirectory],
      (directory) => readSettings(path.join(directory, ".claude", LOCAL_SETTINGS_FILE)),
    )).filter((settings) => settings !== undefined);
    const hooks = [
      ...listHooks("project", project?.hooks),
      ...locals.flatMap((settings) => listHooks("local", settings.hooks)),
    ];
    const hooksHash = yield* sha256([
      project?.hooks ?? null,
      locals.map((settings) => settings.hooks ?? null),
    ]);
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

  /**
   * Writes the folder Claude Code reads project configuration from in place of `cwd`. Named by
   * what it holds, so sessions that agree share one and none sees another's half-written files.
   */
  const writeConfigRoot = Effect.fn("ClaudeProjectHooks.writeConfigRoot")(
    function* (cwd: string, folder: Effect.Success<ReturnType<typeof readFolder>>) {
      const claudeDirectory = path.join(cwd, ".claude");
      const entries = (yield* fileSystem
        .readDirectory(claudeDirectory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry !== SETTINGS_FILE && entry !== LOCAL_SETTINGS_FILE)
        .toSorted();
      const mcpConfig = path.join(cwd, ".mcp.json");
      const hasMcpConfig = yield* fileSystem
        .exists(mcpConfig)
        .pipe(Effect.orElseSucceed(() => false));
      const files = [
        ...(folder.project === undefined
          ? []
          : [[SETTINGS_FILE, encodeJson(withoutHooks(folder.project))] as const]),
        ...(folder.locals.length === 0
          ? []
          : [
              [
                LOCAL_SETTINGS_FILE,
                encodeJson(folder.locals.map(withoutHooks).reduce<unknown>(mergeSettings, {})),
              ] as const,
            ]),
      ];
      const parent = path.join(stateDir, "claude-project-config");
      const root = path.join(
        parent,
        (yield* sha256([cwd, files, entries, hasMcpConfig])).slice(0, 32),
      );
      if (yield* fileSystem.exists(root)) return root;
      yield* fileSystem.makeDirectory(parent, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectory({
        directory: parent,
        prefix: "staging-",
      });
      // Where links are not allowed, as on Windows without developer mode, a copy stands in.
      const link = (from: string, to: string) =>
        fileSystem
          .symlink(from, to)
          .pipe(Effect.catch(() => fileSystem.copy(from, to, { overwrite: true })));
      yield* fileSystem.makeDirectory(path.join(staging, ".claude"));
      yield* Effect.forEach(
        files,
        ([name, text]) => fileSystem.writeFileString(path.join(staging, ".claude", name), text),
        { discard: true },
      );
      yield* Effect.forEach(
        entries,
        (entry) => link(path.join(claudeDirectory, entry), path.join(staging, ".claude", entry)),
        { discard: true },
      );
      if (hasMcpConfig) yield* link(mcpConfig, path.join(staging, ".mcp.json"));
      // Another session may have put the same folder in place meanwhile.
      yield* fileSystem
        .rename(staging, root)
        .pipe(Effect.catch(() => fileSystem.remove(staging, { recursive: true, force: true })));
      return root;
    },
    Effect.mapError(failed("Could not prepare the project's Claude Code settings without hooks.")),
  );

  return ClaudeProjectHooks.of({
    read: Effect.fn("ClaudeProjectHooks.read")(function* ({ projectId, cwd }) {
      const folder = yield* readFolder(cwd);
      return {
        status: yield* statusOf(projectId, folder),
        hooks: folder.hooks,
        hooksHash: folder.hooksHash,
      };
    }),
    forSession: Effect.fn("ClaudeProjectHooks.forSession")(function* ({
      projectId,
      cwd,
      fullAccess,
    }) {
      const folder = yield* readFolder(cwd);
      const status = yield* statusOf(projectId, folder);
      if (status === "none" || status === "approved") return null;
      if (status === "needs-approval" && fullAccess) return null;
      return {
        projectConfigRoot: yield* writeConfigRoot(cwd, folder),
        notice:
          offBy === undefined
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
