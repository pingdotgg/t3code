import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import { extractMcpToolCallIdentity } from "@t3tools/provider-acp/server/runtimeModel";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAntigravityAcpAdapterFlavor } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { antigravitySessionMeta } from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  antigravityRuntimeState,
  makeAntigravityRuntimeUsageProbe,
  profileAntigravityRuntimeState,
  withUserAgyState,
} from "./antigravityCliRuntime.ts";
import {
  type AntigravityTextGenerationOptions,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";

const baseOptions = {
  instanceId: ProviderInstanceId.make("antigravity-cli-test"),
  profileDirectory: "antigravity-profile-unused",
  digest: undefined as never,
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
} satisfies Parameters<typeof makeAntigravityAcpAdapterFlavor>[0];

// Where `agy acp` keeps its sessions and login: under the user's home, whatever GEMINI_HOME says.
const cliRuntimeState = (path: Path.Path, userHome: string) =>
  Effect.succeed({
    runtime: "cli" as const,
    root: path.join(userHome, ".gemini"),
    appFolder: "antigravity-cli",
    tokenFile: "antigravity-oauth-token",
  });

const ERROR_MESSAGE = 17;
// An error step trimmed from `agy acp` 1.5.5: length-prefixed fields, so a length byte leads the status.
const CLI_API_ERROR = Buffer.concat([
  Buffer.from([0x1a, 0xde, 0x07, 0x0a, 0x28]),
  Buffer.from("Agent execution terminated due to error."),
  Buffer.from([0x12, 0x4f]),
  Buffer.from("FAILED_PRECONDITION (code 400): User location is not supported for the API use."),
  Buffer.from([0x1a, 0x2c]),
  Buffer.from('HTTP 400 Bad Request\n{\n  "error": {\n    "code": 400\n  }\n}'),
]);

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

type TextRuntime = Effect.Success<ReturnType<AntigravityTextGenerationOptions["makeRuntime"]>>;

const protobufField = (number: number, value: Uint8Array) =>
  Buffer.concat([
    Buffer.from([
      (number << 3) | 2,
      ...(value.length < 128 ? [value.length] : [(value.length & 0x7f) | 0x80, value.length >> 7]),
    ]),
    value,
  ]);
const fileUri = (folder: string) => Buffer.from(NodeURL.pathToFileURL(folder).href);

/**
 * One session as `agy acp` stores it: notes, an annotation, and a log whose metadata names the
 * workspace in field 1 of field 1. `alsoNamed` is a folder that an unrelated field names.
 */
const writeCliSession = Effect.fn("writeCliSession")(function* (
  { fileSystem, path }: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
  appDirectory: string,
  sessionId: string,
  workspace: string,
  alsoNamed?: string,
) {
  const base = path.join(appDirectory, "conversations", sessionId);
  for (const directory of ["conversations", "annotations", path.join("brain", sessionId)]) {
    yield* fileSystem.makeDirectory(path.join(appDirectory, directory), { recursive: true });
  }
  yield* fileSystem.remove(`${base}.db`, { force: true });
  const database = new NodeSqlite.DatabaseSync(`${base}.db`);
  try {
    database.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
    database
      .prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)")
      .run(
        Buffer.concat([
          protobufField(
            1,
            Buffer.concat([protobufField(1, fileUri(workspace)), protobufField(3, Buffer.of())]),
          ),
          protobufField(6, Buffer.from(sessionId)),
          ...(alsoNamed === undefined
            ? []
            : [protobufField(9, protobufField(1, fileUri(alsoNamed)))]),
        ]),
      );
  } finally {
    database.close();
  }
  const files = [
    `${base}.db`,
    `${base}.db-wal`,
    `${base}.db-shm`,
    path.join(appDirectory, "annotations", `${sessionId}.pbtxt`),
    path.join(appDirectory, "brain", sessionId, "notes.md"),
  ];
  for (const file of files.slice(1)) yield* fileSystem.writeFileString(file, "session data");
  return files;
});

const HELPER_SESSION = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
const USER_SESSION = "9b2e4c51-7a0d-4f3e-8c66-2d1f5a7e9b30";

