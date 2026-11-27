import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
  OrchestrationV2ProviderRef,
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderApprovalPushHooks,
  ProviderApprovalDecision,
  ProviderRequestKind,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { parseThreadKey, threadKey } from "./entities.ts";
import { getProjectionArrayReplacementIndex } from "./orchestrationV2Projection.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import * as DateTime from "effect/DateTime";
import type { AtomCommandResult } from "./runtime.ts";
import type { ThreadStructure, ThreadStructureVisibleTurnItem } from "./models.ts";
import { turnItemDetailRevision } from "../work-log/itemDetail.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type ApprovalResponder = (
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
  feedback?: string,
) => Promise<AtomCommandResult<unknown, unknown> | undefined>;

/** Feedback belongs to the displayed request, which may be a native child's tool call. */
export async function sendApprovalFeedback(
  approval: ThreadPendingApproval,
  feedback: string,
  respond: ApprovalResponder,
): Promise<boolean> {
  if (!approval.supportsFeedback || approval.responseCapability !== "live" || !feedback.trim())
    return false;
  return (await respond(approval.requestId, "decline", feedback.trim()))?._tag === "Success";
}

/** Declines every approval a redirect replaces; any one still pending would block the agent. */
export async function declinePendingApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
  respond: ApprovalResponder,
): Promise<boolean> {
  for (const approval of approvals) {
    // A request the provider can no longer answer has nothing to decline.
    if (approval.responseCapability !== "live") continue;
    if ((await respond(approval.requestId, "decline"))?._tag !== "Success") return false;
  }
  return true;
}

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly appName?: string;
  /** Set when T3 Code itself asks to run a repository's push hooks; `detail` is the same in one sentence. */
  readonly pushHooks?: ProviderApprovalPushHooks;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  /** Files a file-change approval touches, from the provider item it gates. */
  readonly files?: ReadonlyArray<ThreadPendingApprovalFile>;
  readonly responseCapability: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

export interface ApprovalTextPart {
  readonly text: string;
  /** Set when `text` names a character a screen would not draw. */
  readonly named?: true;
}

