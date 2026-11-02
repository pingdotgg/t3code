/**
 * The machine triage runs on: the one on screen, else the first connected
 * machine whose server supports triage. The palette row names the pick.
 */
export function pickTriageEnvironment<Id extends string>(input: {
  readonly onScreen: Id | null;
  readonly connected: ReadonlyArray<Id>;
  readonly supportsTriage: (environmentId: Id) => boolean;
}): Id | null {
  return input.onScreen ?? input.connected.find(input.supportsTriage) ?? null;
}