/** Runs one title helper on the CLI runtime; its fake agent stores two sessions as it starts. */
const cliHelperTurn = Effect.fn("cliHelperTurn")(function* (
  userHome: string,
  reportedSession: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appDirectory = path.join(userHome, ".gemini", "antigravity-cli");
  let sessionUpdate: Parameters<TextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;
  let helperFiles: ReadonlyArray<string> = [];
  let userFiles: ReadonlyArray<string> = [];
  const handled = () => Effect.void;
  const services = { fileSystem, path };
  const options = {
    profileDirectory: path.join(userHome, "profile-unused"),
    runtimeState: cliRuntimeState(path, userHome),
    withProcess: ((_stop, task) => task) as AntigravityTextGenerationOptions["withProcess"],
    makeRuntime: (cwd: string) =>
      Effect.succeed({
        start: () =>
          Effect.gen(function* () {
            helperFiles = yield* writeCliSession(services, appDirectory, HELPER_SESSION, cwd);
            // Another session of the user's: its folder's name starts with the helper's, and
            // an unrelated field of its log names the helper's folder.
            userFiles = yield* writeCliSession(
              services,
              appDirectory,
              USER_SESSION,
              `${cwd}-mine`,
              cwd,
            );
            return {
              sessionId: reportedSession,
              initializeResult: { protocolVersion: 1 },
              sessionSetupResult: { sessionId: reportedSession },
              modelConfigId: "model",
            };
          }).pipe(Effect.orDie),
        setMode: () => Effect.succeed({}),
        getConfigOptions: Effect.succeed([]),
        getEvents: () => Stream.empty,
        setModel: handled,
        setConfigOption: () => Effect.succeed({ configOptions: [] }),
        prompt: () =>
          sessionUpdate({
            sessionId: reportedSession,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"title":"Repair login"}' },
            },
          }).pipe(Effect.as({ stopReason: "end_turn" as const })),
        cancel: Effect.void,
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: handled,
        handleElicitation: handled,
        handleReadTextFile: handled,
        handleWriteTextFile: handled,
        handleCreateTerminal: handled,
        handleTerminalOutput: handled,
        handleTerminalWaitForExit: handled,
        handleTerminalKill: handled,
        handleTerminalRelease: handled,
        handleUnknownExtRequest: handled,
      } satisfies TextRuntime),
  };
  const textGeneration = yield* makeAntigravityTextGeneration(options);
  const result = yield* textGeneration
    .generateThreadTitle({
      cwd: userHome,
      message: "Repair Google login",
      modelSelection: {
        instanceId: baseOptions.instanceId,
        model: ANTIGRAVITY_DEFAULT_MODEL,
      },
    })
    .pipe(Effect.result);
  const left = (files: ReadonlyArray<string>) =>
    Effect.filter(files, (file) => fileSystem.exists(file));
  return {
    result: result._tag,
    helperFiles,
    helperLeft: yield* left(helperFiles),
    userFiles,
    userLeft: yield* left(userFiles),
  };
});

