import {
  type OrchestratorMcpFailure,
  OrchestratorMcpThreadReadResult,
  type PeerLinkThreadPage,
  PeerLinkThreadReadError,
  type PeerLinkThreadReadInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A client has no agent modes to pass on, so its read carries the narrowest ones. The linked
 * environment holds every call to those, and this service only ever calls its read tool.
 */
export const CLIENT_READ_LIMITS: PeerMcpClient.PeerCallLimits = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

const PAGE_ITEMS = 50;
const ITEM_MAX_CHARS = 20_000;
/** A linked caller's cursorless read starts at the thread's first item, so the newest page asks from the end. */
const NEWEST = Number.MAX_SAFE_INTEGER;

/**
 * Reads a linked environment's threads for a client of this environment, over the link this
 * environment already holds. `PeerForwarding` is the agent's path; a client has no thread or
 * modes of its own, so this one checks only the link and reads.
 */
export class PeerThreadReader extends Context.Service<
  PeerThreadReader,
  {
    /** One bounded page of the thread's transcript, with the thread's current status. */
    readonly read: (
      input: PeerLinkThreadReadInput,
    ) => Effect.Effect<PeerLinkThreadPage, PeerLinkThreadReadError>;
  }
>()("t3/peer/PeerThreadReader") {}

const reasonOf = (failure: OrchestratorMcpFailure): PeerLinkThreadReadError["reason"] =>
  failure.code === "thread_not_found"
    ? "thread_not_found"
    : failure.code === "capability_denied" || failure.code === "invalid_request"
      ? "rejected"
      : "unreachable";

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;

  const read: PeerThreadReader["Service"]["read"] = Effect.fn("PeerThreadReader.read")(
    function* (input) {
      if (!(yield* links.enabled)) {
        return yield* new PeerLinkThreadReadError({
          reason: "disabled",
          label: null,
          message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
        });
      }
      const link = yield* links.get(input.environmentId).pipe(
        Effect.mapError(
          (error) =>
            new PeerLinkThreadReadError({
              reason: "unreachable",
              label: null,
              message: error.message,
            }),
        ),
      );
      if (Option.isNone(link)) {
        return yield* new PeerLinkThreadReadError({
          reason: "unknown_link",
          label: null,
          message: "This environment is no longer linked to the one this thread is on.",
        });
      }
      const { label, expiresAt } = link.value;
      if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
        return yield* new PeerLinkThreadReadError({
          reason: "expired",
          label,
          message: `The link to ${label} expired. Link it again with a new pairing code from ${label}.`,
        });
      }
      const backwards = input.afterPosition === undefined;
      const page = yield* peers
        .call({
          environmentId: input.environmentId,
          tool: "t3_thread_read",
          arguments: {
            threadId: input.threadId,
            view: "activity",
            limit: PAGE_ITEMS,
            maxCharsPerItem: ITEM_MAX_CHARS,
            runLimit: 1,
            ...(backwards
              ? { beforePosition: input.beforePosition ?? NEWEST }
              : {
                  afterPosition: input.afterPosition,
                  ...(input.beforePosition === undefined
                    ? {}
                    : { beforePosition: input.beforePosition }),
                }),
          },
          limits: CLIENT_READ_LIMITS,
          success: OrchestratorMcpThreadReadResult,
        })
        .pipe(
          Effect.mapError(
            (failure) =>
              new PeerLinkThreadReadError({
                reason: reasonOf(failure),
                label,
                message: failure.message,
              }),
          ),
        );
      // A version that only reads forward ignores `beforePosition` and answers from the start.
      if (backwards && page.earlierPosition === undefined) {
        return yield* new PeerLinkThreadReadError({
          reason: "incompatible",
          label,
          message: `${label} runs a T3 Code version that cannot page a thread from its end. Update it to read its threads from here.`,
        });
      }
      return {
        label,
        thread: {
          threadId: page.thread.threadId,
          title: page.thread.title,
          status: page.thread.status,
          model: page.thread.model,
        },
        items: page.items,
        earlierPosition: page.earlierPosition ?? null,
        hasMore: page.hasMore,
      };
    },
  );

  return PeerThreadReader.of({ read });
});

export const layer = Layer.effect(PeerThreadReader, make);
