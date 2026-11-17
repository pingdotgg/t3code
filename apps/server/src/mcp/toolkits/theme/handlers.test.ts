import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type EnvironmentThemeFile,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  EnvironmentThemeRefusedError,
  EnvironmentThemeService,
} from "../../../environmentTheme.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThemeHandlers from "./handlers.ts";
import { ThemeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:theme");
const threadId = ThreadId.make("thread:theme");
const AGENT_THEME = {
  name: "Agent Look",
  appearance: "dark",
  canvas: "#101010",
  accent: "#7aa2f7",
  css: "[data-chat-header] { border-bottom: 1px solid red; }",
} satisfies EnvironmentThemeFile;

it.effect("applies the theme through the service and reports a refusal as an invalid request", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
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
        apply: (input) =>
          "themeId" in input && input.themeId === "missing"
            ? Effect.fail(
                new EnvironmentThemeRefusedError({
                  themeId: input.themeId,
                  problem: "is not a built-in or published theme.",
                }),
              )
            : Effect.void,
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
      expect(yield* call({ themeId: "grove" })).toEqual({ themeId: "grove", published: false });
      expect(yield* call({ appearance: "dark" })).toEqual({
        appearance: "dark",
        published: false,
      });
      expect(yield* call({ theme: AGENT_THEME })).toMatchObject({ code: "invalid_request" });
      expect(yield* call({})).toMatchObject({ code: "invalid_request" });
      expect(yield* call({ themeId: "missing" })).toMatchObject({
        code: "invalid_request",
        message: 'Theme "missing" is not a built-in or published theme.',
      });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThemeHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
