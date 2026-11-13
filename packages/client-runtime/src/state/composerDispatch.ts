export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as an explicit /compact. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

// Automatic compaction takes steers only where the provider says a steer leaves it running.
export function compactionBlocksSteering(input: {
  readonly compactCommandIsActive: boolean;
  readonly compactionRunning: boolean;
  readonly steersDuringCompaction: boolean;
  readonly run: { readonly userMessageId: string } | undefined;
  readonly messages:
    | ReadonlyArray<{
        readonly id: string;
        readonly text: string;
        readonly attachments?: ReadonlyArray<unknown>;
      }>
    | undefined;
}): boolean {
  if (input.compactCommandIsActive) return true;
  if (!input.compactionRunning) return false;
  if (!input.steersDuringCompaction) return true;
  if (input.run === undefined) return false;
  const message = input.messages?.find((message) => message.id === input.run?.userMessageId);
  return (
    (message?.attachments?.length ?? 0) === 0 &&
    /^\/compact(?:\s|$)/i.test(message?.text.trim() ?? "")
  );
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
