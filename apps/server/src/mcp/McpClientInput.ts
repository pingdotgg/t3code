import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { T3_APPROVAL_REQUEST_META } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

/**
 * What one tool call needs in order to ask the person behind the MCP client that made it.
 * `McpHttpServer` provides this around every call.
 */
export class McpClientInput extends Context.Service<
  McpClientInput,
  {
    /** Where a thread's requests to its person are kept while they wait. */
    readonly sessions?: McpProviderSessions.McpProviderSessions["Service"] | undefined;
  }
>()("t3/mcp/McpClientInput") {}

const consentForm = { type: "object", properties: {} } as const;
const decodeElicitRequest = Schema.decodeEffect(McpSchema.ElicitRequestFormParams);

/**
 * Whether this call's client can be sent a form elicitation and left waiting on it: it keeps a
 * session, and it takes forms. A client that names no mode takes forms; one naming only URLs
 * does not.
 */
export const takesElicitation = Effect.gen(function* () {
  const context = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpRequestContext));
  const elicitation = context?.clientCapabilities.elicitation;
  return (
    Option.isSome(yield* Effect.serviceOption(McpSchema.McpServerClient)) &&
    elicitation !== undefined &&
    (elicitation.form !== undefined || elicitation.url === undefined)
  );
});

/**
 * Tells the calling client that this call waits for a person, by sending it request `id` as an
 * MCP elicitation, and ends when the client replies. The reply is never read: only the server's
 * record says what the person chose. The id goes in `_meta` for the thread's adapter, and in
 * Claude Code's display key, the one part of `_meta` it passes on.
 */
export const elicit = Effect.fn("McpClientInput.elicit")(function* (input: {
  readonly id: string;
  readonly message: string;
}) {
  const session = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpServerClient));
  if (session === undefined) return;
  const request = yield* decodeElicitRequest({
    mode: "form",
    message: input.message,
    requestedSchema: consentForm,
    _meta: {
      [T3_APPROVAL_REQUEST_META]: input.id,
      "anthropic/permissionDisplay": { description: input.id },
    },
  }).pipe(Effect.orDie);
  yield* session.getClient.pipe(
    Effect.flatMap((client) => client.elicit(request)),
    Effect.scoped,
    Effect.ignore,
  );
});
