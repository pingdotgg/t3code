// `test` for web scenarios: e2e's web test plus `t3`, which seeds state and opens the signed-in
// app. `t3-mobile.ts` is the same for the iOS app.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { test as base } from "@e2e-dev/web";
import { CommandId, EnvironmentHttpApi, type ProjectMutation, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run, ScenarioError } from "./shell.ts";

export interface T3State {
  /** Creates a git repository holding `files` and adds it as a project. Returns its path. */
  readonly project: (title: string, files?: Readonly<Record<string, string>>) => Promise<string>;
  /**
   * Starts a thread in a project and plays one replayed turn per message before returning.
   * `model` is a dev replay recording: showcase, todo-list, approval, question, multi-turn.
   */
  readonly thread: (input: {
    readonly project: string;
    readonly title: string;
    readonly messages: ReadonlyArray<string>;
    readonly model?: string;
  }) => Promise<void>;
}

export interface T3 extends T3State {
  /** Opens the app, signed in, at `path`. */
  readonly open: (path?: string) => Promise<void>;
}

/** e2e's fixtures are promise functions; this is the one place an Effect becomes a promise. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

const decodeRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
);

type ServerApi = {
  readonly client: HttpApiClient.ForApi<typeof EnvironmentHttpApi>;
  readonly headers: { readonly authorization: string };
};

/**
 * One API client per T3 home, signed in once per run. Each CLI call starts a process that takes
 * about 0.7 s before it does anything, so per-test state goes through the server's HTTP API.
 */
const serverApis = new Map<string, Promise<ServerApi>>();

const uuid = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.uuidV4()),
  Effect.provide(NodeCrypto.layer),
);

/** State for the server on `home`, made through the app's own CLI and API: real events, not inserted rows. */
export function makeState(home: string, env: NodeJS.ProcessEnv = {}) {
  const cli = Effect.fn("scenario.cli")(function* (
    args: ReadonlyArray<string>,
    allowExit: ReadonlyArray<number> = [0],
  ) {
    const hostEnvironment = yield* HostProcess.Environment;
    return yield* run(
      yield* HostProcess.ExecutablePath,
      ["apps/server/src/bin.ts", ...args, "--base-dir", home],
      {
        cwd: APP_DIR,
        env: { PATH: hostEnvironment.PATH, HOME: hostEnvironment.HOME, ...env },
        allowExit,
      },
    );
  });

  // The server writes its origin beside its database once it listens.
  const connect = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { origin } = yield* decodeRuntimeState(
      yield* fs.readFileString(path.join(home, "userdata", "server-runtime.json")),
    );
    const issued = yield* cli(["auth", "session", "issue", "--token-only", "--label", "scenario"]);
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    return { client, headers: { authorization: `Bearer ${issued.stdout.trim()}` } };
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const api = Effect.tryPromise({
    try: () => {
      const known = serverApis.get(home);
      if (known !== undefined) return known;
      const connecting = runPromise(connect);
      serverApis.set(home, connecting);
      // A failed sign-in is not kept: the next test tries again.
      connecting.catch(() => serverApis.delete(home));
      return connecting;
    },
    catch: (cause) => new ScenarioError({ message: `Could not reach the server API: ${cause}` }),
  });
  const mutate = Effect.fn("scenario.mutate")(function* (mutation: ProjectMutation) {
    const { client, headers } = yield* api;
    return yield* client.projects
      .mutate({ headers, payload: mutation })
      .pipe(
        Effect.mapError((cause) => new ScenarioError({ message: `${mutation.type}: ${cause}` })),
      );
  });
  const projects: Array<ProjectId> = [];

  const project = Effect.fn("scenario.project")(function* (
    title: string,
    files: Readonly<Record<string, string>>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Its own folder per test: the server and this home outlive one test.
    yield* fs.makeDirectory(path.join(home, "workspaces"), { recursive: true });
    const parent = yield* fs.makeTempDirectory({
      directory: path.join(home, "workspaces"),
      prefix: "w-",
    });
    const workspace = path.join(parent, title);
    for (const [file, content] of Object.entries({ "README.md": "", ...files })) {
      yield* fs.makeDirectory(path.dirname(path.join(workspace, file)), { recursive: true });
      yield* fs.writeFileString(path.join(workspace, file), content);
    }
    const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: workspace });
    const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];
    yield* git(["init", "--quiet", "--initial-branch=main"]);
    yield* git(["add", "--all"]);
    yield* git([...author, "commit", "--quiet", "--message", "Initial commit"]);
    const created = yield* mutate({
      type: "project.create",
      commandId: CommandId.make(yield* uuid),
      projectId: ProjectId.make(yield* uuid),
      title,
      workspaceRoot: workspace,
    });
    projects.push(created.id);
    return workspace;
  });

  const thread = Effect.fn("scenario.thread")(function* (input: {
    readonly project: string;
    readonly title: string;
    readonly messages: ReadonlyArray<string>;
    readonly model?: string;
  }) {
    // Exit code 2 means the turn waits for an answer, which a scenario may want to start from.
    const turn = (args: ReadonlyArray<string>) =>
      cli(["thread", ...args, "--wait", "--json"], [0, 2]);
    const [first = "Start", ...rest] = input.messages;
    const replay = ["--provider", "devReplay", "--model", input.model ?? "multi-turn"];
    const started = yield* turn(["start", input.project, first, "--title", input.title, ...replay]);
    const { threadId } = yield* decodeLaunched(started.stdout);
    for (const message of rest) yield* turn(["send", threadId, message]);
  });

  return {
    cli,
    state: {
      project: (title, files = {}) => runPromise(project(title, files)),
      thread: (input) => runPromise(thread(input)),
    } satisfies T3State,
    // The server outlives the test, so the next one must not see this one's projects.
    cleanup: Effect.forEach(
      projects,
      (projectId) =>
        Effect.flatMap(uuid, (commandId) =>
          mutate({
            type: "project.delete",
            commandId: CommandId.make(commandId),
            projectId,
            force: true,
          }),
        ),
      { discard: true },
    ),
  };
}

const readPairingPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(T3_HOME, "pairing-path"));
});

export const test = base.extend<{ t3: T3 }>({
  t3: async ({ app }, use) => {
    const { state, cleanup } = makeState(T3_HOME);
    await use({
      ...state,
      open: async (path = "/") => {
        await app.open(await runPromise(readPairingPath));
        if (path !== "/") await app.open(path);
      },
    });
    await runPromise(cleanup);
  },
});

/** Test option for a web scenario: the iOS target skips it. */
export const WEB = { platforms: ["web"] } as const;
