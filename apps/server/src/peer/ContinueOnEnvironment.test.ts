import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ContinueOnEnvironment from "./ContinueOnEnvironment.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as WorkFilesTransfer from "./WorkFilesTransfer.ts";

const here = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");
const threadId = ThreadId.make("thread:laptop");
const boxProject = ProjectId.make("project:box");
const instanceId = ProviderInstanceId.make("codex");

const item = (id: string, type: "user_message" | "assistant_message", text: string) => ({
  id,
  type,
  text,
  threadId,
  runId: "run:1",
  providerThreadId: null,
  status: "completed",
});

/** The laptop's thread, the box's answers, and what was asked of the box, in order. */
const setup = (
  sendResult: Effect.Effect<{ files: number; deletions: number }, OrchestratorMcpFailure>,
) => {
  const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const layer = ContinueOnEnvironment.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              projectId: ProjectId.make("project:laptop"),
              title: "Fix the flaky test",
              worktreePath: "/home/user/app",
              runtimeMode: "full-access",
              interactionMode: "default",
              modelSelection: { instanceId, model: "gpt-5.4" },
            },
            turnItems: [
              item("item:1", "user_message", "The login test fails on CI."),
              item(
                "item:2",
                "assistant_message",
                "It races the session cookie; I patched auth.ts.",
              ),
            ],
            runs: [],
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ workspaceRoot: "/home/user/app" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed({ canonicalKey: "github.com/acme/app" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        enabled: Effect.succeed(true),
        get: () => Effect.succeedSome({ environmentId: box, label: "Box" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerMcpClient.PeerMcpClient)({
        call: (input) =>
          Effect.sync(() => {
            calls.push({ tool: input.tool, arguments: input.arguments });
            switch (input.tool) {
              case "t3_project_list":
                return {
                  projects: [
                    {
                      id: boxProject,
                      title: "app",
                      repositoryIdentity: { canonicalKey: "github.com/acme/app" },
                    },
                  ],
                  nextCursor: null,
                };
              case "orchestrator_capabilities":
                return { providers: [{ providerInstanceId: instanceId }] };
              case "t3_thread_launch":
                return { threadId: ThreadId.make("thread:box"), projectId: boxProject };
              default:
                return {};
            }
          }) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkFilesTransfer.WorkFilesTransfer)({
        send: (input) =>
          Effect.suspend(() => {
            calls.push({ tool: "send", arguments: { cwd: input.cwd, projectId: input.projectId } });
            return sendResult;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(here),
        getDescriptor: Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { calls, layer };
};

it.effect("starts a thread there from this one's conversation, after its files land", () => {
  const { calls, layer } = setup(Effect.succeed({ files: 2, deletions: 1 }));
  return Effect.gen(function* () {
    const service = yield* ContinueOnEnvironment.ContinueOnEnvironment;
    const result = yield* service.continueThread({
      threadId,
      environmentId: box,
      workFiles: "transfer",
    });
    expect(result).toEqual({
      environmentId: box,
      threadId: ThreadId.make("thread:box"),
      projectId: boxProject,
      label: "Box",
      transferredFiles: 2,
    });
    expect(calls.map((call) => call.tool)).toEqual([
      "t3_project_list",
      "send",
      "orchestrator_capabilities",
      "t3_thread_launch",
    ]);
    expect(calls[1]?.arguments).toEqual({ cwd: "/home/user/app", projectId: boxProject });
    const launch = calls[3]!.arguments;
    expect(launch).toMatchObject({
      projectId: boxProject,
      title: "Fix the flaky test",
      modelSelection: { instanceId, model: "gpt-5.4" },
    });
    // The handoff carries the conversation and says the files came along.
    expect(launch.message).toContain("The login test fails on CI.");
    expect(launch.message).toContain("It races the session cookie; I patched auth.ts.");
    expect(launch.message).toContain("2 files written, 1 deleted");
  }).pipe(Effect.provide(layer));
});

it.effect("launches nothing there when the files cannot go", () => {
  const { calls, layer } = setup(
    Effect.fail(
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "app.ts (it has local changes there)",
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ContinueOnEnvironment.ContinueOnEnvironment;
    const refused = yield* service
      .continueThread({ threadId, environmentId: box, workFiles: "transfer" })
      .pipe(Effect.flip);
    expect(refused.message).toBe("Box: app.ts (it has local changes there)");
    expect(calls.map((call) => call.tool)).toEqual(["t3_project_list", "send"]);
  }).pipe(Effect.provide(layer));
});

it.effect("without files, sends nothing and says the checkout has only what is committed", () => {
  const { calls, layer } = setup(Effect.die("no send"));
  return Effect.gen(function* () {
    const service = yield* ContinueOnEnvironment.ContinueOnEnvironment;
    const result = yield* service.continueThread({
      threadId,
      environmentId: box,
      workFiles: "skip",
    });
    expect(result.transferredFiles).toBe(0);
    expect(calls.map((call) => call.tool)).not.toContain("send");
    expect(calls.at(-1)?.arguments.message).toContain("this checkout has only what is committed");
  }).pipe(Effect.provide(layer));
});
