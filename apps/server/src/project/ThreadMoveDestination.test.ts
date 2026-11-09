import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveError,
  type ThreadMoveInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  member,
  moved,
  namedProject,
  namedThread,
  needsProject,
  refusal,
} from "./ThreadMove.testkit.ts";
import {
  collectMoveSet,
  decideThreadMove,
  type ThreadMoveDecisionInput,
  type ThreadMoveProbes,
  type ThreadMoveProviderInstance,
  type ThreadMoveShell,
} from "./ThreadMoveDestination.ts";

const project = (id: string, workspaceRoot: string, extra?: Partial<Project>): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...extra,
});

const thread = (
  id: string,
  projectId: string,
  worktreePath: string | null,
  extra?: {
    readonly parent?: string;
    readonly kind?: "fork" | "side" | "subagent";
    readonly deleted?: boolean;
  },
): ThreadMoveShell => ({
  id: ThreadId.make(id),
  title: id,
  projectId: ProjectId.make(projectId),
  worktreePath,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  lineage: {
    parentThreadId: extra?.parent === undefined ? null : ThreadId.make(extra.parent),
    relationshipToParent: extra?.kind === "side" ? "fork" : (extra?.kind ?? null),
    rootThreadId: ThreadId.make(extra?.parent ?? id),
    ...(extra?.kind === "side" ? { sideChat: true } : {}),
  },
  deletedAt: extra?.deleted === true ? DateTime.makeUnsafe(0) : null,
});

const sessions = {
  supportsMultipleProviderThreadsPerSession: false,
  supportsModelSwitchInSession: true,
  supportsProviderSwitchingViaHandoff: true,
  supportsRuntimeModeSwitchInSession: false,
  pendingRequestsSurviveRestart: false,
};
const provider = (
  driver: string,
  version: string | null,
  supportsFolderMove: boolean,
  configDir?: string,
): ThreadMoveProviderInstance => ({
  driver: ProviderDriverKind.make(driver),
  capabilities: { sessions: { ...sessions, supportsFolderMove } },
  version,
  environment: configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
});
const claude = (version: string | null, configDir?: string) =>
  provider("claudeAgent", version, true, configDir);
const instances = (
  ...entries: ReadonlyArray<readonly [string, ThreadMoveProviderInstance]>
): ReadonlyMap<ProviderInstanceId, ThreadMoveProviderInstance> =>
  new Map(entries.map(([id, entry]) => [ProviderInstanceId.make(id), entry]));
const claudeAt = (version: string | null, configDir?: string) => ({
  providerInstances: instances(["claudeAgent", claude(version, configDir)]),
});

