import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ThemeToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(ThemeToolkit, {
  t3_theme_read: McpToolAccess.reads(({ themeId }) =>
    Effect.gen(function* () {
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const settings = yield* Settings.ServerSettingsService;
      const published = yield* themes.current;
      const { defaultTheme } = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const requested = published.find((theme) => theme.id === themeId);
      if (themeId !== undefined && requested === undefined) {
        return yield* invalid(`No published theme is named "${themeId}".`);
      }
      return {
        current: defaultTheme,
        builtIn: BUILT_IN_THEME_IDS,
        published: published.map(({ id, name, css }) => ({ id, name, hasCss: Boolean(css) })),
        ...(requested === undefined ? {} : { theme: Struct.omit(requested, ["id"]) }),
        guide: THEME_GUIDE,
      };
    }),
  ),
  t3_theme_set: McpToolAccess.writesEnvironment(({ themeId, theme }, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const settings = yield* Settings.ServerSettingsService;
      const set = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        if (theme !== undefined) {
          yield* themes
            .publish(themeId, theme)
            .pipe(Effect.mapError((error) => invalid(error.message)));
        } else {
          const known = [...BUILT_IN_THEME_IDS, ...(yield* themes.current).map(({ id }) => id)];
          if (!known.includes(themeId)) {
            return yield* invalid(
              `No theme is named "${themeId}". Available: ${known.join(", ")}.`,
            );
          }
        }
        // The timestamp makes clients apply the theme again when its id did not change.
        yield* settings
          .updateSettings({
            defaultTheme: themeId,
            defaultThemeSetAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.mapError(unavailable));
        return { themeId, published: theme !== undefined };
      });
      return yield* scope.thread === undefined
        ? set
        : executor.withLock(scope.thread.threadId, set);
    }),
  ),
});
