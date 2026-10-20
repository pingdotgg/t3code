/**
 * PeerLinkRequests - links an agent asks the user to make.
 *
 * The agent rarely knows where the user's machines answer, so it usually
 * names none: the user picks the machine in a card, along with the access,
 * and their client answers with the addresses it knows for that machine and
 * a pairing code from it, which the client mints with its own session there
 * or the user pastes. The code goes straight
 * to `PeerLinks.link` and is never recorded, so it never reaches the
 * transcript, projections, or the agent's context.
 *
 * Asking does not wait: provider CLIs abandon a tool call after a few
 * minutes, and a person may answer much later. The card stays open until the
 * user answers it or stops or archives the thread, and the answer reaches the
 * agent as a notification in its thread.
 *
 * @module PeerLinkRequests
 */
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type NodeId,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpEnvironmentLinkInput,
  type OrchestratorMcpEnvironmentLinkResult,
  OrchestratorMcpFailure,
  type PeerLink,
  PeerLinkError,
  PeerLinkRequestError,
  type PeerLinkRequestAnswerInput,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";

type LinkRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>;

/** The request as it was asked, which every update of its card repeats. */
type LinkRequestAsk = Pick<
  LinkRequestItem,
  "id" | "threadId" | "url" | "reason" | "environmentId" | "label" | "hint" | "requestedAccess"
> & { readonly runId: RunId; readonly nodeId: NodeId };

/** The notification that tells the agent how its card ended. */
type LinkRequestWake = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
};

/** What a card update may change. */
type LinkRequestOutcome = Pick<
  LinkRequestItem,
  "linkStatus" | "linkedEnvironmentId" | "linkedLabel" | "linkedAccess" | "failure"
>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

export class PeerLinkRequests extends Context.Service<
  PeerLinkRequests,
  {
    /**
     * Shows a link card in the calling thread and returns at once. A retry
     * with the same clientRequestId returns the card's current outcome.
     */
    readonly request: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpEnvironmentLinkInput,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinkResult, OrchestratorMcpFailure>;
    /**
     * Answers a pending card and tells the agent. Linking uses the pairing
     * code once; a link the other environment refuses closes the card as
     * failed, with its reason.
     */
    readonly answer: (
      input: PeerLinkRequestAnswerInput,
    ) => Effect.Effect<void, PeerLinkRequestError>;
  }