// Control, format, separator and ignorable characters draw as nothing or as a blank box, and some
// reorder the text beside them. A line feed and a tab draw as themselves and are not in the set.
const UNDRAWN = /[\0-\x08\x0B-\x1F\x7F-\x9F\p{Zl}\p{Zp}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const UNDRAWN_NAMES: Readonly<Record<string, string>> = {
  "\r": "\\r",
  "\b": "\\b",
  "\u001B": "\\e",
};
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
// The pictographic range also holds code points reserved for emoji that do not exist yet.
const EMOJI = /^\p{Emoji}$/u;
const SKIN_TONE_BASE = /^\p{Emoji_Modifier_Base}$/u;
const JOINER = 0x200d;
const TEXT_SELECTOR = 0xfe0e;
const EMOJI_SELECTOR = 0xfe0f;
const KEYCAP = 0x20e3;

const isSkinTone = (codePoint: number) => codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
// An emoji that is not a skin tone, which only colours the emoji before it.
const isPicture = (codePoint: number) => {
  if (codePoint < 0 || isSkinTone(codePoint)) return false;
  const character = String.fromCodePoint(codePoint);
  return PICTOGRAPH.test(character) && EMOJI.test(character);
};
// A digit, # or *.
const isKeycapBase = (codePoint: number) =>
  (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a;

/** The code point that ends at `end`, or -1 at the start of the text. */
function codePointBefore(text: string, end: number): number {
  if (end <= 0) return -1;
  const unit = text.charCodeAt(end - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && end >= 2) {
    const lead = text.charCodeAt(end - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return text.codePointAt(end - 2) ?? unit;
  }
  return unit;
}

/**
 * Whether the undrawn character at `index` is part of an emoji: a joiner directly between two
 * emoji, or a presentation selector directly after an emoji or in a keycap. It reads at most two
 * code points before the character and one after it.
 */
function isInsideEmoji(text: string, index: number, codePoint: number): boolean {
  if (codePoint !== JOINER && codePoint !== EMOJI_SELECTOR && codePoint !== TEXT_SELECTOR) {
    return false;
  }
  const before = codePointBefore(text, index);
  const after = text.codePointAt(index + 1) ?? -1;
  if (codePoint !== JOINER) {
    return (
      isPicture(before) ||
      (codePoint === EMOJI_SELECTOR && isKeycapBase(before) && after === KEYCAP)
    );
  }
  if (!isPicture(after)) return false;
  if (isPicture(before)) return true;
  // The emoji before the joiner may end in its emoji selector or its skin tone.
  const base = codePointBefore(text, index - (before > 0xffff ? 2 : 1));
  if (before === EMOJI_SELECTOR) return isPicture(base);
  return isSkinTone(before) && base >= 0 && SKIN_TONE_BASE.test(String.fromCodePoint(base));
}

export interface ApprovalTextLimit {
  /** UTF-16 units of the text a card shows at most, its beginning and its end together. */
  readonly length: number;
  /** Runs of named characters, each one element in a card, shown at most in the beginning. */
  readonly namedRuns: number;
  /** UTF-16 units of the end of the text shown at most when the text is cut. */
  readonly tailLength: number;
  /** Runs of named characters shown at most in the end. */
  readonly tailNamedRuns: number;
}

// A card draws one element per run of named characters and lays the whole text out at once, so
// both are bounded: measured in Chromium, the web card at these limits renders in about 100 ms,
// and past them the time grows in step with the text. The end comes out of the same 100,000
// units (some 1,250 full lines, 50 of them the end) and adds at most a tenth to the elements.
export const APPROVAL_TEXT_LIMIT: ApprovalTextLimit = {
  length: 100_000,
  namedRuns: 2_000,
  tailLength: 4_000,
  tailNamedRuns: 200,
};

export interface ApprovalTextScan {
  /** The text, or its shown beginning when it is cut. A run of named characters is one part. */
  readonly parts: ReadonlyArray<ApprovalTextPart>;
  /** The shown end of a cut text. Empty when the text is not cut. */
  readonly tail: ReadonlyArray<ApprovalTextPart>;
  /** UTF-16 units of the text that `parts` covers. */
  readonly shownLength: number;
  /** UTF-16 units between the beginning and the end that no part covers. 0 when not cut. */
  readonly hiddenLength: number;
  /** UTF-16 units of the whole text. */
  readonly length: number;
}

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
/** Whether `index` is between the two halves of one code point. */
const splitsCodePoint = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  isLowSurrogate(text.charCodeAt(index)) &&
  isHighSurrogate(text.charCodeAt(index - 1));

/**
 * `shown` in parts, each character a screen would not draw replaced by its name, up to
 * `namedRuns` runs. `starts[i]` is where part `i` begins in `shown` and `stop` where the parts
 * end. One pass: the work per character does not depend on what surrounds it.
 */
function scanApprovalText(shown: string, namedRuns: number) {
  const parts: ApprovalTextPart[] = [];
  const starts: number[] = [];
  let stop = shown.length;
  let end = 0;
  let names = "";
  let namesStart = 0;
  let runs = 0;
  for (const match of shown.matchAll(UNDRAWN)) {
    const [character] = match;
    const codePoint = character.codePointAt(0) ?? 0;
    if (isInsideEmoji(shown, match.index, codePoint)) continue;
    if (match.index > end || names === "") {
      if (runs === namedRuns) {
        stop = match.index;
        break;
      }
      if (names !== "") {
        parts.push({ text: names, named: true });
        starts.push(namesStart);
      }
      if (match.index > end) {
        parts.push({ text: shown.slice(end, match.index) });
        starts.push(end);
      }
      names = "";
      namesStart = match.index;
      runs += 1;
    }
    names +=
      UNDRAWN_NAMES[character] ?? `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    end = match.index + character.length;
  }
  if (names !== "") {
    parts.push({ text: names, named: true });
    starts.push(namesStart);
  }
  if (end < stop) {
    parts.push({ text: shown.slice(end, stop) });
    starts.push(end);
  }
  return { parts, starts, stop };
}

/**
 * Approval text in parts, each character a screen would not draw replaced by its name. Text that
 * passes `limit` is cut in the middle: `parts` is its beginning and `tail` its end, so what the
 * text ends with is always shown. Only the shown text is read, in one pass, and a cut never falls
 * inside a code point.
 */
export function approvalTextParts(
  text: string,
  limit: ApprovalTextLimit = APPROVAL_TEXT_LIMIT,
): ApprovalTextScan {
  const { length } = text;
  const tailLength = Math.max(0, Math.min(limit.tailLength, limit.length));
  let headEnd = length > limit.length ? Math.max(0, limit.length - tailLength) : length;
  if (splitsCodePoint(text, headEnd)) headEnd -= 1;
  const head = scanApprovalText(headEnd < length ? text.slice(0, headEnd) : text, limit.namedRuns);
  if (head.stop === length) {
    return { parts: head.parts, tail: [], shownLength: length, hiddenLength: 0, length };
  }

  let tailStart = Math.max(head.stop, length - tailLength);
  if (splitsCodePoint(text, tailStart)) tailStart += 1;
  const end = scanApprovalText(text.slice(tailStart), Number.POSITIVE_INFINITY);
  // Past its runs the end keeps the last of them: it starts after the run before those.
  let first = 0;
  for (let index = end.parts.length - 1, runs = 0; index >= 0; index -= 1) {
    if (!end.parts[index]?.named) continue;
    if (runs === limit.tailNamedRuns) {
      first = index + 1;
      break;
    }
    runs += 1;
  }
  const tail = first === 0 ? end.parts : end.parts.slice(first);
  tailStart += end.starts[first] ?? end.stop;

  // The end begins where the beginning stopped: nothing is hidden, so the text is not cut.
  if (tailStart === head.stop) {
    return {
      parts: [...head.parts, ...tail],
      tail: [],
      shownLength: length,
      hiddenLength: 0,
      length,
    };
  }
  return {
    parts: head.parts,
    tail,
    shownLength: head.stop,
    hiddenLength: tailStart - head.stop,
    length,
  };
}

export const PUSH_HOOKS_APPROVAL_LABEL = msg("Push hooks approval");
export const PUSH_HOOKS_APPROVAL_QUESTION = msg("Run this repository's push hooks?");

export interface ApprovalDetailRow {
  readonly label: string;
  /** Plain text ahead of the code: a configured hook's name. */
  readonly name?: string;
  /** A branch, file path or command. */
  readonly code: string;
}

/** What a push hooks approval names: the branch, then each hook the push would run. */
export function pushHooksApprovalRows(
  pushHooks: ProviderApprovalPushHooks,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ApprovalDetailRow> {
  return [
    { label: resolve(msg("Branch", { $context: "field label" })), code: pushHooks.branch },
    ...pushHooks.files.map((file) => ({ label: resolve(msg("Hook file")), code: file })),
    ...pushHooks.commands.map(({ name, command }) => ({
      label: resolve(msg("Configured hook", { $context: "a hook Git's configuration defines" })),
      name,
      code: command,
    })),
  ];
}

export const FULL_ACCESS_OVERRIDE_QUESTION = msg("Why am I being asked this?");

export function fullAccessOverrideExplanation(
  override: ProviderApprovalFullAccessOverride,
  resolve: MFunctionType = mFallback,
): string {
  return override === "ask_rule"
    ? resolve(
        msg(
          "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts.",
        ),
      )
    : resolve(
        msg(
          "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. T3 Code can't turn these off, so check the request and approve it if it's what you expect.",
        ),
      );
}

export interface ThreadPendingApprovalFile {
  readonly path: string;
  readonly source?: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly revision: string;
  };
  readonly operation?: string;
  readonly additions?: number;
  readonly deletions?: number;
  /** Unified diff of the proposed change, when the provider sent one. */
  readonly diff?: string;
}

type TurnItems = ThreadStructure["turnItems"];

function sameNativeItem(
  left: OrchestrationV2ProviderRef | null,
  right: OrchestrationV2ProviderRef | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.nativeId !== null &&
    left.driver === right.driver &&
    left.nativeId === right.nativeId
  );
}

/**
 * A file-change approval gates the provider item that carries the patch, and
 * both share the provider's native item ref (Codex item ids, Claude tool use ids).
 */
function approvalFiles(
  turnItems: TurnItems,
  approval: TurnItems[number],
): ThreadPendingApprovalFile[] {
  const files: ThreadPendingApprovalFile[] = [];
  for (const item of turnItems) {
    if (
      item.type !== "file_change" ||
      item.providerTurnId !== approval.providerTurnId ||
      item.providerThreadId !== approval.providerThreadId ||
      !sameNativeItem(item.nativeItemRef, approval.nativeItemRef)
    ) {
      continue;
    }
    const source = {
      threadId: item.threadId,
      itemId: item.id,
      revision: turnItemDetailRevision(item),
    };
    if (item.changes !== undefined && item.changes.length > 1) {
      for (const change of item.changes) {
        files.push({ path: change.path, operation: change.operation, source });
      }
      continue;
    }
    const operation = item.changes?.[0]?.operation;
    files.push({
      path: item.fileName,
      source,
      ...(operation === undefined ? {} : { operation }),
      ...(item.additions === undefined ? {} : { additions: item.additions }),
      ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
      ...(item.diffStr === undefined || item.diffStr.length === 0 ? {} : { diff: item.diffStr }),
    });
  }
  return files;
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  // Entries, not assignment, so an id such as `__proto__` becomes an own draft.
  const seeds = questions.flatMap((question) =>
    question.initialAnswer === undefined ||
    question.allowCustomAnswer === false ||
    Object.hasOwn(drafts, question.id)
      ? []
      : [[question.id, { customAnswer: question.initialAnswer }] as const],
  );
  return seeds.length === 0 ? drafts : { ...drafts, ...Object.fromEntries(seeds) };
}

/** Keys a user-input draft by thread so a thread's resolved requests can be pruned together. */
export function userInputDraftKey(
  environmentId: string,
  threadId: string | null,
  requestId: string | undefined,
): string {
  return JSON.stringify([environmentId, threadId, requestId]);
}

/**
 * Drops the thread's drafts for requests outside `pendingRequestIds`, leaving
 * other threads alone. Returns the input itself when nothing is dropped.
 */
export function pruneResolvedUserInputDrafts<T>(
  draftsByRequestKey: Record<string, T>,
  environmentId: string,
  threadId: string,
  pendingRequestIds: ReadonlyArray<string>,
): Record<string, T> {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  const pendingKeys = new Set(
    pendingRequestIds.map((requestId) => userInputDraftKey(environmentId, threadId, requestId)),
  );
  const retained = Object.entries(draftsByRequestKey).filter(
    ([key]) => !key.startsWith(threadPrefix) || pendingKeys.has(key),
  );
  return retained.length === Object.keys(draftsByRequestKey).length
    ? draftsByRequestKey
    : Object.fromEntries(retained);
}

/**
 * Question attachment drafts are keyed `<thread prefix><encoded [requestId, questionId]>`.
 * Returns the keys under `threadPrefix` whose request is outside `pendingRequestIds`.
 */
export function resolvedQuestionDraftKeys(
  keys: Iterable<string>,
  threadPrefix: string,
  pendingRequestIds: ReadonlyArray<string>,
): string[] {
  // encodeURIComponent is per character, so an encoded JSON prefix prefixes the encoded key.
  const pendingPrefixes = pendingRequestIds.map(
    (requestId) =>
      `${threadPrefix}${encodeURIComponent(`${JSON.stringify([requestId]).slice(0, -1)},`)}`,
  );
  const resolved: string[] = [];
  for (const key of keys) {
    if (key.startsWith(threadPrefix) && !pendingPrefixes.some((prefix) => key.startsWith(prefix)))
      resolved.push(key);
  }
  return resolved;
}

export interface ThreadRequestsResolved {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Every request the thread still waits on; drafts for any other request are stale. */
  readonly pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
  /** Requests that closed without an answer (cancelled or expired), so typed drafts were never sent. */
  readonly unansweredRequestIds: ReadonlyArray<RuntimeRequestId>;
}

const threadRequestsResolvedListeners = new Set<(event: ThreadRequestsResolved) => void>();

/**
 * Clients register draft pruners once at module level. Thread state announces
 * when its synchronized projection first lands and whenever a request leaves
 * pending, wherever the resolution came from (another device, interrupt, turn end).
 */
export function onThreadRequestsResolved(
  listener: (event: ThreadRequestsResolved) => void,
): () => void {
  threadRequestsResolvedListeners.add(listener);
  return () => threadRequestsResolvedListeners.delete(listener);
}

function notifyThreadRequestsResolved(event: ThreadRequestsResolved): void {
  for (const listener of threadRequestsResolvedListeners) {
    try {
      listener(event);
    } catch (error) {
      // A failing pruner must neither stop the others nor break thread sync.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/**
 * Tracks one thread's announced pending requests. Feed it the runtime requests
 * of each authoritative projection; it notifies on the first one and whenever an
 * announced request is no longer pending. New requests alone stay quiet.
 */
export function makeThreadRequestsResolvedAnnouncer(
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  let announced: ReadonlySet<RuntimeRequestId> | null = null;
  return (
    runtimeRequests: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["runtimeRequests"][number], "id" | "status">
    >,
  ) => {
    const pendingRequestIds = runtimeRequests.flatMap((request) =>
      request.status === "pending" ? [request.id] : [],
    );
    const pending = new Set(pendingRequestIds);
    const resolvedSome = announced === null || [...announced].some((id) => !pending.has(id));
    announced = pending;
    if (!resolvedSome) return;
    const unansweredRequestIds = runtimeRequests.flatMap((request) =>
      request.status === "cancelled" || request.status === "expired" ? [request.id] : [],
    );
    notifyThreadRequestsResolved({
      environmentId,
      threadId,
      pendingRequestIds,
      unansweredRequestIds,
    });
  };
}

export function derivePendingThreadRequests(
  projection: Pick<ThreadStructure, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const files =
      request.kind === "file-change" && item !== undefined
        ? approvalFiles(projection.turnItems, item)
        : [];
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.reason ? { reason: item.reason } : {}),
      ...(item?.type === "approval_request" && item.fullAccessOverride
        ? { fullAccessOverride: item.fullAccessOverride }
        : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.pushHooks ? { pushHooks: item.pushHooks } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      ...(files.length > 0 ? { files } : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
      ...(request.responseCapability.type === "live" && request.responseCapability.supportsFeedback
        ? { supportsFeedback: true }
        : {}),
    });
  }

  return { approvals, userInputs };
}

export function createQuestionHistoryProjector<
  Row extends ThreadStructureVisibleTurnItem =
    OrchestrationV2ThreadProjection["visibleTurnItems"][number],
>() {
  type Rows = ReadonlyArray<Row>;
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  let byId = new Map<RuntimeRequestId, Requests[number]>();
  const cache = new WeakMap<Row, { request: Requests[number]; row: Row }>();
  const projectRow = (row: Row): Row => {
    const item = row.item;
    if (item.type !== "user_input_request" || item.questionAnswer) return row;
    const request = byId.get(item.requestId);
    if (request?.status !== "resolved" || request.answers === undefined) return row;
    const cached = cache.get(row);
    const next: Row =
      cached?.request === request
        ? cached.row
        : {
            ...row,
            item: {
              ...item,
              questionAnswer: {
                requestId: request.id,
                answers: request.answers,
                attachmentsByQuestionId: {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            },
          };
    cache.set(row, { request, row: next });
    return next;
  };
  const projectRows = (rows: Rows): Rows => {
    let result: Row[] | undefined;
    for (const [index, row] of rows.entries()) {
      const next = projectRow(row);
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    return result ?? rows;
  };
  return (projection: {
    readonly visibleTurnItems: Rows;
    readonly runtimeRequests: Requests;
  }): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    const sameRequests = requests === previousRequests;
    if (rows === previousRows && sameRequests && previousResult) return previousResult;
    if (!sameRequests) byId = new Map(requests.map((request) => [request.id, request]));
    // Nothing was overlaid and requests are unchanged, so only an exactly replaced row can differ.
    const replacedIndex =
      sameRequests && previousRows !== undefined && previousResult === previousRows
        ? getProjectionArrayReplacementIndex(previousRows, rows)
        : undefined;
    const unchanged =
      replacedIndex !== undefined && projectRow(rows[replacedIndex]!) === rows[replacedIndex];
    previousRows = rows;
    previousRequests = requests;
    previousResult = unchanged ? rows : projectRows(rows);
    return previousResult;
  };
}

export interface ChildThreadApproval {
  readonly thread: ScopedThreadRef;
  readonly title: string;
  readonly approval: ThreadPendingApproval;
}

export function createChildThreadApprovalsAtom(input: {
  readonly childThreadInputsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly pendingRequestsAtom: (ref: ScopedThreadRef) => Atom.Atom<PendingThreadRequests | null>;
}) {
  const family = Atom.family((key: string) => {
    let previous: ReadonlyArray<ChildThreadApproval> = [];
    return Atom.make((get) => {
      const next = get(input.childThreadInputsAtom(parseThreadKey(key))).flatMap((child) => {
        if (!child.hasPendingApprovals) return [];
        const thread = { environmentId: child.environmentId, threadId: child.id };
        // Only children asking for approval need a detail subscription.
        return (get(input.pendingRequestsAtom(thread))?.approvals ?? []).map((approval) => ({
          thread,
          title: child.title,
          approval,
        }));
      });
      if (
        next.length === previous.length &&
        next.every((entry, index) => {
          const old = previous[index]!;
          return (
            old.approval === entry.approval &&
            old.title === entry.title &&
            threadKey(old.thread) === threadKey(entry.thread)
          );
        })
      )
        return previous;
      previous = next;
      return next;
    });
  });
  const empty = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);
  return (ref: ScopedThreadRef | null) => (ref === null ? empty : family(threadKey(ref)));
}
