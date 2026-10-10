import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SkillLibrary from "../../../skills/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ToolsHandlers from "./handlers.ts";
import { ToolsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:tools");
const threadId = ThreadId.make("thread:tools");
const projectId = ProjectId.make("project:tools");

const initial: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  disabledSkills: ["grill-me"],
  mcpServers: {
    context7: {
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: [{ name: "CONTEXT7_API_KEY", value: "secret", sensitive: true }],
      },
    },
  },
};

it.effect("switches skills and servers for a project as one patch, and never returns secrets", () =>
  Effect.gen(function* () {
    const settings = yield* Ref.make(initial);
    const patches = yield* Ref.make<ReadonlyArray<ServerSettingsPatch>>([]);
    // Applied once, right after the next read, as a concurrent write would be.
    const interleave = yield* Ref.make<((current: ServerSettings) => ServerSettings) | null>(null);
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:tools",
        thread: {
          threadId,
          providerSessionId: "provider:tools",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Ref.get(settings).pipe(
          Effect.tap(() =>
            Ref.getAndSet(interleave, null).pipe(
              Effect.flatMap((change) =>
                change === null ? Effect.void : Ref.update(settings, change),
              ),
            ),
          ),
        ),
        updateSettingsWith: (build) =>
          Ref.get(settings).pipe(
            Effect.map(build),
            Effect.tap((patch) => Ref.update(patches, (list) => [...list, patch])),
            Effect.flatMap((patch) =>
              Ref.updateAndGet(settings, (current) => applyServerSettingsPatch(current, patch)),
            ),
          ),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SkillLibrary.SkillLibrary)({}),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* ToolsToolkit;
      const result = yield* toolkit
        .handle("t3_tools_update", {
          projectId,
          skills: [
            { name: "grill-me", enabled: true },
            { name: "tdd", enabled: false },
          ],
          mcpServers: [{ name: "context7", enabled: false }],
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toEqual({
        disabledSkills: ["tdd"],
        mcpServers: [{ name: "context7", enabled: false, summary: "npx -y @upstash/context7-mcp" }],
      });
      // One write, so the project never sits half-changed.
      expect(yield* Ref.get(patches)).toHaveLength(1);
      expect((yield* Ref.get(settings)).projectSettingsOverrides[projectId]).toEqual({
        disabledSkills: { "grill-me": false, tdd: true },
        mcpServers: { context7: { enabled: false } },
      });
      // The environment itself is unchanged.
      expect((yield* Ref.get(settings)).disabledSkills).toEqual(["grill-me"]);

      // Another change lands after this call reads settings, before it writes; it survives.
      yield* Ref.set(interleave, (current) => ({
        ...current,
        projectSettingsOverrides: {
          ...current.projectSettingsOverrides,
          [projectId]: {
            ...current.projectSettingsOverrides[projectId],
            disabledSkills: {
              ...current.projectSettingsOverrides[projectId]?.disabledSkills,
              review: true,
            },
          },
        },
      }));
      yield* toolkit
        .handle("t3_tools_update", { projectId, skills: [{ name: "tdd", enabled: true }] })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(
        (yield* Ref.get(settings)).projectSettingsOverrides[projectId]?.disabledSkills,
      ).toEqual({ "grill-me": false, review: true });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ToolsHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
