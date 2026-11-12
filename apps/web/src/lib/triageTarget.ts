/**
 * The machine triage runs on: the one on screen, else the primary if it
 * supports triage, else the first connected machine that does. Without No
 * project threads the action still shows and explains the terminal fallback,
 * so this does not check for them.
 */
export function pickTriageEnvironment<Id extends string>(input: {
  readonly onScreen: Id | null;
  readonly primary: Id | null;
  readonly connected: ReadonlyArray<Id>;
  readonly supportsTriage: (environmentId: Id) => boolean;
}): Id | null {
  if (input.onScreen !== null) return input.onScreen;
  if (input.primary !== null && input.supportsTriage(input.primary)) return input.primary;
  return input.connected.find(input.supportsTriage) ?? null;
}
