import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ImproveJob,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Improve from "./ImproveService.ts";

it.effect("recovers interrupted jobs and creates the destination thread once on retry", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceThreadId = ThreadId.make("source");
    const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };
    const stored = ["rewriting", "launching", "launched"] as const;
    const jobs = stored.map((phase): ImproveJob => ({
      requestId: "request-" + phase,
      sourceThreadId,
      originalPrompt: "Prepare a changelog.",
      improvedPrompt: phase === "rewriting" ? null : "Summarize the changes since the release.",
      contextSummary: null,
      improver: model,
      destination: model,
      phase,
      failedStep: null,
      error: null,
      newThreadId: phase === "launched" ? ThreadId.make("improve:request-launched") : null,
      createdAt: "2026-11-19T12:00:00.000Z",
      updatedAt: "2026-11-19T12:00:00.000Z",
    }));
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(config.stateDir, "improve-jobs.json"),
      JSON.stringify({ version: 1, jobs }),
    );

    const projectId = ProjectId.make("source-project");
    const shell = {
      id: sourceThreadId,
      projectId,
      title: "Changelog",
      branch: null,
      worktreePath: null,
      runtimeMode: "full-access",
      interactionMode: "default",
    } as OrchestrationV2ThreadShell;
    const projection = { messages: [] } as unknown as OrchestrationV2ThreadProjection;
    const { listed, retried, repeated } = yield* Effect.gen(function* () {
      const improve = yield* Improve.ImproveService;
      const listed = yield* improve.list(sourceThreadId);
      const retried = yield* improve.retry({ requestId: "request-launching" });
      const repeated = yield* improve.retry({ requestId: "request-launching" });
      return { listed, retried, repeated };
    }).pipe(
      Effect.provide(
        Improve.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(shell),
              }),
              Layer.mock(ThreadLaunch.ThreadLaunchService)({
                launch: (input) =>
                  input.reuseExistingThread === true
                    ? Effect.fail(
                        new ThreadLaunch.ThreadLaunchError({
                          operation: "update-thread",
                          commandId: input.commandId,
                          projectId,
                          cause: "The destination thread does not exist.",
                        }),
                      )
                    : Effect.succeed({ threadId: input.threadId!, projection, resumed: false }),
              }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(TextGeneration.TextGeneration)({}),
            ),
          ),
        ),
      ),
    );
    expect(listed).toMatchObject([
      { requestId: "request-rewriting", phase: "failed", failedStep: "rewrite" },
      {
        requestId: "request-launching",
        phase: "failed",
        failedStep: "launch",
        improvedPrompt: jobs[1]!.improvedPrompt,
      },
      {
        requestId: "request-launched",
        phase: "launched",
        failedStep: null,
        newThreadId: jobs[2]!.newThreadId,
      },
    ]);
    expect(retried).toMatchObject({
      phase: "launched",
      newThreadId: "improve:request-launching",
      improvedPrompt: jobs[1]!.improvedPrompt,
    });
    expect(repeated).toEqual(retried);
  }).pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "continuum-improve-restart-" })),
    Effect.provide(NodeServices.layer),
  ),
);
