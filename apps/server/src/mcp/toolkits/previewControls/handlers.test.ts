import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PreviewControlsHandlersLive } from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("preview-controls-project");
      const threadId = ThreadId.make("preview-controls-thread");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]: { enableAgentBrowserAccess: projectAccess },
        },
      };
      const effective = resolveProjectSettings(settings, projectId).settings;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        threadId,
        providerSessionId: "preview-controls-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(effective.enableAgentBrowserAccess ? ["preview"] : []),
        issuedAt: 0,
      };
      const manager = yield* Preview.make;
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const dependencies = Layer.mergeAll(
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(PreviewControlsHandlersLive.pipe(Layer.provide(dependencies))),
      );
      const listed = yield* toolkit
        .handle("t3_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const closed = yield* toolkit
        .handle("t3_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (projectAccess) {
        expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
        expect(closed.at(-1)?.result).toEqual({});
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      } else {
        for (const result of [listed, closed]) {
          expect(result.at(-1)?.result).toMatchObject({
            _tag: "PreviewAutomationUnavailableError",
            capability: "preview",
            threadId,
          });
        }
        expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
      }
    }),
  ),
);
