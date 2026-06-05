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

const ASIDE_PREFIX_PATTERN = /^\s*aside\s*-\s*/i;
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
  readonly mentionsAiEngineer?: boolean;
}): TeamAppMuteCommandResult {
  if (input.mentionsAiEngineer !== true) {
    return { muted: input.isThreadMuted, changed: false };
  }

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

export function teamAppMuteCommandReaction(command: "mute" | "unmute") {
  return command === "mute" ? "zipper_mouth_face" : "speaker";
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

export function mentionsTeamAppUser(input: {
  readonly body: string;
  readonly botUserId?: string | undefined;
  readonly botUserName?: string | undefined;
}) {
  const body = input.body;
  const botUserId = input.botUserId?.trim();
  if (botUserId && body.includes(`<@${botUserId}>`)) {
    return true;
  }
  if (botUserId && new RegExp(`(^|\\s)@${botUserId}\\b`, "i").test(body)) {
    return true;
  }

  const names = new Set(["Vevin"]);
  const botUserName = input.botUserName?.trim();
  if (botUserName) {
    names.add(botUserName);
  }

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)@${escaped}\\b`, "i").test(body)) {
      return true;
    }
  }

  return false;
}

export function mentionsNonTeamAppSlackUser(input: {
  readonly body: string;
  readonly botUserId?: string | undefined;
}) {
  const botUserId = input.botUserId?.trim();
  const mentionedUserIds = new Set<string>();

  for (const match of input.body.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    const userId = match[1];
    if (userId) {
      mentionedUserIds.add(userId);
    }
  }

  for (const match of input.body.matchAll(/(^|\s)@([UW][A-Z0-9]+)\b/g)) {
    const userId = match[2];
    if (userId) {
      mentionedUserIds.add(userId);
    }
  }

  const displayNameMention = /(^|\s)@[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)+/u.test(input.body);

  for (const userId of mentionedUserIds) {
    if (botUserId === undefined || userId !== botUserId) {
      return true;
    }
  }

  return displayNameMention;
}