>()("t3/peer/PeerLinkRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const crypto = yield* Crypto.Crypto;

  const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
    threadManagement
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["link_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          // A deleted thread's cards went with it.
          return item?.type === "link_request" && records.thread.deletedAt === null
            ? item
            : undefined;
        }),
      );

  /**
   * The stored link to `environmentId`, or nothing once it has expired: an
   * expired link needs a new pairing code, which only the card asks for.
   */
  const usableLink = (environmentId: EnvironmentId) =>
    Effect.all([peerLinks.get(environmentId), DateTime.now]).pipe(
      Effect.map(([linked, now]) =>
        Option.filter(linked, (link) => DateTime.isGreaterThan(link.expiresAt, now)),
      ),
    );

  const record = (
    card: LinkRequestAsk,
    outcome: LinkRequestOutcome,
    commandId: CommandId,
    wake?: LinkRequestWake,
  ) =>
    threadManagement.dispatch({
      type: "link_request.record",
      commandId,
      threadId: card.threadId,
      runId: card.runId,
      nodeId: card.nodeId,
      turnItemId: card.id,
      ...(card.url === undefined ? {} : { url: card.url }),
      reason: card.reason,
      ...(card.environmentId === undefined ? {} : { environmentId: card.environmentId }),
      ...(card.label === undefined ? {} : { label: card.label }),
      ...(card.hint === undefined ? {} : { hint: card.hint }),
      ...(card.requestedAccess === undefined ? {} : { requestedAccess: card.requestedAccess }),
      ...outcome,
      ...(wake === undefined ? {} : { wake }),
    });

  const request: PeerLinkRequests["Service"]["request"] = Effect.fn("PeerLinkRequests.request")(
    function* (scope, input) {
      // The card is shown in, and answered from, the caller's own thread.
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        scope,
        "t3_environment_link",
      );
      const threadId = threadScope.thread.threadId;
      const unreadable = (error: unknown) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `Unable to read the link request: ${errorMessage(error)}`,
        });
      if (input.url !== undefined && input.environmentId !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass either environmentId or url, not both. Pass neither to let the user pick the machine.",
        });
      }
      // A machine already linked needs no card: the agent can use it now.
      if (input.environmentId !== undefined) {
        const linked = yield* usableLink(input.environmentId).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
        if (Option.isSome(linked)) {
          return {
            status: "linked",
            environmentId: linked.value.environmentId,
            label: linked.value.label,
            access: linked.value.access,
          } as const;
        }
      }
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      // Turn item ids are global; scope the key to this thread and provider
      // session, since a later session may reuse it. A retry with the same
      // clientRequestId finds this card and records nothing.
      const turnItemId = TurnItemId.make(
        `turn-item:link-request:${encodeURIComponent(threadId)}:${encodeURIComponent(scope.requestNamespace)}:${encodeURIComponent(key)}`,
      );
      if (input.clientRequestId !== undefined) {
        const existing = yield* readCard(threadId, turnItemId).pipe(Effect.mapError(unreadable));
        if (existing !== undefined) return resultOf(existing);
      }
      const parent = yield* threadManagement
        .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
        .pipe(Effect.mapError(unreadable));
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message:
            "Asking to link an environment requires an active run owned by this MCP provider session.",
        });
      }
      // Best effort: the card names the machine at an address the agent was
      // given, and the client finds it by id.
      const peer = input.url === undefined ? Option.none() : yield* peerLinks.describe(input.url);
      yield* record(
        {
          id: turnItemId,
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          ...(input.url === undefined ? {} : { url: input.url }),
          reason: input.reason ?? "",
          ...(Option.isSome(peer)
            ? { environmentId: peer.value.environmentId, label: peer.value.label }
            : input.environmentId === undefined
              ? {}
              : { environmentId: input.environmentId }),
          ...(input.hint === undefined ? {} : { hint: input.hint }),
          ...(input.requestedAccess === undefined
            ? {}
            : { requestedAccess: input.requestedAccess }),
        },
        { linkStatus: "pending" },
        CommandId.make(
          `command:mcp:${encodeURIComponent(scope.requestNamespace)}:link-pending:${encodeURIComponent(key)}`,
        ),
      ).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Could not record the link request: ${errorMessage(error)}`,
            }),
        ),
      );
      return pendingResult(turnItemId);
    },
    Effect.withSpan("PeerLinkRequests.request"),
  );

  const linkedOutcome = (linked: PeerLink): LinkRequestOutcome => ({
    linkStatus: "linked",
    linkedEnvironmentId: linked.environmentId,
    linkedLabel: linked.label,
    linkedAccess: linked.access,
  });

  /** Links the machine the user picked, or finds the link they chose to keep. */
  const answerOutcome = (
    answer: PeerLinkRequestAnswerInput["answer"],
  ): Effect.Effect<LinkRequestOutcome> => {
    switch (answer.type) {
      case "decline":
        return Effect.succeed({ linkStatus: "declined" });
      case "use-existing":
        return usableLink(answer.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new PeerLinkError({
                    reason: "unknown_link",
                    message:
                      "That environment is no longer linked here, or its link expired. Link it again.",
                  }),
                ),
              onSome: (linked) => Effect.succeed(linkedOutcome(linked)),
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed<LinkRequestOutcome>({ linkStatus: "failed", failure: error.message }),
          ),
        );
      case "link": {
        const [url, ...alternateUrls] = answer.urls;
        return peerLinks
          .link({
            url,
            ...(alternateUrls.length === 0 ? {} : { alternateUrls }),
            pairingCode: answer.pairingCode,
            access: answer.access,
            ...(answer.environmentId === undefined
              ? {}
              : { expectedEnvironmentId: answer.environmentId }),
            ...(answer.label === undefined ? {} : { expectedLabel: answer.label }),
          })
          .pipe(
            Effect.map(linkedOutcome),
            Effect.catch((error) =>
              Effect.succeed<LinkRequestOutcome>({ linkStatus: "failed", failure: error.message }),
            ),
          );
      }
    }
  };

  // One answer per card at a time: two answers racing on one card must not
  // both link. Other cards go on while a slow peer holds one.
  const answerLocks = yield* KeyedLock.make<TurnItemId>();
  const answer: PeerLinkRequests["Service"]["answer"] = Effect.fn("PeerLinkRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "link_request.answer": input.answer.type,
      });
      const card = yield* readCard(input.threadId, input.turnItemId).pipe(
        Effect.mapError((cause) => new PeerLinkRequestError({ reason: "load_failed", cause })),
      );
      if (card === undefined || card.runId === null || card.nodeId === null) {
        return yield* new PeerLinkRequestError({ reason: "not_found" });
      }
      // Any time while the card is open: the agent hears the answer as a
      // notification, whether or not its run is still going.
      if (card.linkStatus !== "pending") {
        return yield* new PeerLinkRequestError({ reason: "already_answered" });
      }
      const outcome = yield* answerOutcome(input.answer);
      // If Stop closed the card while linking, the card keeps that; the link
      // itself stands and Settings lists it.
      yield* record(
        { ...card, runId: card.runId, nodeId: card.nodeId },
        outcome,
        CommandId.make(`link-request:${card.id}:${outcome.linkStatus}`),
        {
          messageId: MessageId.make(`message:link-request:${card.id}`),
          ...outcomeNotice(card, outcome),
        },
      ).pipe(
        Effect.mapError((cause) => new PeerLinkRequestError({ reason: "record_failed", cause })),
      );
    },
    (effect, input) =>
      effect.pipe(
        (effect) => answerLocks.withLock(input.turnItemId, effect),
        Effect.withSpan("PeerLinkRequests.answer"),
      ),
  );

  return PeerLinkRequests.of({ request, answer });
});

const pendingResult = (turnItemId: TurnItemId): OrchestratorMcpEnvironmentLinkResult => ({
  status: "pending",
  turnItemId,
});

/** What a retry hears: the card's outcome, without anything the user typed. */
const resultOf = (card: LinkRequestItem): OrchestratorMcpEnvironmentLinkResult => {
  switch (card.linkStatus) {
    case "pending":
      return pendingResult(card.id);
    case "linked":
      return {
        status: "linked",
        environmentId: card.linkedEnvironmentId!,
        label: card.linkedLabel ?? linkTarget(card),
        access: card.linkedAccess!,
      };
    case "failed":
      return { status: "failed", message: card.failure ?? "The link could not be made." };
    case "declined":
    case "cancelled":
      return { status: card.linkStatus };
  }
};

/** What the agent's words call the target: its name, its address, or the user's pick. */
const linkTarget = (card: Pick<LinkRequestItem, "url" | "label" | "environmentId">) =>
  card.label ?? card.url ?? card.environmentId ?? "a machine";

/**
 * The notification an answer sends the agent: what the card says, and what
 * to do next. It carries the outcome only, never the pairing code.
 */
const outcomeNotice = (
  card: Pick<LinkRequestItem, "url" | "label" | "environmentId">,
  outcome: LinkRequestOutcome,
): Omit<LinkRequestWake, "messageId"> => {
  const target = linkTarget(card);
  switch (outcome.linkStatus) {
    case "linked": {
      const label = outcome.linkedLabel ?? target;
      return {
        text: `The user linked ${label} with ${outcome.linkedAccess} access. Pass environmentId ${outcome.linkedEnvironmentId} to act there; t3_environment_links lists it.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: `Linked ${label}`,
        },
      };
    }
    case "failed":
      return {
        text: `Linking ${target} failed: ${outcome.failure ?? "the other environment refused"}. Call t3_environment_link again if the user still wants it.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "failed",
          summary: `Could not link ${target}`,
        },
      };
    default:
      return {
        text: `The user declined to link ${target}.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "cancelled",
          summary: `Declined to link ${target}`,
        },
      };
  }
};

export const layer = Layer.effect(PeerLinkRequests, make);
