import { parseGoalCommand, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export type ThreadGoalCommand =
  | { readonly action: "show" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly goal: string };

const SEPARATOR = "\\p{White_Space}";
const COMMAND = new RegExp(`^/goal(?:${SEPARATOR}+([\\s\\S]*))?$`, "iu");
const LEADING = new RegExp(`^${SEPARATOR}+`, "u");
const TRAILING = new RegExp(`${SEPARATOR}+$`, "u");

function trimGoalWhitespace(text: string): string {
  return text.replace(LEADING, "").replace(TRAILING, "");
}

/** Recognizes only T3's standard goal commands. Restricted experiments stay deferred. */
export function parseThreadGoalCommand(text: string): ThreadGoalCommand | null {
  const match = COMMAND.exec(trimGoalWhitespace(text));
  if (!match) return null;
  const rest = trimGoalWhitespace(match[1] ?? "");
  if (rest === "") return { action: "show" };
  if (/^clear$/i.test(rest)) return { action: "clear" };
  return { action: "set", goal: rest };
}

type GoalMessage = {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
};

/** The provider's native clear, pause, or resume; the provider goal banner sends these. */
export function isProviderGoalControl(message: GoalMessage): boolean {
  const type = parseGoalCommand(message)?.type;
  return type === "clear" || type === "pause" || type === "resume";
}

/** True when `/goal` text must stay out of provider turns: all but a control of a live provider goal. */
export function isBlockedGoalText(
  message: GoalMessage,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
): boolean {
  if (parseThreadGoalCommand(message.text) === null) return false;
  const providerGoal = projection.providerThreads.find(
    (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
  )?.goal;
  return providerGoal == null || !isProviderGoalControl(message);
}
