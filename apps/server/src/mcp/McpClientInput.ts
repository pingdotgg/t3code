import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { T3_APPROVAL_REQUEST_META } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

/**
 * What one tool call needs in order to ask the person behind the MCP client that made it.
 * `McpHttpServer` provides this around every call and sends what the handler left in `request`.
 */
export class McpClientInput extends Context.Service<
  McpClientInput,
  {
    /** Where a call leaves what it asks of a sessionless client, which is then its answer. */
    readonly request?: Ref.Ref<McpSchema.InputRequired | undefined> | undefined;
    /** Where a thread's requests to its person are kept while they wait. */
    readonly sessions?: McpProviderSessions.McpProviderSessions["Service"] | undefined;
  }
>()("t3/mcp/McpClientInput") {}

const KEY = "approval";
const consentForm = { type: "object", properties: {} } as const;
const decodeElicitRequest = Schema.decodeEffect(McpSchema.ElicitRequestFormParams);

const context = Effect.gen(function* () {
  const request = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpRequestContext));
  const elicitation = request?.clientCapabilities.elicitation;
  return {
    request,
    session: Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpServerClient)),
    pending: Option.getOrUndefined(yield* Effect.serviceOption(McpClientInput))?.request,
    // A client that names no mode takes forms; one naming only URLs does not.
    takesForms:
      elicitation !== undefined &&
      (elicitation.form !== undefined || elicitation.url === undefined),
  };
});

/**
 * Whether this call's client can be sent a form elicitation and left waiting on it: over its
 * session, or, for a sessionless client, as this call's answer.
 */
export const takesElicitation = Effect.map(
  context,
  ({ session, pending, takesForms }) =>
    takesForms && (session !== undefined || pending !== undefined),
);

/**
 * Sends the client request `id` as an MCP elicitation, so it knows the call waits for a person.
 * The reply is never read: only the server's record says what they chose. "replied": the client
 * answered and waits no longer. "asked": a sessionless client got it as this call's answer.
 */
export const elicit = Effect.fn("McpClientInput.elicit")(function* (input: {
  readonly id: string;
  readonly message: string;
}): Effect.fn.Return<"replied" | "asked"> {
  const { request: called, session, pending } = yield* context;
  const params = yield* decodeElicitRequest({
    mode: "form",
    message: input.message,
    requestedSchema: consentForm,
    // For the thread's adapter. Claude Code passes on only its own display key.
    _meta: {
      [T3_APPROVAL_REQUEST_META]: input.id,
      "anthropic/permissionDisplay": { description: input.id },
    },
  }).pipe(Effect.orDie);
  if (session !== undefined) {
    yield* session.getClient.pipe(
      Effect.flatMap((client) => client.elicit(params)),
      Effect.scoped,
      Effect.ignore,
    );
    return "replied";
  }
  if (pending === undefined) return "replied";
  // The call that brings the reply to this request's elicitation names it as its state.
  if (called?.inputResponses?.[KEY] !== undefined && called.requestState === input.id) {
    return "replied";
  }
  yield* Ref.set(
    pending,
    new McpSchema.InputRequired({
      inputRequests: { [KEY]: { method: "elicitation/create", params } },
      requestState: input.id,
    }),
  );
  return "asked";
});
