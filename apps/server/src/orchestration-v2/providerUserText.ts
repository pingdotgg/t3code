import type { ComposerContextRecord } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

/**
 * The user text a provider receives, for new turns and steers alike. Agent chips say whether the
 * agent still exists here; unreadable settings leave that status out rather than guess.
 */
export const providerUserText = Effect.fn("providerUserText")(function* (input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
}) {
  const agents = input.records.some((record) => record.kind === "agent")
    ? yield* ServerSettings.ServerSettingsService.pipe(
        Effect.flatMap((settings) => settings.getSettings),
        Effect.map((settings) => settings.mcpGatewayProfiles),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  return projectComposerContextForProvider({
    text: input.text,
    records: input.records,
    ...(agents === undefined ? {} : { agents }),
  });
});
