export interface TeamAppMessageRulesInput {
  readonly body: string;
  readonly isThreadMuted: boolean;
  readonly mentionsAiEngineer?: boolean;
}

export interface TeamAppMessageDecision {
  readonly ignore: boolean;
  readonly reason?: "aside" | "muted";
}

export interface TeamAppMuteCommandResult {
  readonly muted: boolean;
  readonly changed: boolean;
  readonly command?: "mute" | "unmute";
}

const ASIDE_PREFIX_PATTERN = /^\s*-\s+aside\b(?::|\s|$)/i;
const UNMUTE_COMMAND_PATTERN =
  /\b(unmute|resume replies|resume updates|start responding|turn (?:the )?ai engineer back on)\b/i;
const MUTE_COMMAND_PATTERN =
  /\b(mute|stop replying|stop responding|stop updates|pause replies|pause updates|quiet)\b/i;

export function isAsideTeamAppMessage(body: string): boolean {
  return ASIDE_PREFIX_PATTERN.test(body);
}

export function shouldIgnoreTeamAppMessage(
  input: TeamAppMessageRulesInput,
): TeamAppMessageDecision {
  if (isAsideTeamAppMessage(input.body)) {
    return { ignore: true, reason: "aside" };
  }

  if (
    input.isThreadMuted &&
    input.mentionsAiEngineer !== true &&
    detectTeamAppMuteCommand(input.body) !== "unmute"
  ) {
    return { ignore: true, reason: "muted" };
  }

  return { ignore: false };
}

export function applyTeamAppMuteCommand(input: {
  readonly body: string;
  readonly isThreadMuted: boolean;
}): TeamAppMuteCommandResult {
  const command = detectTeamAppMuteCommand(input.body);

  if (command === undefined) {
    return { muted: input.isThreadMuted, changed: false };
  }

  const muted = command === "mute";
  return {
    muted,
    changed: muted !== input.isThreadMuted,
    command,
  };
}

function detectTeamAppMuteCommand(body: string): "mute" | "unmute" | undefined {
  const normalized = body.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (UNMUTE_COMMAND_PATTERN.test(normalized)) {
    return "unmute";
  }

  if (MUTE_COMMAND_PATTERN.test(normalized)) {
    return "mute";
  }

  return undefined;
}
