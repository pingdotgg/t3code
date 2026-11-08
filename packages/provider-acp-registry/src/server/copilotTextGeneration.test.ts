// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { makeCopilotTextGeneration } from "./copilotTextGeneration.ts";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "testFixtures/copilot-text-mock-agent.mjs",
);
const instanceId = ProviderInstanceId.make("acpRegistry_copilot");
const authKeys = {
  loggedInUsers: [{ host: "https://github.com", login: "octo" }],
  lastLoggedInUser: { host: "https://github.com", login: "octo" },
  copilotTokens: { "https://github.com:octo": "token-a" },
  authTokens: { "https://github.com:octo": "token-b" },
};

interface MockLog {
  readonly launch?: {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly copilotHome: string | null;
    readonly copiedConfig: string | null;
    readonly strippedPresent: ReadonlyArray<string>;
  };
  readonly request?: { readonly method: string; readonly params?: unknown };
  readonly clientResponse?: { readonly id: string; readonly result?: unknown };
}

const harness = (input: { readonly scenario: string; readonly userConfig?: string }) =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-text-test-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    // The server's own environment must not reach the helper either.
    vi.stubEnv("COPILOT_ALLOW_ALL", "true");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const userHome = NodePath.join(root, "user-copilot");
    NodeFS.mkdirSync(userHome);
    if (input.userConfig !== undefined) {
      NodeFS.writeFileSync(NodePath.join(userHome, "config.json"), input.userConfig);
    }
    const logPath = NodePath.join(root, "mock.ndjson");
    const command = writeFakeCli({
      directory: NodePath.join(root, "bin"),
      name: "copilot",
      source: execScriptSource({ scriptPath: mockAgentPath }),
    });
    const textGeneration = yield* makeCopilotTextGeneration({
      environment: { COPILOT_HOME: userHome },
      resolveSpawn: (cwd) =>
        Effect.succeed({
          command,
          // A local install's own arguments must not reach the helper.
          args: ["--acp", "--additional-mcp-config", "@mcp.json", "--allow-all"],
          cwd,
          env: {
            ...process.env,
            T3_MOCK_SCENARIO: input.scenario,
            T3_MOCK_LOG: logPath,
            COPILOT_ALLOW_ALL: "true",
            COPILOT_CUSTOM_INSTRUCTIONS_DIRS: userHome,
          },
        }),
    });
    const readLog = (): ReadonlyArray<MockLog> =>
      NodeFS.existsSync(logPath)
        ? NodeFS.readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as MockLog)
        : [];
    return { textGeneration, readLog };
  });

