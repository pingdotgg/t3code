import {
  type OrchestrationV2Notification,
  type OrchestrationV2ConversationMessage,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

export interface AgentMessageOffer {
  readonly id: `${string}-${string}-${string}-${string}-${string}`;
  readonly queuedRunId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: OrchestrationV2ConversationMessage["attachments"];
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
}

export interface AgentMessageOfferRef {
  readonly id: string;
  readonly queuedRunId: RunId;
}

export type ClaimAgentMessages = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerTurnId: ProviderTurnId;
}) => Effect.Effect<ReadonlyArray<AgentMessageOffer>>;

export type AcknowledgeAgentMessages = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly offers: ReadonlyArray<AgentMessageOfferRef>;
}) => Effect.Effect<void>;

interface AgentMessageDelivery {
  readonly claim: ClaimAgentMessages;
  readonly acknowledge: AcknowledgeAgentMessages;
  /** Caller has fenced the producer and proved these inputs were never handed off. */
  readonly withdraw: AcknowledgeAgentMessages;
}

/** The default drops requests; share the live layer with the worker that drains them. */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
  readonly claimAgentMessages?: ClaimAgentMessages;
  readonly acknowledgeAgentMessages?: AcknowledgeAgentMessages;
  readonly withdrawAgentMessages?: AcknowledgeAgentMessages;
  readonly serveAgentMessages?: (delivery: AgentMessageDelivery) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    const delivery = yield* Ref.make<AgentMessageDelivery>({
      claim: () => Effect.succeed([]),
      acknowledge: () => Effect.void,
      withdraw: () => Effect.void,
    });
    return {
      offer: Effect.fn("ProviderContinuationRequests.offer")(function (
        request: ProviderContinuationRequest,
      ) {
        return Queue.offer(queue, request).pipe(Effect.asVoid);
      }),
      take: Queue.take(queue),
      claimAgentMessages: Effect.fn("ProviderContinuationRequests.claimAgentMessages")((input) =>
        Ref.get(delivery).pipe(Effect.flatMap((served) => served.claim(input))),
      ),
      acknowledgeAgentMessages: Effect.fn("ProviderContinuationRequests.acknowledgeAgentMessages")(
        (input) => Ref.get(delivery).pipe(Effect.flatMap((served) => served.acknowledge(input))),
      ),
      withdrawAgentMessages: Effect.fn("ProviderContinuationRequests.withdrawAgentMessages")(
        (input) => Ref.get(delivery).pipe(Effect.flatMap((served) => served.withdraw(input))),
      ),
      serveAgentMessages: Effect.fn("ProviderContinuationRequests.serveAgentMessages")((served) =>
        Ref.set(delivery, served),
      ),
    };
  }),
);
