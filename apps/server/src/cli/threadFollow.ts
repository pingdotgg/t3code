import {
  EnvironmentHttpApi,
  ThreadId,
  WsRpcGroup,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export class ThreadCliFollowError extends Schema.TaggedError<ThreadCliFollowError>()(
  "ThreadCliFollowError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

const isThreadCliFollowError = Schema.is(ThreadCliFollowError);

/** One unit of followed output: assistant text, or a one-line activity summary. */
export type ThreadFollowOutput =
  | { readonly type: "text"; readonly messageId: string; readonly text: string }
  | { readonly type: "activity"; readonly summary: string };

/**
 * Turns thread stream events into output, tracking how much of each assistant
 * message has been printed. Streaming events carry deltas; a final
 * non-streaming event carries the full text, so only its unseen suffix is
 * printed. The printed text therefore converges on the stored message.
 */
export class ThreadFollowRenderer {
  private readonly printed = new Map<string, string>();
  private lastMessageId: string | null = null;
  private turnId: string | null = null;

  /** Restricts output to one turn once its id is known. Null follows every turn. */
  setTurn(turnId: string | null): void {
    this.turnId = turnId;
  }

  /** Marks existing messages as already printed so they are never repeated. */
  seed(messages: ReadonlyArray<OrchestrationMessage>): void {
    for (const message of messages) this.printed.set(message.id, message.text);
  }

  private wanted(turnId: string | null): boolean {
    return this.turnId === null || turnId === this.turnId;
  }

  /** Separates a new message from earlier output with a blank line. */
  private text(messageId: string, text: string): ReadonlyArray<ThreadFollowOutput> {
    if (text.length === 0) return [];
    const lead = this.lastMessageId !== null && this.lastMessageId !== messageId ? "\n\n" : "";
    this.lastMessageId = messageId;
    return [{ type: "text", messageId, text: `${lead}${text}` }];
  }

  handleEvent(event: OrchestrationEvent): ReadonlyArray<ThreadFollowOutput> {
    if (event.type === "thread.message-sent") {
      const payload = event.payload;
      if (payload.role !== "assistant" || !this.wanted(payload.turnId)) return [];
      const previous = this.printed.get(payload.messageId) ?? "";
      if (payload.streaming) {
        this.printed.set(payload.messageId, previous + payload.text);
        return this.text(payload.messageId, payload.text);
      }
      if (payload.text.length === 0) return [];
      this.printed.set(payload.messageId, payload.text);
      return payload.text.startsWith(previous)
        ? this.text(payload.messageId, payload.text.slice(previous.length))
        : [];
    }
    if (event.type === "thread.activity-appended") {
      const activity = event.payload.activity;
      if (!this.wanted(activity.turnId)) return [];
      // Activities interrupt text, so the next message chunk starts fresh.
      this.lastMessageId = "activity";
      return [{ type: "activity", summary: activity.summary }];
    }
    return [];
  }

  handleItem(item: OrchestrationThreadStreamItem): ReadonlyArray<ThreadFollowOutput> {
    if (item.kind === "snapshot") {
      this.seed(item.snapshot.thread.messages);
      return [];
    }
    return item.kind === "event" ? this.handleEvent(item.event) : [];
  }

  /** Prints whatever the stream missed for a settled turn. */
  reconcile(
    messages: ReadonlyArray<OrchestrationMessage>,
    turnId: string,
  ): ReadonlyArray<ThreadFollowOutput> {
    const out: ThreadFollowOutput[] = [];
    for (const message of messages) {
      if (message.role !== "assistant" || message.turnId !== turnId) continue;
      const previous = this.printed.get(message.id) ?? "";
      this.printed.set(message.id, message.text);
      if (message.text.startsWith(previous)) {
        out.push(...this.text(message.id, message.text.slice(previous.length)));
      }
    }
    return out;
  }
}

export function webSocketUrlForOrigin(origin: string, ticket: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

const issueWebSocketTicket = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    return yield* client.auth.webSocketTicket({
      headers: { authorization: `Bearer ${token}` },
    });
  }).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.mapError(
      (cause) => new ThreadCliFollowError({ detail: "Could not open a live stream.", cause }),
    ),
  );

/**
 * Streams a thread's live events over the server WebSocket, the same feed the
 * app uses. The first item is a snapshot, so callers can seed state first.
 */
export const threadEventStream = (input: {
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ticket = yield* issueWebSocketTicket(input.origin, input.token);
      const socketLayer = Socket.layerWebSocket(
        webSocketUrlForOrigin(input.origin, ticket.ticket),
        { openTimeout: Duration.seconds(5) },
      ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));
      const protocolLayer = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
      ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
      const context = yield* Layer.build(protocolLayer);
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
      return client["orchestration.subscribeThread"]({
        threadId: ThreadId.make(input.threadId),
        turnLimit: 1,
      });
    }),
  ).pipe(
    Stream.mapError((cause) =>
      isThreadCliFollowError(cause)
        ? cause
        : new ThreadCliFollowError({ detail: "The live stream failed.", cause }),
    ),
  );
