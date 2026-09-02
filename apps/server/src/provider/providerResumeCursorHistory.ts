import * as Equal from "effect/Equal";
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

/** Reads the previous provider sessions retained inside a runtime payload. */
export function readProviderResumeCursorHistory(
  runtimePayload: unknown | null,
): readonly ProviderResumeCursorHistoryEntry[] {
  if (!Predicate.isObject(runtimePayload)) return [];
  return Option.getOrElse(decodeHistory(runtimePayload[HISTORY_KEY]), () => []);
}

/** Retains the current cursor before a replacement provider session overwrites it. */
export function preservePreviousResumeCursor(input: {
  readonly providerName: string;
  readonly previousResumeCursor: unknown | null;
  readonly nextResumeCursor: unknown | undefined;
  readonly runtimePayload: unknown | null;
}): unknown | null {
  if (
    input.previousResumeCursor === null ||
    input.nextResumeCursor === undefined ||
    Equal.equals(input.previousResumeCursor, input.nextResumeCursor)
  ) {
    return input.runtimePayload;
  }

  const history = readProviderResumeCursorHistory(input.runtimePayload);
  if (
    history.some(
      (entry) =>
        entry.providerName === input.providerName &&
        Equal.equals(entry.resumeCursor, input.previousResumeCursor),
    )
  ) {
    return input.runtimePayload;
  }

  return {
    ...(Predicate.isObject(input.runtimePayload) ? input.runtimePayload : {}),
    [HISTORY_KEY]: [
      ...history,
      {
        providerName: input.providerName,
        resumeCursor: input.previousResumeCursor,
      },
    ],
  };
}