const makeWorld = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-move-" }),
  );
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments);
  for (const folder of [
    "projA/nested projB dup archived deleted scratch/thread scratch/other scratch/promoted",
    "worktree/sub worktree/proot jjws/.jj jjws/sub jjdefault/.jj/repo jjdefault/sub",
    "main/.git/worktrees/wt main/.git/modules/worktrees/lib main/worktrees/lib srv/worktrees/main",
    "separate locked-git locked-jj/.jj locked-root locked-parent/child managed/repo/branch/sub plain W PW",
  ].flatMap((group) => group.split(" "))) {
    yield* fileSystem.makeDirectory(at(folder), { recursive: true });
  }
  yield* fileSystem.writeFileString(at("worktree", ".git"), "gitdir: ../main/.git/worktrees/wt\n");
  yield* fileSystem.writeFileString(at("main", ".git", "worktrees", "wt", "commondir"), "../..\n");
  yield* fileSystem.writeFileString(
    at("main", "worktrees", "lib", ".git"),
    "gitdir: ../../.git/modules/worktrees/lib\n",
  );
  yield* fileSystem.writeFileString(
    at("separate", ".git"),
    `gitdir: ${at("srv", "worktrees", "main")}\n`,
  );
  yield* fileSystem.writeFileString(at("jjws", ".jj", "repo"), "/elsewhere/.jj/repo\n");
  yield* fileSystem.writeFileString(at("locked-git", ".git"), "");
  yield* fileSystem.chmod(at("locked-git", ".git"), 0o000);
  yield* fileSystem.chmod(at("locked-jj", ".jj"), 0o000);
  yield* fileSystem.chmod(at("locked-root"), 0o000);
  yield* fileSystem.chmod(at("locked-parent"), 0o000);
  // The temp folder removal needs to list locked-parent, so unlock it first.
  yield* Effect.addFinalizer(() => Effect.ignore(fileSystem.chmod(at("locked-parent"), 0o700)));
  yield* fileSystem.writeFileString(at("afile"), "");
  yield* fileSystem.symlink(at("projB"), at("link-B"));
  yield* fileSystem.symlink(at("W"), at("link-W"));
  yield* fileSystem.symlink(at("scratch"), at("link-scratch"));
  const projects = [
    project("A", at("projA")),
    project("B", at("link-B")),
    project("No project", at("scratch")),
    project("Promoted", at("scratch", "promoted")),
    project("Archived", at("archived"), { archivedAt: "2026-01-02T00:00:00.000Z" }),
    project("Deleted", at("deleted"), { deletedAt: "2026-01-02T00:00:00.000Z" }),
    project("Dup1", at("dup")),
    project("Dup2", at("dup")),
    project("InWorktree", at("worktree", "proot")),
    project("P", at("PW")),
    project("Locked", at("locked-root")),
  ];
  const threads = [
    thread("t1", "A", null),
    thread("t1-side", "A", null, { parent: "t1", kind: "side" }),
    thread("t1-sub", "A", null, { parent: "t1", kind: "subagent" }),
    thread("t1-fork", "A", null, { parent: "t1", kind: "fork" }),
    thread("t1-side-sub", "A", null, { parent: "t1-side", kind: "subagent" }),
    thread("t2", "A", at("W")),
    thread("t2-side", "A", at("W"), { parent: "t2", kind: "side" }),
    thread("t2-fork", "A", at("W"), { parent: "t2", kind: "fork" }),
    thread("picker", "B", at("W")),
    thread("linked", "B", at("link-W")),
    thread("gone", "B", at("W"), { deleted: true }),
    thread("t3", "A", at("PW")),
    thread("p-root", "P", null),
    thread("tn", "No project", at("scratch", "thread")),
  ];
  return { root, at, projects, threads };
});
type World = Effect.Success<typeof makeWorld>;
type Options = Partial<ThreadMoveDecisionInput> & {
  readonly probes?: Partial<Pick<ThreadMoveProbes, "threadRecords" | "hasBackgroundWork">>;
};
type Setup = Options | ((world: World) => Options);
type Records = Effect.Success<ReturnType<ThreadMoveProbes["threadRecords"]>>;
type Flags = Pick<ThreadMoveInput, "addProject" | "confirm">;

const request = (threadId: string, destination: string | null, flags?: Flags) => ({
  threadId: ThreadId.make(threadId),
  destination,
  ...flags,
});

const idle = { runs: [], runtimeRequests: [] };
const running = { runs: [{ status: "running" }], runtimeRequests: [] };
const pending = { runs: [], runtimeRequests: [{ status: "pending" }] };
const busy = Effect.succeed(true);
const probeFailed = Effect.fail(new ThreadMoveError({ message: "probe failed" }));

const decide = (world: World, input: ThreadMoveInput, setup: Setup = {}) =>
  Effect.gen(function* () {
    const { probes, ...overrides } = typeof setup === "function" ? setup(world) : setup;
    return yield* decideThreadMove(
      {
        request: input,
        threads: world.threads,
        projects: world.projects,
        providerInstances: instances(
          ["claudeAgent", claude("2.1.223")],
          ["codex", provider("codex", "1.0.0", true)],
          ["cursor", provider("cursor", "1.0.0", false)],
        ),
        settings: { providerInstances: {}, projectSettingsOverrides: {} },
        scratchRoot: world.at("scratch"),
        managedWorktreeDirectories: [world.at("managed")],
        home: world.root,
        ...overrides,
      },
      {
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        threadRecords: () => Effect.succeed(idle),
        hasBackgroundWork: () => Effect.succeed(false),
        ...probes,
      },
    );
  });

const onlyFor =
  <A>(threadId: string, value: Effect.Effect<A, ThreadMoveError>, otherwise: A) =>
  (id: ThreadId) =>
    id === threadId ? value : Effect.succeed(otherwise);
