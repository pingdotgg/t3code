import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as TailnetDevices from "./TailnetDevices.ts";

/** The only MCP protocol version a T3 Code `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface PeerCallInput<S> {
  readonly environmentId: EnvironmentId;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly limits: PeerCallLimits;
  readonly success: S;
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(
      input: PeerCallInput<S>,
    ) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

/** Not final, so a task already running there resumes once the beta is on there again. */
const linkedEnvironmentsOffThere = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message:
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.",
});

/** The peer answered 401: the link's token no longer works there. */
class PeerTokenRefused extends Schema.TaggedError<PeerTokenRefused>()("PeerTokenRefused", {}) {}

const linkRefused = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
});

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  // Absent where nothing links tailnet devices, as in the CLI.
  const tailnetDevices = yield* Effect.serviceOption(TailnetDevices.TailnetDevices);
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const post = (url: string, token: string, body: unknown, headers: Record<string, string>) =>
    httpClient.execute(
      HttpClientRequest.post(`${url}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        }),
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
      ),
    );

  const openSession = Effect.fn("PeerMcpClient.openSession")(function* (
    url: string,
    token: string,
    limitHeader: Record<string, string>,
  ) {
    const initialized = yield* post(
      url,
      token,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3code-peer", version: "1" },
        },
      },
      limitHeader,
    );
    const sessionId = initialized.headers["mcp-session-id"];
    if (initialized.status === 403) return yield* linkedEnvironmentsOffThere;
    if (initialized.status === 401) return yield* new PeerTokenRefused();
    if (initialized.status !== 200 || sessionId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
      });
    }
    yield* post(
      url,
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
    );
    return sessionId;
  });

  // `call` owns the span; a retry after a refreshed link is a second attempt inside it.
  const attempt = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown>>(
    input: PeerCallInput<S>,
  ) {
    const resolved = yield* links.resolve(input.environmentId).pipe(Effect.mapError(fromLinkError));
    const limitHeader = {
      [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
    };
    const sessionKey = `${input.environmentId} ${resolved.url}`;
    const callOnce = (sessionId: string) =>
      post(
        resolved.url,
        resolved.token,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: input.tool, arguments: input.arguments },
        },
        { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
      );
    const existing = (yield* Ref.get(sessions)).get(sessionKey);
    const sessionId = existing ?? (yield* openSession(resolved.url, resolved.token, limitHeader));
    // The initialized session outlives a tool request, including a long wait or cancellation.
    if (existing === undefined) {
      yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, sessionId));
    }
    let response = yield* callOnce(sessionId);
    if (response.status === 404) {
      const renewed = yield* openSession(resolved.url, resolved.token, limitHeader);
      yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, renewed));
      response = yield* callOnce(renewed);
    }
    if (response.status === 401) return yield* new PeerTokenRefused();
    if (response.status === 403) return yield* linkedEnvironmentsOffThere;
    if (response.status !== 200) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The linked environment answered HTTP ${response.status}.`,
      });
    }
    const body = yield* decodeToolCallResponse(
      responseJson(response.headers["content-type"], yield* response.text),
    ).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The linked environment answered in an unexpected shape.",
          }),
      ),
    );
    if (body.error !== undefined) {
      return Result.fail(
        new OrchestratorMcpFailure({ code: "invalid_request", message: body.error.message }),
      );
    }
    if (body.result === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The linked environment returned no result.",
      });
    }
    const text = body.result.content.map((part) => part.text ?? "").join("");
    if (body.result.isError === true) {
      // A refusal keeps the peer's own code, so the agent sees why it was refused.
      const refused = decodeFailure(text);
      return Result.fail(
        refused._tag === "Some"
          ? new OrchestratorMcpFailure({
              code: refused.value.code,
              message: refused.value.message,
            })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: text || "The linked environment refused the call.",
            }),
      );
    }
    // Display text may be compacted for the model; peers consume the typed wire payload.
    const success: Schema.Decoder<(typeof input.success)["Type"]> =
      body.result.structuredContent === undefined
        ? Schema.fromJsonString(input.success)
        : input.success;
    const payload =
      body.result.structuredContent === undefined ? text : body.result.structuredContent;
    return yield* Schema.decodeEffect(success)(payload).pipe(
      Effect.map(Result.succeed),
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message:
              "The linked environment's answer did not match this version. Update both environments.",
          }),
      ),
    );
  });

  /** A tailnet device's link is renewed by its handshake, then tried once more. */
  const retryAfterRefresh = Effect.fn("PeerMcpClient.retryAfterRefresh")(function* <
    S extends Schema.Decoder<unknown>,
  >(input: PeerCallInput<S>) {
    const link = yield* links
      .get(input.environmentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(tailnetDevices) || Option.isNone(link) || link.value.origin !== "tailnet") {
      return yield* new PeerTokenRefused();
    }
    yield* tailnetDevices.value.refresh(input.environmentId);
    return yield* attempt(input);
  });

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(
    function* (input) {
      return yield* attempt(input).pipe(
        Effect.catchTags({ PeerTokenRefused: () => retryAfterRefresh(input) }),
        Effect.catchTags({ PeerTokenRefused: () => Effect.fail(linkRefused) }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.tapError((error) =>
          links.recordOutcome(input.environmentId, { error: error.message }),
        ),
        // A refusal is still an answer: the link works, so only this call fails.
        Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
        // Recorded above with the transport's own message; the agent hears it plainly.
        Effect.catchTags({
          HttpClientError: () =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "The linked environment stopped answering.",
              }),
            ),
        }),
        Effect.flatMap(Effect.fromResult),
      ),
  );

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
