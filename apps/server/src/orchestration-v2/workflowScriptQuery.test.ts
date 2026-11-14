// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2GetWorkflowScriptInput,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { readWorkflowScript } from "./workflowScriptQuery.ts";
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
const customScript = NodePath.join(customHome, "projects", "test", "run.js");
const envScript = NodePath.join(envHome, "projects", "test", "run.js");
NodeFS.mkdirSync(NodePath.dirname(customScript), { recursive: true });
NodeFS.mkdirSync(NodePath.dirname(envScript), { recursive: true });
NodeFS.writeFileSync(customScript, "custom home");
NodeFS.writeFileSync(envScript, "environment home");
const customLink = NodePath.join(NodePath.dirname(customScript), "escape.js");
if (symlinksSupported) NodeFS.symlinkSync(outside, customLink);

const fixtureThreadId = ThreadId.make("workflow-script-fixture");
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("workflow-script-fixture:create"),
      threadId: fixtureThreadId,
      projectId: ProjectId.make("workflow-project"),
      title: "Workflow",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
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

const providerInstances = {
  [ProviderInstanceId.make("claude-missing")]: {
    driver: ProviderDriverKind.make("claudeAgent"),
    config: { homePath: NodePath.join(sandbox, "missing") },
  },
  [ProviderInstanceId.make("claude-custom")]: {
    driver: ProviderDriverKind.make("claudeAgent"),
    config: { homePath: NodePath.relative(process.cwd(), customHome) },
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: "ignored-config", sensitive: false }],
  },
  [ProviderInstanceId.make("claude-env")]: {
    driver: ProviderDriverKind.make("claudeAgent"),
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: envHome, sensitive: false }],
  },
};

effectIt.layer(
  Settings.layerTest({ providerInstances }).pipe(
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, home)),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(NodePathService.layer),
    Layer.provideMerge(fixture),
    Layer.provideMerge(Layer.mock(ProjectStore.ProjectStoreV2)({})),
  ),
)("workflow script containment", (effectIt) => {
  effectIt.effect.each(["valid", "malformed"] as const)(
    "reads configured Claude homes while rejecting escapes with %s unrelated config",
    (unrelatedConfig) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* readWorkflowScript({ threadId: fixtureThreadId, scriptPath: customScript }))
            .contents,
          "custom home",
        );
        assert.equal(
          (yield* readWorkflowScript({ threadId: fixtureThreadId, scriptPath: envScript }))
            .contents,
          "environment home",
        );
        assert.equal(
          (yield* readWorkflowScript({ threadId: fixtureThreadId, scriptPath })).contents,
          "export const meta = {};\n",
        );
        const escaped = yield* readWorkflowScript({
          threadId: fixtureThreadId,
          scriptPath: outside,
        }).pipe(Effect.flip);
        assert.equal(escaped.reason, "outside-root");
        if (symlinksSupported) {
          const linked = yield* readWorkflowScript({
            threadId: fixtureThreadId,
            scriptPath: customLink,
          }).pipe(Effect.flip);
          assert.equal(linked.reason, "outside-root");
        }
      }).pipe(
        Effect.provide(
          Settings.layerTest({
            providerInstances: {
              ...providerInstances,
              [ProviderInstanceId.make("claude-unrelated")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: false,
                config:
                  unrelatedConfig === "malformed" ? { autoCompactWindow: "not-a-number" } : {},
              },
            },
          }),
        ),
      ),
  );

  effectIt.effect("reads a relative Claude config from the thread checkout", () =>
    Effect.gen(function* () {
      const cwd = NodePath.join(sandbox, "checkout");
      const relativeScript = NodePath.join(cwd, "claude-config", "projects", "test", "run.js");
      NodeFS.mkdirSync(NodePath.dirname(relativeScript), { recursive: true });
      NodeFS.writeFileSync(relativeScript, "thread workflow");
      assert.notEqual(cwd, process.cwd());
      const threadId = ThreadId.make("workflow-relative-home");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("workflow-relative-home:create"),
        threadId,
        projectId: ProjectId.make("workflow-project"),
        title: "Workflow",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const input: OrchestrationV2GetWorkflowScriptInput = { threadId, scriptPath: relativeScript };
      const result = yield* readWorkflowScript(input);
      assert.equal(result.contents, "thread workflow");
      assert.equal(result.truncated, false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProviderReplayHarness.layerWithRegistry(
            { name: "workflow-relative-home" },
            ProviderAdapterRegistry.layerFromAdapters([]),
            { runEffectWorker: false },
          ),
          Settings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: "claude-config", sensitive: false },
                ],
              },
            },
          }),
        ),
      ),
    ),
  );

  effectIt.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a FIFO without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fifo = NodePath.join(root, "pipe.js");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        const error = yield* Effect.flip(
          readWorkflowScript({ threadId: fixtureThreadId, scriptPath: fifo }),
        );
        assert.equal(error.reason, "not-regular-file");
      }),
  );

  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ threadId: fixtureThreadId, scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "rejects paths outside the root and symlink escapes",
    () =>
      Effect.gen(function* () {
        const escaped = yield* Effect.exit(
          readWorkflowScript({ threadId: fixtureThreadId, scriptPath: outside }),
        );
        assert.equal(escaped._tag, "Failure");
        const sneaky = yield* Effect.exit(
          readWorkflowScript({ threadId: fixtureThreadId, scriptPath: link }).pipe(
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
