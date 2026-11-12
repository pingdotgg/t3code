import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ExtensionHostAdapter from "./ExtensionHostAdapter.ts";

it.effect("preserves domain failures and wraps underlying host service failures", () =>
  Effect.gen(function* () {
    const adapter = yield* ExtensionHostAdapter.ExtensionHostAdapter;
    const unknown = yield* adapter.call("projects.lst", {}).pipe(Effect.asVoid, Effect.flip);
    expect(unknown).toMatchObject({ operation: "projects.lst", id: "host", reason: "not-found" });
    const failed = yield* adapter.call("projects.list", {}).pipe(Effect.asVoid, Effect.flip);
    expect(failed).toMatchObject({
      operation: "projects.list",
      id: "host",
      reason: "runtime-failed",
      cause: { _tag: "ProjectOperationError" },
    });
  }).pipe(
    Effect.provide(
      ExtensionHostAdapter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProcessRunner.ProcessRunner)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ProjectService.ProjectService)({
              snapshot: Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "list-projects",
                  cause: "test",
                }),
              ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(DocumentText.DocumentText)({}),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-extension-adapter-" }),
            FetchHttpClient.layer,
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
