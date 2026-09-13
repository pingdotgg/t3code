import {
  MESSAGE_ARTIFACT_MAX_COUNT,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2MessageArtifact,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const ARTIFACT_FENCE_INFO_PATTERN = /^t3-artifact(?:\s|$)/iu;
const ARTIFACT_PATH_MAX_LENGTH = 1024;

/** A `t3-artifact` fence: its source range, the HTML path it names, and its artifact position. */
export interface MessageArtifactFence {
  readonly start: number;
  readonly end: number;
  readonly path: string;
  readonly sourceOrdinal: number;
}

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const raw of markdown.split("\n")) {
    const end = start + raw.length;
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start, end });
    start = end + 1;
  }
  return lines;
}

/** Accepts only workspace-relative HTML paths: no root, drive, scheme, share, or parent segment. */
function parseArtifactPath(body: string): string | null {
  const path = body.trim();
  if (path.length === 0 || path.length > ARTIFACT_PATH_MAX_LENGTH || /[:?#]/u.test(path)) {
    return null;
  }
  const segments = path.split(/[\\/]/u);
  if (segments[0] === "" || segments.includes("..")) return null;
  return /\.html?$/iu.test(path) ? path : null;
}

/**
 * Finds up to `MESSAGE_ARTIFACT_MAX_COUNT` `t3-artifact` fences in source order. The server copies
 * and clients render by the same ordinal. Only fences that start a line count, so examples inside
 * another fence or a list item stay code.
 */
export function findMessageArtifactFences(markdown: string): MessageArtifactFence[] {
  const lines = sourceLines(markdown);
  const fences: MessageArtifactFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opener = CODE_FENCE_PATTERN.exec(line.text);
    const marker = opener?.[1];
    if (opener === null || marker === undefined) continue;

    let closing = index + 1;
    for (; closing < lines.length; closing += 1) {
      const candidate = CODE_FENCE_PATTERN.exec(lines[closing]!.text);
      const candidateMarker = candidate?.[1];
      if (
        candidate !== null &&
        candidateMarker !== undefined &&
        candidateMarker[0] === marker[0] &&
        candidateMarker.length >= marker.length &&
        lines[closing]!.text.slice(candidate[0].length).trim() === ""
      ) {
        break;
      }
    }
    if (closing === lines.length) break;

    const info = line.text.slice(opener[0].length).trim();
    const path =
      line.text.startsWith(marker) &&
      ARTIFACT_FENCE_INFO_PATTERN.test(info) &&
      closing === index + 2
        ? parseArtifactPath(lines[index + 1]!.text)
        : null;
    if (path !== null && fences.length < MESSAGE_ARTIFACT_MAX_COUNT) {
      fences.push({
        start: line.start,
        end: lines[closing]!.end,
        path,
        sourceOrdinal: fences.length,
      });
    }
    index = closing;
  }
  return fences;
}

type MessageArtifacts = ReadonlyArray<OrchestrationV2MessageArtifact>;

/**
 * Keeps a message's or assistant item's recorded `artifacts` when a provider re-publishes it
 * without them, like `delegatedCompletion` on runs.
 */
export function preserveMessageArtifacts<T extends object>(
  current: object | undefined,
  next: T,
): T {
  if ("artifacts" in next || current === undefined || !("artifacts" in current)) return next;
  return { ...next, artifacts: current.artifacts };
}

/**
 * Applies `message.artifacts-recorded` to a thread projection: replaces the `artifacts` of the
 * message and of every `assistant_message` turn item showing it.
 */
export function recordMessageArtifacts<
  P extends {
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  },
>(projection: P, messageId: MessageId, artifacts: MessageArtifacts): P {
  const record = (item: OrchestrationV2TurnItem): OrchestrationV2TurnItem =>
    item.type === "assistant_message" && item.messageId === messageId
      ? { ...item, artifacts }
      : item;
  return {
    ...projection,
    messages: projection.messages.map((message) =>
      message.id === messageId ? { ...message, artifacts } : message,
    ),
    turnItems: projection.turnItems.map(record),
    visibleTurnItems: projection.visibleTurnItems.map((row) => {
      const item = record(row.item);
      return item === row.item ? row : { ...row, item };
    }),
  };
}
