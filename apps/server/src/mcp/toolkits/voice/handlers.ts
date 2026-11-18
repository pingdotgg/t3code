import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { VoiceToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(VoiceToolkit, {
  t3_voice_mode: McpToolAccess.actsAsCaller(({ action }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((context) => McpInvocationContext.requireThreadScope(context, "Voice")),
      );
      const threadId = scope.thread.threadId;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { voice } = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const onHere = voice.mode === "oneWay" && voice.threadId === threadId;
      const on = action === "toggle" ? !onHere : action === "on";
      if (on !== onHere) {
        const setAt = DateTime.formatIso(yield* DateTime.now);
        yield* settings
          .updateSettings({
            voice: on
              ? { mode: "oneWay", threadId, setAt }
              : { mode: "off", threadId: null, setAt },
          })
          .pipe(Effect.mapError(unavailable));
      }
      return { mode: on ? ("oneWay" as const) : ("off" as const) };
    }),
  ),
});
