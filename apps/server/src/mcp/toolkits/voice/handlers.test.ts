import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettingsModule from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as VoiceHandlers from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:voice");
const threadId = ThreadId.make("thread:voice");
const otherThreadId = ThreadId.make("thread:other");

it.effect("turns voice on and off for the calling thread only", () =>
  Effect.gen(function* () {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:voice",
        thread: {
          threadId,
          providerSessionId: "provider:voice",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(ServerSettingsModule.ServerSettingsService)({
        getSettings: Effect.sync(() => settings),
        updateSettings: (patch) =>
          Effect.sync(() => {
            settings = { ...settings, ...patch } as ServerSettings;
            return settings;
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* VoiceToolkit;
      const call = (action: "on" | "off" | "toggle") =>
        toolkit.handle("t3_voice_mode", { action }).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      expect(yield* call("on")).toEqual({ mode: "oneWay" });
      expect(settings.voice).toMatchObject({ mode: "oneWay", threadId });
      expect(yield* call("toggle")).toEqual({ mode: "off" });
      expect(settings.voice).toMatchObject({ mode: "off", threadId: null });

      settings = { ...settings, voice: { mode: "twoWay", threadId, setAt: "y" } };
      expect(yield* call("on")).toEqual({ mode: "twoWay" });
      expect(settings.voice).toMatchObject({ mode: "twoWay", setAt: "y" });

      settings = { ...settings, voice: { mode: "oneWay", threadId: otherThreadId, setAt: "x" } };
      expect(yield* call("off")).toEqual({ mode: "off" });
      expect(settings.voice).toMatchObject({ threadId: otherThreadId, setAt: "x" });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(VoiceHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
