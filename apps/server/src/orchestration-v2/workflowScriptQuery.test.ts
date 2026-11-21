// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  SecretProviderId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as WorkflowScriptQuery from "./workflowScriptQuery.ts";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as Layer from "effect/Layer";
import * as NodePathService from "@effect/platform-node/NodePath";

const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-script-"));
const home = NodePath.join(sandbox, "home");
const root = NodePath.join(home, ".claude", "projects", "test");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(sandbox, "outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
if (symlinksSupported) {
  NodeFS.rmSync(link, { force: true });
  NodeFS.symlinkSync(outside, link);
  if (!NodeFS.lstatSync(link).isSymbolicLink()) {
    throw new Error("test setup: sneaky.js must be a symlink");
  }
}

afterAll(() => {
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

const customHome = NodePath.join(sandbox, "custom");
const envHome = NodePath.join(sandbox, "environment");
const secretHome = NodePath.join(sandbox, "secret");
const checkout = NodePath.join(sandbox, "checkout");
const customScript = NodePath.join(customHome, "projects", "test", "run.js");
const envScript = NodePath.join(envHome, "projects", "test", "run.js");
const secretScript = NodePath.join(secretHome, "projects", "test", "run.js");
const relativeScript = NodePath.join(checkout, "claude-config", "projects", "test", "run.js");
for (const [file, contents] of [
  [customScript, "custom home"],
  [envScript, "environment home"],
  [secretScript, "secret home"],
  [relativeScript, "thread checkout home"],
] as const) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
}

const threadId = ThreadId.make("workflow-script-fixture");
const orphanThreadId = ThreadId.make("workflow-script-orphan");
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("workflow-script-fixture:create"),
      threadId,
      projectId: ProjectId.make("workflow-project"),
      title: "Workflow",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: checkout,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("workflow-script-orphan:create"),
      threadId: orphanThreadId,
      projectId: ProjectId.make("workflow-missing-project"),
      title: "Orphan",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  }),
).pipe(
  Layer.provideMerge(
    ProviderReplayHarness.layerWithRegistry(
      { name: "workflow-script-fixture" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    ),
  ),
);

const claude = ProviderDriverKind.make("claudeAgent");
const providerInstances = {
  [ProviderInstanceId.make("claude-missing")]: {
    driver: claude,
    config: { homePath: NodePath.join(sandbox, "missing") },
  },
  // Explicit homes resolve against the server cwd and win over CLAUDE_CONFIG_DIR.
  [ProviderInstanceId.make("claude-custom")]: {
    driver: claude,
    config: { homePath: NodePath.relative(process.cwd(), customHome) },
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: "ignored-config", sensitive: false }],
  },
  [ProviderInstanceId.make("claude-env")]: {
    driver: claude,
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: envHome, sensitive: false }],
  },
  [ProviderInstanceId.make("claude-secret")]: {
    driver: claude,
    environment: [
      {
        name: "CLAUDE_CONFIG_DIR",
        value: { provider: SecretProviderId.make("vault"), reference: "claude-home" },
        sensitive: true,
      },
    ],
  },
  // Inherited relative config dirs resolve against the thread checkout, as Claude Code does.
  [ProviderInstanceId.make("claude-relative")]: {
    driver: claude,
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: "claude-config", sensitive: false }],
  },
  [ProviderInstanceId.make("claude-malformed")]: {
    driver: claude,
    enabled: false,
    config: { autoCompactWindow: "not-a-number" },
  },
};

const read = (scriptPath: string) =>
  WorkflowScriptQuery.WorkflowScriptQuery.use((query) =>
    query.readWorkflowScript({ threadId, scriptPath }),
  );

effectIt.layer(
  WorkflowScriptQuery.layer.pipe(
    Layer.provideMerge(Settings.layerTest({ providerInstances })),
    Layer.provideMerge(
      Layer.mock(SecretResolver.SecretResolver)({
        read: (references) => Effect.succeed(references.map(() => secretHome)),
      }),
    ),
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, home)),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(NodePathService.layer),
    Layer.provideMerge(fixture),
    Layer.provideMerge(Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone })),
  ),
)("workflow script containment", (effectIt) => {
  effectIt.effect("reads scripts from every configured Claude home", () =>
    Effect.gen(function* () {
      assert.equal((yield* read(customScript)).contents, "custom home");
      assert.equal((yield* read(envScript)).contents, "environment home");
      assert.equal((yield* read(secretScript)).contents, "secret home");
      assert.equal((yield* read(relativeScript)).contents, "thread checkout home");
      const result = yield* read(scriptPath);
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
      const orphan = yield* WorkflowScriptQuery.WorkflowScriptQuery.use((query) =>
        query.readWorkflowScript({ threadId: orphanThreadId, scriptPath }),
      ).pipe(Effect.flip);
      assert.equal(orphan.reason, "root-unavailable");
    }),
  );

  effectIt.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a FIFO without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fifo = NodePath.join(root, "pipe.js");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        const error = yield* Effect.flip(read(fifo));
        assert.equal(error.reason, "not-regular-file");
      }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "rejects paths outside the root and symlink escapes",
    () =>
      Effect.gen(function* () {
        const escaped = yield* Effect.exit(read(outside));
        assert.equal(escaped._tag, "Failure");
        const sneaky = yield* Effect.exit(
          read(link).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        );
        assert.equal(sneaky._tag, "Success");
        if (sneaky._tag === "Success") {
          assert.equal(sneaky.value, "outside-root");
        }
      }),
  );
});
