import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const HISTORY_KEY = "_t3PreviousResumeCursors";

const ProviderResumeCursorHistoryEntry = Schema.Struct({
  providerName: Schema.String,
  resumeCursor: Schema.Unknown,
});
export type ProviderResumeCursorHistoryEntry = typeof ProviderResumeCursorHistoryEntry.Type;

const decodeHistory = Schema.decodeUnknownOption(Schema.Array(ProviderResumeCursorHistoryEntry));

/** Reads the stable transcript-session identity from a provider resume cursor. */
export function providerResumeCursorSessionId(
  providerName: string,
  resumeCursor: unknown,
): string | null {
  if (!Predicate.isObject(resumeCursor)) return null;
  const sessionId =
    providerName === "claudeAgent"
      ? resumeCursor["resume"]
      : providerName === "codex"
        ? resumeCursor["threadId"]
        : providerName === "grok"
          ? resumeCursor["sessionId"]
          : null;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

/** Reads the previous provider sessions retained inside a runtime payload. */
export function readProviderResumeCursorHistory(
  runtimePayload: unknown | null,
): readonly ProviderResumeCursorHistoryEntry[] {
  if (!Predicate.isObject(runtimePayload)) return [];
  return Option.getOrElse(decodeHistory(runtimePayload[HISTORY_KEY]), () => []);
}

/** Retains the current cursor before a replacement provider session overwrites it. */
export function preservePreviousResumeCursor(input: {
  readonly previousProviderName: string;
  readonly nextProviderName: string;
  readonly previousResumeCursor: unknown | null;
  readonly nextResumeCursor: unknown | undefined;
  readonly runtimePayload: unknown | null;
}): unknown | null {
  const previousSessionId = providerResumeCursorSessionId(
    input.previousProviderName,
    input.previousResumeCursor,
  );
  const nextSessionId = providerResumeCursorSessionId(
    input.nextProviderName,
    input.nextResumeCursor,
  );
  if (previousSessionId === null || input.nextResumeCursor === undefined) {
    return input.runtimePayload;
  }
  const previousSessionKey = `${input.previousProviderName}:${previousSessionId}`;
  if (
    nextSessionId !== null &&
    previousSessionKey === `${input.nextProviderName}:${nextSessionId}`
  ) {
    return input.runtimePayload;
  }

  const history = readProviderResumeCursorHistory(input.runtimePayload);
  if (
    history.some((entry) => {
      const sessionId = providerResumeCursorSessionId(entry.providerName, entry.resumeCursor);
      return sessionId !== null && `${entry.providerName}:${sessionId}` === previousSessionKey;
    })
  ) {
    return input.runtimePayload;
  }

  return {
    ...(Predicate.isObject(input.runtimePayload) ? input.runtimePayload : {}),
    [HISTORY_KEY]: [
      ...history,
      {
        providerName: input.previousProviderName,
        resumeCursor: input.previousResumeCursor,
      },
    ],
  };
}
