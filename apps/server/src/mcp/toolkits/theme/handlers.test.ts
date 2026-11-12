import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type EnvironmentTheme,
  type EnvironmentThemeFile,
  ProviderInstanceId,
  type ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { EnvironmentThemeService } from "../../../environmentTheme.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThemeHandlers from "./handlers.ts";
import { ThemeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:theme");
const threadId = ThreadId.make("thread:theme");
const AGENT_THEME: EnvironmentThemeFile = {
  name: "Agent Look",
  appearance: "dark",
  canvas: "#101010",
  accent: "#7aa2f7",
  css: "[data-chat-header] { border-bottom: 1px solid red; }",
};

it.effect("publishes a theme, makes it the default, and refuses an unknown theme id", () =>
  Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<EnvironmentTheme>>([]);
    const patches = yield* Ref.make<ReadonlyArray<ServerSettingsPatch>>([]);
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:theme",
        thread: {
          threadId,
          providerSessionId: "provider:theme",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(EnvironmentThemeService)({
        current: Ref.get(published),
        publish: (id, file) =>
          Ref.update(published, (themes) => [...themes, { id, ...file } as EnvironmentTheme]),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: (patch) =>
          Ref.update(patches, (all) => [...all, patch]).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* ThemeToolkit;
      const call = (params: Parameters<typeof toolkit.handle<"t3_theme_set">>[1]) =>
        toolkit.handle("t3_theme_set", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      expect(yield* call({ themeId: "agent-look", theme: AGENT_THEME })).toEqual({
        themeId: "agent-look",
        published: true,
      });
      expect(yield* Ref.get(published)).toEqual([{ id: "agent-look", ...AGENT_THEME }]);
      expect(yield* Ref.get(patches)).toMatchObject([{ defaultTheme: "agent-look" }]);
      expect((yield* Ref.get(patches))[0]?.defaultThemeSetAt).toMatch(/^\d{4}-/);

      expect(yield* call({ themeId: "missing" })).toMatchObject({ code: "invalid_request" });
      expect(yield* call({ themeId: "grove" })).toEqual({ themeId: "grove", published: false });
      expect((yield* Ref.get(patches)).map((patch) => patch.defaultTheme)).toEqual([
        "agent-look",
        "grove",
      ]);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThemeHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