const records = (threadId: string, value: Records) => ({
  probes: { threadRecords: onlyFor(threadId, Effect.succeed(value), idle) },
});
const background = (threadId: string, value: Effect.Effect<boolean, ThreadMoveError>) => ({
  probes: { hasBackgroundWork: onlyFor(threadId, value, false) },
});
const patch = (world: World, threadId: string, fields: Partial<ThreadMoveShell>) => ({
  threads: world.threads.map((shell) => (shell.id === threadId ? { ...shell, ...fields } : shell)),
});

const named = (...ids: ReadonlyArray<string>) => ({ projects: ids.map(namedProject) });
const worktree = refusal("inside a worktree");
const movesTo = (projectId: string, tag = "project") => ({
  _tag: "move",
  destination: { _tag: tag, project: expect.objectContaining({ id: projectId }) },
  leaving: null,
});
const failure = (target: string) => ({
  _tag: "ThreadMoveError",
  message: expect.stringContaining(target),
});

it.layer(NodeServices.layer)("decideThreadMove", (it) => {
  it.effect.each<
    readonly [string, string | (() => string), object | ((folder: string) => object), string?]
  >([
    ["rule 1: own folder moves with no members", "projA", moved],
    ["rule 1: own worktree changes nothing, asks nothing", "W", moved, "t2"],
    ["rule 1: own folder rooting project P", "PW", refusal("no folder change", named("P")), "t3"],
    ["rule 2: the scratch root points to /no", "scratch", refusal("/no")],
    ["rule 3: a project root", "projB", movesTo("B")],
    ["rule 3: a relative path starts at the thread's folder", () => "../projB", movesTo("B")],
    ["rule 3: ~ expands to the home folder", () => "~/projB", movesTo("B")],
    ["rule 3: a symlink spelling of the root", "link-B", movesTo("B")],
    ["rule 3: a promoted project", "scratch/promoted", movesTo("Promoted")],
    ["rule 3: a root inside a worktree", "worktree/proot", movesTo("InWorktree")],
    ["rule 3: two matches are named", "dup", refusal('"Dup1", "Dup2"', named("Dup1", "Dup2"))],
    ["rule 3: archived match", "archived", refusal("Unarchive", named("Archived"))],
    ["rule 3: an unreadable root is refused", "locked-root", refusal(/^Cannot read `.*`\.$/)],
    ["rule 4: scratch folder, /no only", "scratch/other", refusal(/^(?!.*Turn into project)/)],
    ["rule 4: from No project, Turn into too", "scratch/other", refusal("Turn into project"), "tn"],
    ["rule 5: a folder in a linked git worktree", "worktree/sub", worktree],
    ["rule 5: the linked worktree itself", "worktree", worktree],
    ["rule 5: a folder in a jj workspace", "jjws/sub", worktree],
    ["rule 5: a folder in a default jj workspace", "jjdefault/sub", worktree],
    ["rule 5: the managed worktrees directory itself", "managed", worktree],
    ["rule 5: under a managed worktrees directory", "managed/repo/branch/sub", worktree],
    ["rule 5: unreadable .git fails, naming it", "locked-git", (f) => failure(`${f}/.git`)],
    ["rule 5: unreadable .jj/repo fails, named", "locked-jj", (f) => failure(`${f}/.jj/repo`)],
    ["rule 6: a folder with no project needs one", "plain", needsProject],
    ["rule 6: a subfolder of A names A", "projA/nested", (folder) => needsProject(folder, "A")],
    ["rule 6: a submodule under worktrees/ needs one", "main/worktrees/lib", needsProject],
    ["rule 6: a checkout whose git dir is under worktrees/", "separate", needsProject],
    ["rule 6: a deleted project's root needs a project", "deleted", needsProject],
    ["a missing folder is refused", "missing", refusal(/^No folder at `.*missing`\.$/)],
    [
      "a folder under an unreadable parent is refused, not reported missing",
      "locked-parent/child",
      refusal(/^Cannot read `.*locked-parent\/child`\.$/),
    ],
    ["a file is refused", "afile", refusal("No folder at `")],
  ])("/cd %s", ([, typed, expected, threadId = "t1"]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const folder = typeof typed === "string" ? world.at(typed) : typed();
      const result = yield* Effect.catch(decide(world, request(threadId, folder)), Effect.succeed);
      expect(result).toMatchObject(typeof expected === "function" ? expected(folder) : expected);
    }),
  );

  it.effect("a project root that fails to resolve fails the decision", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const error = yield* decide(world, request("t1", world.at("plain")), {
        projects: [...world.projects, project("Unresolved", world.at("afile", "root"))],
      }).pipe(Effect.flip);
      expect(error).toMatchObject(failure(world.at("afile", "root")));
    }),
  );

  const competingScratch = (world: World) => ({
    projects: [...world.projects, project("No project 2", world.at("link-scratch"))],
  });
  const scratchTwins = named("No project", "No project 2");

  it.effect.each<readonly [string, string, Setup, object]>([
    ["refuses a No project thread", "tn", competingScratch, refusal("already in No project")],
    ["refuses without scratch folders", "t1", { scratchRoot: undefined }, refusal("unavailable")],
    ["names both scratch projects", "t1", competingScratch, refusal(undefined, scratchTwins)],
    [
      "asks to unarchive an archived No project",
      "t1",
      (world) => ({ scratchRoot: world.at("archived") }),
      refusal("Unarchive", named("Archived")),
    ],
    ["moves a root thread at once", "t1", {}, movesTo("No project", "scratch")],
    ["asks leaving a worktree", "t2", {}, { _tag: "confirm", to: null, wayBack: "add-project" }],
  ])("/no %s", ([, threadId, setup, expected]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      expect(yield* decide(world, request(threadId, null), setup)).toMatchObject(expected);
    }),
  );

  it.effect.each([
    ["t1-side", "side chat"],
    ["t1-sub", "subagent"],
  ] as const)("refuses a %s as the target and names its parent", ([threadId, kind]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request(threadId, world.at("projB")));
      expect(result).toMatchObject(member("t1", kind));
    }),
  );

  it.effect("the move set holds members at any depth and stops at a listed fork", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const members = collectMoveSet(ThreadId.make("t1"), world.threads).map(({ id }) => id);
      expect(members.toSorted()).toEqual(["t1", "t1-side", "t1-side-sub", "t1-sub"]);
      const result = yield* decide(world, request("t1", world.at("projB")));
      expect(result._tag === "move" ? result.members.map(({ id }) => id) : []).toEqual(members);
    }),
  );

  type EligibilityCase = readonly [string, Setup, object];

  it.effect.each<EligibilityCase>([
    [
      "a running turn",
      records("t1-sub", running),
      member("t1-sub", /^"t1-sub" is still working\. Try again when the turn ends\.$/),
    ],
    [
      "the thread's own running turn, without its title",
      records("t1", running),
      member("t1", /^This thread is still working\. Try again when the turn ends\.$/),
    ],
    ["a pending request", records("t1-side", pending), member("t1-side")],
    ["background work", background("t1-side", busy), member("t1-side", "background work")],
    ["a failing probe", background("t1-side", probeFailed), member("t1-side", "background work")],
    [
      "another folder",
      (world) => patch(world, "t1-sub", { worktreePath: world.at("W") }),
      member("t1-sub", "another folder"),
    ],
    [
      "a driver without supportsFolderMove",
      (world) => patch(world, "t1-sub", { providerInstanceId: ProviderInstanceId.make("cursor") }),
      member("t1-sub", "does not support a folder move"),
    ],
    [
      "a provider instance the destination project disables",
      {
        settings: {
          providerInstances: {},
          projectSettingsOverrides: {
            [ProjectId.make("B")]: {
              providerInstances: { [ProviderInstanceId.make("claudeAgent")]: { enabled: false } },
            },
          },
        },
      },
      member("t1", "disables"),
    ],
    ...["", "  ", " /config", ".claude-config"].map((configDir): EligibilityCase => [
      `CLAUDE_CONFIG_DIR ${JSON.stringify(configDir)}`,
      claudeAt("2.1.223", configDir),
      member("t1", `CLAUDE_CONFIG_DIR ("${configDir}") is not an absolute path`),
    ]),
    ["nothing when CLAUDE_CONFIG_DIR is absolute", claudeAt("2.1.223", "/config"), movesTo("B")],
    [
      "Claude Code 2.1.222, naming it",
      claudeAt("2.1.222"),
      member("t1", /2\.1\.222.*Refresh the providers/),
    ],
    ["nothing for a newer Claude Code", claudeAt("2.2.0"), movesTo("B")],
    ["an unparsed Claude version", claudeAt("garbage"), member("t1", "Claude Code garbage")],
    ["no Claude version", claudeAt(null), member("t1", "unknown version")],
    [
      "the member on the older of two Claude instances",
      (world) => ({
        ...patch(world, "t1-side", { providerInstanceId: ProviderInstanceId.make("claude-two") }),
        providerInstances: instances(
          ["claudeAgent", claude("2.1.223")],
          ["claude-two", claude("2.1.222")],
        ),
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("claude-two")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
            },
          },
          projectSettingsOverrides: {},
        },
      }),
      member("t1-side", "2.1.222"),
    ],
    [
      "nothing for a Codex member",
      (world) => patch(world, "t1-sub", { providerInstanceId: ProviderInstanceId.make("codex") }),
      movesTo("B"),
    ],
  ])("eligibility refuses %s", ([, setup, expected]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      expect(yield* decide(world, request("t1", world.at("projB")), setup)).toMatchObject(expected);
    }),
  );

  it.effect.each<readonly [string, string, (at: World["at"]) => object, string?]>([
    [
      "leaving a worktree names the threads that stay in it, not the side chat that moves",
      "t2",
      (at) => ({
        _tag: "confirm",
        from: at("W"),
        to: at("link-B"),
        staysOnDisk: `The folder ${at("W")} stays on disk with all its files until you remove it.`,
        wayBack: "add-project",
        otherThreads: ["t2-fork", "picker", "linked"].map(namedThread),
      }),
    ],
    [
      "leaving a project's root worktree names the project, and /cd brings it back",
      "t3",
      (at) => ({
        _tag: "confirm",
        from: at("PW"),
        wayBack: "cd",
        project: namedProject("P"),
        otherThreads: [],
      }),
    ],
    [
      "leaving a scratch folder has no way back",
      "tn",
      (at) => ({ _tag: "confirm", from: at("scratch/thread"), wayBack: "none", otherThreads: [] }),
    ],
    [
      "a removed folder no longer exists",
      "t2",
      () => ({
        _tag: "confirm",
        staysOnDisk: "The folder no longer exists.",
        otherThreads: ["t2-fork", "picker"].map(namedThread),
      }),
      "W",
    ],
  ])("confirm: %s", ([, threadId, expected, removed]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fileSystem = yield* FileSystem.FileSystem;
      if (removed) yield* fileSystem.remove(world.at(removed), { recursive: true });
      const input = request(threadId, world.at("projB"));
      const result = yield* decide(world, input);
      expect(result).toMatchObject(expected(world.at));
      const { _tag, ...leaving } = result as Extract<typeof result, { _tag: "confirm" }>;
      const confirmed = yield* decide(world, { ...input, confirm: true });
      expect(confirmed).toEqual(expect.objectContaining({ _tag: "move", leaving }));
    }),
  );

  it.effect.each<readonly [string, Flags, Setup, (at: World["at"]) => object]>([
    ["asks for the project before the confirmation", {}, {}, (at) => needsProject(at("plain"))],
    [
      "asks for the confirmation once the project question is answered",
      { addProject: true },
      {},
      (at) => ({ _tag: "confirm", from: at("W"), to: at("plain") }),
    ],
    [
      "moves to a new project with both answers",
      { addProject: true, confirm: true },
      {},
      (at) => ({ _tag: "move", destination: { _tag: "new-project", folder: at("plain") } }),
    ],
    ["refuses a busy member first", {}, records("t2-side", running), () => member("t2-side")],
  ])("from a worktree to a folder with no project, %s", ([, flags, setup, expected]) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request("t2", world.at("plain"), flags), setup);
      expect(result).toMatchObject(expected(world.at));
    }),
  );
});