const generateTitle = (
  textGeneration: Effect.Success<ReturnType<typeof harness>>["textGeneration"],
  model: string,
) =>
  textGeneration.generateThreadTitle({
    cwd: process.cwd(),
    message: "Fix the flaky login test",
    modelSelection: createModelSelection(instanceId, model, [
      { id: "allow_all", value: "on" },
      { id: "mode", value: "https://agentclientprotocol.com/protocol/session-modes#autopilot" },
    ]),
  });

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe("Copilot text generation", () => {
  it.live("runs an isolated, tool-less Copilot helper with only the selected model", () =>
    Effect.gen(function* () {
      const { textGeneration, readLog } = yield* harness({
        scenario: "reply",
        userConfig: [
          "// User settings belong in settings.json.",
          JSON.stringify({
            ...authKeys,
            hooks: { sessionStart: [{ command: "touch pwned" }] },
            mcpServers: { evil: { command: "evil" } },
            installedPlugins: [{ name: "plugin" }],
            trustedFolders: [process.cwd()],
          }),
        ].join("\n"),
      });

      const generated = yield* generateTitle(textGeneration, "gpt-6-luna");
      const { launch } = readLog()[0]!;
      const requests = readLog().flatMap((entry) => (entry.request ? [entry.request] : []));

      assert.equal(generated.title, "Copilot title");
      assert.deepEqual(launch?.argv.slice(1), [
        "--available-tools=t3_no_tools",
        "--deny-tool=shell",
        "--deny-tool=write",
        "--deny-tool=read",
        "--deny-tool=url",
        "--deny-tool=memory",
        "--no-custom-instructions",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--disallow-temp-dir",
        "--sync-session=off",
        "--model=gpt-6-luna",
      ]);
      assert.equal(launch?.argv[0], "--acp");
      assert.deepEqual(launch?.strippedPresent, []);
      assert.deepEqual(JSON.parse(launch?.copiedConfig ?? "null"), authKeys);
      assert.notEqual(launch?.cwd, process.cwd());
      assert.isFalse(NodeFS.existsSync(launch!.cwd));
      assert.isFalse(NodeFS.existsSync(launch!.copilotHome!));
      assert.deepEqual(requests.find((request) => request.method === "session/new")?.params, {
        cwd: launch!.cwd,
        mcpServers: [],
      });
      assert.deepEqual(
        requests.filter((request) => request.method.startsWith("session/set_")),
        [],
      );

      yield* generateTitle(textGeneration, "default");
      const launches = readLog().flatMap((entry) => (entry.launch ? [entry.launch] : []));
      assert.equal(launches.length, 2);
      assert.isFalse(launches[1]!.argv.some((arg) => arg.startsWith("--model")));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.each([
    ["tool_call", "Copilot attempted tool work during text generation."],
    ["tool_call_completed", "Copilot attempted tool work during text generation."],
    ["limit_exceeded", "Copilot text generation exceeded the output limit."],
    ["empty", "Copilot returned empty text generation output."],
    ["cancelled", "Copilot text generation was cancelled."],
    ["permission", "Copilot requested a tool permission during text generation."],
    ["read_file", "Copilot requested a client tool during text generation."],
    ["auth_required", "Sign in to GitHub Copilot in provider settings."],
  ] as const)(
    "fails a %s helper without waiting for the turn and cleans up",
    ([scenario, detail]) =>
      Effect.gen(function* () {
        const { textGeneration, readLog } = yield* harness({ scenario });

        const error: TextGenerationError = yield* Effect.flip(
          generateTitle(textGeneration, "gpt-6-luna"),
        );
        const { launch } = readLog()[0]!;

        assert.equal(error.detail, detail);
        assert.isFalse(NodeFS.existsSync(launch!.cwd));
        assert.isFalse(NodeFS.existsSync(launch!.copilotHome!));
        if (scenario === "permission") {
          assert.deepEqual(
            readLog().find((entry) => entry.clientResponse?.id === "permission-1")?.clientResponse
              ?.result,
            { outcome: { outcome: "cancelled" } },
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("accepts output exactly at the cumulative limit", () =>
    Effect.gen(function* () {
      const { textGeneration, readLog } = yield* harness({ scenario: "limit_exact" });
      assert.equal((yield* generateTitle(textGeneration, "default")).title, "Copilot title");
      const { launch } = readLog()[0]!;
      assert.isFalse(NodeFS.existsSync(launch!.cwd));
      assert.isFalse(NodeFS.existsSync(launch!.copilotHome!));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "refuses before launching when sign-in state is unreadable or a review guide is asked",
    () =>
      Effect.gen(function* () {
        const unreadable = yield* harness({ scenario: "reply", userConfig: "{ not json" });
        const signInError = yield* Effect.flip(generateTitle(unreadable.textGeneration, "default"));
        assert.equal(
          signInError.detail,
          "Could not read the GitHub Copilot sign-in state for text generation.",
        );
        assert.deepEqual(unreadable.readLog(), []);

        const review = yield* harness({ scenario: "reply" });
        const reviewError = yield* Effect.flip(
          review.textGeneration.generateReviewGuide({
            cwd: process.cwd(),
            number: 1,
            title: "Title",
            description: "",
            baseBranch: "main",
            baseCommit: "abc",
            settledReview: "",
            modelSelection: createModelSelection(instanceId, "gpt-6-luna"),
          }),
        );
        assert.match(reviewError.detail, /^Copilot cannot investigate a checkout read-only\./);
        assert.deepEqual(review.readLog(), []);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
