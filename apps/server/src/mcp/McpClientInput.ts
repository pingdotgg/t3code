import type { ProviderApprovalPushHooks } from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * Where one tool call leaves its request for the client's input. A sessionless client is asked
 * by answering the call with that request; it calls the tool again with the person's answer.
 * `McpHttpServer` provides this around every call and sends what the handler left here.
 */
export class McpClientInput extends Context.Service<
  McpClientInput,
  {
    readonly request: Ref.Ref<McpSchema.InputRequired | undefined>;
    /** Where a thread's adapter finds what T3 Code asks through the thread's own client. */
    readonly sessions?: McpProviderSessions.McpProviderSessions["Service"] | undefined;
  }
>()("t3/mcp/McpClientInput") {}

/**
 * "asked": the request went out with this call's answer, so the handler ends now and runs again
 * when the client calls back. "unavailable": this client cannot ask a person anything.
 * "unconfirmed": the client replied that the person accepted, and T3 Code, which showed the
 * request to the person itself, has no approval from them for it.
 */
export type Approval = "accepted" | "declined" | "unconfirmed" | "asked" | "unavailable";

const consentForm = { type: "object", properties: {} } as const;
const decodeElicitRequest = Schema.decodeEffect(McpSchema.ElicitRequestFormParams);

// A request left with a thread's session goes out with that record's id after its state, so the
// reply that comes with a later call ends that record and no other.
const RECORDED_STATE = /^(.*) request=([0-9a-f-]{36})$/s;
const recordedState = (state: string, id: string | undefined) =>
  id === undefined ? state : `${state} request=${id}`;
const sentState = (requestState: string) => {
  const match = RECORDED_STATE.exec(requestState);
  return match === null ? { state: requestState } : { state: match[1]!, id: match[2]! };
};

/** The calling thread and where its requests are kept, when the call comes from a thread. */
const threadRequests = Effect.gen(function* () {
  const sessions = Option.getOrUndefined(yield* Effect.serviceOption(McpClientInput))?.sessions;
  const thread = Option.getOrUndefined(
    yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
  )?.thread;
  return sessions === undefined || thread === undefined ? undefined : { sessions, thread };
});

/**
 * Ends the request `id` and reads the client's "accept" for it. Where the thread's adapter shows
 * T3 Code's own requests, only the person's answer in the app, for this request and `state`, is
 * an approval, and a request that is gone has none. Any other client's reply is all there is.
 */
const accepted = Effect.fnUntraced(function* (id: string | undefined, state?: string) {
  const requests = yield* threadRequests;
  if (requests === undefined) return "accepted" as const;
  const { sessions, thread } = requests;
  const request =
    id === undefined ? undefined : yield* sessions.takeApprovalRequest(thread.threadId, id);
  if (!(yield* sessions.areApprovalRequestsShown(thread.providerInstanceId))) {
    return "accepted" as const;
  }
  return request?.approved === true && (state === undefined || request.state === state)
    ? ("accepted" as const)
    : ("unconfirmed" as const);
});

/**
 * The reply this call brings to `key`, with the `state` of the request it answers: what a
 * sessionless client sends when it calls again. A handler reads it before it does anything a
 * decline rules out, and it is read once: the request it answers is no longer waiting, so the
 * thread's session forgets it.
 */
export const answered = Effect.fn("McpClientInput.answered")(function* (key: string) {
  const context = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpRequestContext));
  const answer = context?.inputResponses?.[key];
  if (answer === undefined || context?.requestState === undefined) return undefined;
  const { state, id } = sentState(context.requestState);
  if (answer.action === "accept") return { state, answer: yield* accepted(id, state) };
  const requests = yield* threadRequests;
  if (requests !== undefined && id !== undefined) {
    yield* requests.sessions.forgetApprovalRequest(requests.thread.threadId, id);
  }
  return { state, answer: "declined" as const };
});

/**
 * Asks the person behind the calling MCP client to approve `message`, by MCP elicitation.
 * `state` names what is being approved: an answer counts only for the state it was given for,
 * so asking again with another state asks the person again.
 */
export const askApproval = Effect.fn("McpClientInput.askApproval")(function* (input: {
  readonly key: string;
  readonly state: string;
  readonly message: string;
  readonly pushHooks?: ProviderApprovalPushHooks;
}): Effect.fn.Return<Approval> {
  const context = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpRequestContext));
  const elicitation = context?.clientCapabilities.elicitation;
  // The request is a form. A client that names no mode takes forms; one naming only URLs does not.
  if (
    context === undefined ||
    elicitation === undefined ||
    (elicitation.form === undefined && elicitation.url !== undefined)
  ) {
    return "unavailable";
  }
  const params = { mode: "form", message: input.message, requestedSchema: consentForm } as const;
  const pending = Option.getOrUndefined(yield* Effect.serviceOption(McpClientInput));
  const requests = yield* threadRequests;
  // A thread's client hands its adapter the message and a server name to show. The request is
  // left with the thread's MCP session too, so the adapter knows T3 Code asked it and what it
  // names, and has where to leave the person's answer.
  const record =
    requests === undefined
      ? Effect.undefined
      : requests.sessions.recordApprovalRequest(requests.thread.threadId, {
          message: input.message,
          pushHooks: input.pushHooks,
          state: input.state,
        });

  // A session: the server asks over it and waits here for the answer.
  const session = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpServerClient));
  if (session !== undefined) {
    const request = yield* decodeElicitRequest(params).pipe(Effect.orDie);
    const recorded = yield* record;
    return yield* session.getClient.pipe(
      Effect.flatMap((client) => client.elicit(request)),
      Effect.scoped,
      Effect.flatMap(({ action }) =>
        action === "accept" ? accepted(recorded) : Effect.succeed("declined" as const),
      ),
      // A request that ends without an answer is not an approval.
      Effect.catchCause(() => Effect.succeed("declined" as const)),
      Effect.ensuring(
        requests === undefined || recorded === undefined
          ? Effect.void
          : requests.sessions.forgetApprovalRequest(requests.thread.threadId, recorded),
      ),
    );
  }

  if (pending === undefined) return "unavailable";
  const answer = context.inputResponses?.[input.key];
  const sent = context.requestState === undefined ? undefined : sentState(context.requestState);
  if (answer !== undefined && sent?.state === input.state) {
    if (answer.action === "accept") return yield* accepted(sent.id, sent.state);
    if (requests !== undefined && sent.id !== undefined) {
      yield* requests.sessions.forgetApprovalRequest(requests.thread.threadId, sent.id);
    }
    return "declined";
  }
  const recorded = yield* record;
  yield* Ref.set(
    pending.request,
    new McpSchema.InputRequired({
      inputRequests: { [input.key]: { method: "elicitation/create", params } },
      requestState: recordedState(input.state, recorded),
    }),
  );
  return "asked";
});