describe("Antigravity CLI runtime", () => {
  it.effect("runs a user's own agy on its own state and a managed release on the profile", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = { profileDirectory: "/profile", userHome: "/home/user", path };
      const profileArgs = ["acp", "--gemini-dir", "/profile", "--app-data-dir", "antigravity-acp"];
      // Upstream marks a Google sign-in as an SSH session, so the CLI keeps it in a file.
      const profileEnv = { GEMINI_HOME: "/profile", SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
      const spawn = { command: "agy", args: profileArgs, cwd: "/project", env: profileEnv };
      for (const [found, managedVersionDirectory, runtime, args, env] of [
        ["the user's own", null, "cli", ["acp"], { GEMINI_HOME: "/profile" }],
        ["a managed release", "/managed/versions/release", "managed", profileArgs, profileEnv],
      ] as const) {
        const executable = { managedVersionDirectory };
        assert.equal(antigravityRuntimeState(executable, input).runtime, runtime, found);
        assert.deepEqual(withUserAgyState(executable, spawn, {}).args, args, found);
        assert.deepEqual(withUserAgyState(executable, spawn, {}).env, env, found);
      }
      const sshEnv = { SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22" };
      assert.deepEqual(
        withUserAgyState({ managedVersionDirectory: null }, spawn, sshEnv).env,
        { GEMINI_HOME: "/profile", ...sshEnv },
        "the user's own SSH session stays",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a CLI turn whose session log ends in an upstream API error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(userHome, ".gemini", "antigravity-cli", "conversations");
      yield* fileSystem.makeDirectory(conversations, { recursive: true });
      const options = { ...baseOptions, runtimeState: cliRuntimeState(path, userHome) };
      const { watchPromptOutcome } = makeAntigravityAcpAdapterFlavor(options);
      assert.isDefined(watchPromptOutcome);

      const check = yield* watchPromptOutcome!(sessionId);
      const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
      try {
        database.exec(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
        );
        database.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(0, ERROR_MESSAGE, CLI_API_ERROR);
      } finally {
        database.close();
      }
      const result: EffectAcpSchema.PromptResponse = { stopReason: "end_turn" };

      assert.deepEqual(yield* check(result), {
        failure: {
          class: "provider_error",
          message: "User location is not supported for the API use.",
          code: "FAILED_PRECONDITION",
          retryable: false,
        },
        threadDisposition: "reusable",
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keys the CLI account by the refresh token in the CLI's own login file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const options = {
        ...baseOptions,
        runtimeState: cliRuntimeState(path, userHome),
        digest: yield* Digest.Digest,
        fileSystem,
        path,
      };
      const { readAccount } = makeAntigravityAcpAdapterFlavor(options);
      assert.isDefined(readAccount);
      const tokenPath = path.join(
        userHome,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
      );
      yield* fileSystem.makeDirectory(path.dirname(tokenPath), { recursive: true });
      const writeLogin = (token: { access_token: string; refresh_token: string }) =>
        fileSystem.writeFileString(
          tokenPath,
          JSON.stringify({
            token: { ...token, token_type: "Bearer", expiry: "2030-01-01T00:00:00Z" },
            auth_method: "oauth",
            id_token_email: "user@example.com",
          }),
        );

      assert.isTrue(Option.isNone(yield* readAccount!), "missing");
      yield* writeLogin({ access_token: "access-1", refresh_token: "refresh-a" });
      const first = yield* readAccount!;
      assert.match(Option.getOrUndefined(first) ?? "none", /^[0-9a-f]{64}$/);
      yield* writeLogin({ access_token: "access-2", refresh_token: "refresh-a" });
      assert.deepEqual(yield* readAccount!, first, "access token refresh");
      yield* writeLogin({ access_token: "access-2", refresh_token: "refresh-b" });
      const second = yield* readAccount!;
      assert.isTrue(Option.isSome(second));
      assert.notDeepEqual(second, first, "another login");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it("knows a T3 MCP call by the title that the CLI sends", () => {
    const { normalizeToolCall } = makeAntigravityAcpAdapterFlavor(baseOptions);
    const identity = (call: { name: string; kind: string; title: string }) =>
      extractMcpToolCallIdentity(
        normalizeToolCall!({
          toolCallId: "call_f8fac04b828143dc92990822",
          kind: call.kind,
          title: call.title,
          status: "completed",
          data: { ...call, rawInput: { text: "Paris", toolSummary: "Answer capital of France" } },
        }),
      );

    for (const tool of ["send_to_user", "replace_send_to_user", "dashboard_get", "dashboard_set"]) {
      const name = `mcp_t3-code_${tool}`;
      assert.deepEqual(
        identity({ name, kind: "other", title: `Run ${name}` }),
        { server: "t3-code", tool },
        tool,
      );
    }
    assert.isUndefined(
      identity({
        name: "mcp_notes_send_to_user",
        kind: "other",
        title: "Run mcp_notes_send_to_user",
      }),
      "another MCP server's tool of the same name",
    );
  });

  it("sends session instructions as a system prompt append when the agent advertises it", () => {
    const initialize = (append: boolean): EffectAcpSchema.InitializeResponse => ({
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.5" },
      agentCapabilities: { _meta: { antigravity: { systemPrompt: { append } } } },
    });
    const { sessionCarriesPullRequestLinking } = makeAntigravityAcpAdapterFlavor(baseOptions);

    assert.deepEqual(antigravitySessionMeta(initialize(true), "<instructions/>"), {
      antigravity: { systemPrompt: { append: "<instructions/>" } },
    });
    assert.isTrue(sessionCarriesPullRequestLinking?.(initialize(true)));
    assert.isUndefined(antigravitySessionMeta(initialize(false), "<instructions/>"));
    assert.isFalse(sessionCarriesPullRequestLinking?.(initialize(false)));
  });

  it.effect("removes the CLI session a helper turn created and no other session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();

      const own = yield* cliHelperTurn(userHome, HELPER_SESSION);
      assert.equal(own.result, "Success");
      assert.deepEqual(own.helperLeft, [], "the helper's own session");
      assert.deepEqual(own.userLeft, own.userFiles, "the user's session beside it");

      const foreign = yield* cliHelperTurn(userHome, USER_SESSION);
      assert.deepEqual(
        foreign.userLeft,
        foreign.userFiles,
        "a session whose workspace is another folder",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("starts no helper turn beside hooks in the CLI's own config folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const config = path.join(userHome, ".gemini", "config");
      yield* fileSystem.makeDirectory(config, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(config, "hooks.json"),
        '{"default":{"PreInvocation":[{"command":"do-not-run"}]}}',
      );
      const hooked = yield* cliHelperTurn(userHome, HELPER_SESSION);
      assert.equal(hooked.result, "Failure");
      assert.deepEqual(hooked.helperFiles, [], "no agent started");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads limits with the sign-in of the runtime that runs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const profileDirectory = path.join(userHome, "profile");
      // A profile the 1.4.5 runtime used still holds its refreshable login.
      const profileApp = path.join(profileDirectory, "antigravity-acp");
      yield* fileSystem.makeDirectory(profileApp, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(profileApp, "acp_token.json"),
        JSON.stringify({
          client_id: "client",
          client_secret: "profile-secret",
          refresh_token: "profile-refresh",
        }),
      );
      const cliApp = path.join(userHome, ".gemini", "antigravity-cli");
      yield* fileSystem.makeDirectory(cliApp, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cliApp, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "cli-access",
            refresh_token: "cli-refresh",
            expiry: "1970-01-01T01:00:00.123456789Z",
          },
        }),
      );
      const requests: Array<{ readonly url: string; readonly bearer: string | undefined }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, bearer: request.headers.authorization });
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/token")
              ? Response.json({ access_token: "profile-access", expires_in: 3600 })
              : request.url.endsWith(":retrieveUserQuotaSummary")
                ? Response.json({
                    buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75 }],
                  })
                : Response.json({}, { status: 403 }),
          );
        }),
      );
      let runtime: "cli" | "managed" = "cli";
      let keyring: string | undefined;
      const { probe } = yield* makeAntigravityRuntimeUsageProbe({
        profileDirectory,
        userHome,
        authMethod: "oauth-personal",
        readKeyringSecret: Effect.sync(() => keyring),
        runtimeState: Effect.sync(() =>
          runtime === "cli"
            ? antigravityRuntimeState(
                { managedVersionDirectory: null },
                { profileDirectory, userHome, path },
              )
            : profileAntigravityRuntimeState(profileDirectory),
        ),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));

      const cli = yield* probe;
      assert.isUndefined(cli.unavailable);
      assert.deepEqual(
        cli.windows.map((window) => [window.id, window.usedPercent]),
        [["gemini-5h", 25]],
      );
      assert.isFalse(
        requests.some((request) => request.url.endsWith("/token")),
        "the CLI's own login, not the profile's, with no refresh",
      );
      assert.isTrue(requests.some((request) => request.bearer === "Bearer cli-access"));

      runtime = "managed";
      requests.length = 0;
      const managed = yield* probe;
      assert.isTrue(requests.some((request) => request.url.endsWith("/token")));
      assert.isFalse(requests.some((request) => request.bearer === "Bearer cli-access"));
      assert.isUndefined(managed.unavailable);
      assert.notMatch(
        JSON.stringify([cli, managed]),
        /cli-access|cli-refresh|profile-access|profile-refresh|profile-secret/,
      );

      // The user's own CLI may keep its Google sign-in only in the system keyring.
      yield* fileSystem.remove(path.join(cliApp, "antigravity-oauth-token"));
      keyring = JSON.stringify({
        token: { access_token: "keyring-access", expiry: "1970-01-01T01:00:00.123456789Z" },
      });
      runtime = "cli";
      requests.length = 0;
      const fromKeyring = yield* probe;
      assert.isUndefined(fromKeyring.unavailable);
      assert.isTrue(requests.some((request) => request.bearer === "Bearer keyring-access"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
