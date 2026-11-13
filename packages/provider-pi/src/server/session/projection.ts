/**
 * Pi branch and snapshot projection: session listings, fork boundaries and RPC question shapes.
 */
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import { PI_PROVIDER, contentText } from "../adapter.ts";
import type { PendingPiPrompt } from "../adapter.ts";

export interface PiSessionEntry {
readonly parentId: string | null;
readonly isUserMessage: boolean;
/** Pi's `timestamp` as epoch milliseconds; null when missing or unparsable. */
readonly timestamp: number | null;
}

export interface PiSessionListing {
readonly entries: ReadonlyMap<string, PiSessionEntry>;
readonly leafId: string | null;
}

export function piSessionListing(data: unknown): PiSessionListing | null {
const leafId = recordField(data, "leafId");
const entries = piSessionEntries(recordField(data, "entries"));
return entries !== null && (typeof leafId === "string" || leafId === null)
  ? { entries, leafId }
  : null;
}

export function piSessionEntries(entries: unknown): ReadonlyMap<string, PiSessionEntry> | null {
const byId = new Map<string, PiSessionEntry>();
if (!Array.isArray(entries)) return null;
for (const entry of entries) {
  const id = recordString(entry, "id");
  const parentId = recordField(entry, "parentId");
  if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
    return null;
  const timestamp = recordString(entry, "timestamp");
  byId.set(id, {
    parentId,
    isUserMessage:
      recordField(entry, "type") === "message" &&
      recordString(recordField(entry, "message"), "role") === "user",
    timestamp:
      timestamp === undefined
        ? null
        : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
  });
}
return byId;
}

export function walkPiBranch(
entries: ReadonlyMap<string, PiSessionEntry>,
leafId: string | null,
stopAt: string | null,
): {
readonly entryCount: number;
readonly userEntryIds: ReadonlyArray<string>;
readonly reachedStop: boolean;
} | null {
const visited = new Set<string>();
const userEntryIds: Array<string> = [];
let current = leafId;
while (current !== null && current !== stopAt) {
  const entry = entries.get(current);
  if (entry === undefined) break;
  if (visited.has(current)) return null;
  visited.add(current);
  if (entry.isUserMessage) userEntryIds.push(current);
  current = entry.parentId;
}
return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

export type PiForkBoundary =
| { readonly type: "entry"; readonly entryId: string }
| { readonly type: "nothing" }
| {
    readonly type: "uncaptured";
    readonly turn: OrchestrationV2ProviderTurn;
    readonly target: OrchestrationV2ProviderTurn | null;
  };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `piForkEntry` locates it in the session tree.
 */
export function piForkBoundary(input: {
readonly target:
  | { readonly type: "thread_start" }
  | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): PiForkBoundary {
const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
const boundary = input.providerThreadTurns
  .filter((turn) => turn.ordinal > (target?.ordinal ?? 0) && turn.nativeTurnRef !== null)
  .sort((a, b) => a.ordinal - b.ordinal)[0];
const ref = boundary?.nativeTurnRef;
if (boundary === undefined || ref == null) return { type: "nothing" };
return ref.strength === "strong" && ref.nativeId !== null
  ? { type: "entry", entryId: ref.nativeId }
  : { type: "uncaptured", turn: boundary, target };
}

/** Reads the session tree only for an uncaptured boundary. */
export function piForkEntry<E>(
boundary: Exclude<PiForkBoundary, { type: "nothing" }>,
providerThreadCreatedAt: DateTime.Utc,
readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<string, E | ProviderAdapter.ProviderAdapterProtocolError> {
if (boundary.type === "entry") return Effect.succeed(boundary.entryId);
return readEntries.pipe(
  Effect.flatMap((data) => {
    const listing = piSessionListing(data);
    const entryId =
      listing === null
        ? undefined
        : piUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
    return entryId === undefined
      ? Effect.fail(
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: PI_PROVIDER,
            detail: `Pi turn ${boundary.turn.ordinal} has no captured session-tree entry and none was found in the session tree`,
          }),
        )
      : Effect.succeed(entryId);
  }),
);
}

/**
 * Pi shares the server clock. An adopted wake can precede its T3 turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
export function piUncapturedForkEntry(
listing: PiSessionListing,
boundary: Extract<PiForkBoundary, { type: "uncaptured" }>,
providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
const { startedAt, completedAt } = boundary.turn;
if (startedAt === null) return undefined;
const from =
  boundary.target === null
    ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
    : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
const targetRef = boundary.target?.nativeTurnRef;
const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
const walk = walkPiBranch(listing.entries, listing.leafId, stopAt);
if (walk === null || !walk.reachedStop) return undefined;
let earliest: string | undefined;
for (const id of walk.userEntryIds) {
  const timestamp = listing.entries.get(id)?.timestamp;
  if (timestamp == null) return undefined;
  if (timestamp >= from && timestamp <= to) earliest = id;
}
return earliest;
}

export function piSubagentOutput(result: unknown): string {
const stopReason = recordString(result, "stopReason");
const failed =
  (recordNumber(result, "exitCode") ?? 0) !== 0 ||
  stopReason === "error" ||
  stopReason === "aborted";
if (failed) {
  const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
  if (failure !== undefined && failure.length > 0) return failure;
}
const messages = recordField(result, "messages");
if (!Array.isArray(messages)) return "";
for (let index = messages.length - 1; index >= 0; index -= 1) {
  const message = messages[index];
  if (recordString(message, "role") !== "assistant") continue;
  const text = contentText(recordField(message, "content"));
  if (text.length > 0) return text;
}
return "";
}

export function piExtensionDisplayName(extensionPath: string | undefined): string {
if (extensionPath === undefined) return "Pi extension";
const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
// Pi loads a directory extension from its index file; the folder names it.
const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
return name.length === 0 ? "Pi extension" : name;
}

export function piThreadSnapshot(
providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

export function piQuestion(
questionId: string,
method: "select" | "input" | "editor",
title: string,
event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
const options =
  method === "select" && Array.isArray(event["options"])
    ? event["options"]
        .filter((option): option is string => typeof option === "string")
        .map((option) => ({
          label: option || "Empty value",
          description: option || "Empty value",
          value: option,
        }))
    : method === "editor"
      ? []
      : [
          {
            label: "Submit empty value",
            description: "Send an empty string to the extension.",
            value: "",
          },
        ];
// Pi's select and editor dialogs carry only a title, so show it once, as the question.
// Extensions may send a blank placeholder, which is not a valid question.
const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
  (text) => text !== undefined && text.trim().length > 0,
);
return {
  id: questionId,
  header: detail === undefined ? "Question" : title,
  question: detail ?? title,
  ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
  options,
};
}

export function piUiResponse(
pending: PendingPiPrompt,
decision: ProviderApprovalDecision | undefined,
answers: Record<string, unknown> | undefined,
): PiRpcRecord {
if (pending.method === "confirm") {
  if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
  if (decision === "decline") return { confirmed: false };
  return { cancelled: true };
}
const answer = answers?.[pending.questionId];
// RPC distinguishes empty dialog values from cancellation (undefined).
if (typeof answer === "string") return { value: answer };
return { cancelled: true };
}
