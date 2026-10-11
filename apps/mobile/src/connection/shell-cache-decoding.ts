import { StoredOrchestrationShellSnapshot } from "@t3tools/client-runtime/platform";
import { deferPullRequests, detachPullRequests } from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStoredShell = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);

/**
 * Decode the shell cache payload with each thread's pull request links left out, so the
 * thread list can paint first; `loadPullRequests` decodes the links afterwards.
 */
export const decodeStoredShellSnapshot = Effect.fnUntraced(function* (raw: string) {
  const parsed = yield* decodeJson(raw);
  const rawLinks = Predicate.isObject(parsed) ? detachPullRequests(parsed.snapshot) : [];
  const stored = yield* decodeStoredShell(parsed);
  return { ...stored, snapshot: deferPullRequests(stored.snapshot, rawLinks) };
});
