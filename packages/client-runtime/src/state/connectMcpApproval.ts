/**
 * The hosted app's side of an agent sign-in on a T3 Connect environment: it reads the request
 * and sends the decision with the owner's own Connect session there, so no code is needed.
 */
import type {
  AuthMcpApprovalDecisionRequest,
  AuthMcpApprovalDetails,
  AuthMcpAuthorizationRequest,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpClient from "effect/http/HttpClient";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createRuntimeCommand } from "./runtime.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/** The environment cannot be reached through T3 Connect with this account. */
export class ConnectMcpApprovalUnavailableError extends Schema.TaggedError<ConnectMcpApprovalUnavailableError>()(
  "ConnectMcpApprovalUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not reach that environment through T3 Connect with this account.";
  }
}

export type ConnectMcpApprovalAnswer =
  | { readonly kind: "details"; readonly details: AuthMcpApprovalDetails }
  | { readonly kind: "redirect"; readonly url: string }
  /** The environment refused the request, with a message for the user. */
  | { readonly kind: "refused"; readonly message: string };

export type ConnectMcpApprovalCall =
  | { readonly kind: "approval"; readonly payload: AuthMcpAuthorizationRequest }
  | { readonly kind: "decision"; readonly payload: AuthMcpApprovalDecisionRequest };

const answerFrom = (
  value: AuthMcpApprovalDetails | { readonly redirectTo: string },
): ConnectMcpApprovalAnswer =>
  "redirectTo" in value
    ? { kind: "redirect", url: value.redirectTo }
    : { kind: "details", details: value };

const refused = (error: { readonly message: string }) =>
  Effect.succeed<ConnectMcpApprovalAnswer>({ kind: "refused", message: error.message });

/**
 * Sends one approval call to `environmentId` with this account's T3 Connect session. Its
 * address comes from the relay, which only grants access to the environment's owner.
 */
const callConnectMcpApproval = Effect.fn("clientRuntime.state.connectMcpApproval")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly call: ConnectMcpApprovalCall;
  }) {
    const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
    const authorized = yield* remote.authorizeDpopHttp({
      expectedEnvironmentId: input.environmentId,
    });
    const common = {
      prepared: {
        environmentId: input.environmentId,
        httpBaseUrl: authorized.httpBaseUrl,
        httpAuthorization: authorized.httpAuthorization,
        target: new RelayConnectionTarget({
          environmentId: input.environmentId,
          label: authorized.label,
        }),
      },
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      // A token for an unsaved environment is not cached, so reuse this one until it is rejected.
      remoteAuthorization: Option.some(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
          ...remote,
          // Untraced: the relay authorization it may call owns the span.
          authorizeDpopHttp: Effect.fnUntraced(function* (request) {
            if (request.rejectedAccessToken === undefined) return authorized;
            return yield* remote.authorizeDpopHttp(request);
          }),
        }),
      ),
      group: "mcpOAuth",
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
    } as const;
    const { call } = input;
    const answer =
      call.kind === "approval"
        ? yield* executeAuthenticatedEnvironmentHttpRequest({
            ...common,
            url: (urls) => urls.approval(),
            request: ({ client, headers }) =>
              client
                .approval({ headers, payload: call.payload })
                .pipe(Effect.map(answerFrom), Effect.catchTags({ AuthMcpApprovalError: refused })),
            // The owner's session can always approve; no CSRF token means a stale credential.
            isUnauthorizedResponse: (answer) =>
              answer.kind === "details" && answer.details.csrfToken === undefined,
          })
        : yield* executeAuthenticatedEnvironmentHttpRequest({
            ...common,
            url: (urls) => urls.decision(),
            request: ({ client, headers }) =>
              client
                .decision({ headers, payload: call.payload })
                .pipe(Effect.map(answerFrom), Effect.catchTags({ AuthMcpApprovalError: refused })),
          });
    return { answer, environmentUrl: authorized.httpBaseUrl, environmentLabel: authorized.label };
  },
  Effect.mapError((cause) => new ConnectMcpApprovalUnavailableError({ cause })),
);

export function createConnectMcpApprovalCommand<R, E>(
  runtime: Atom.AtomRuntime<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization | HttpClient.HttpClient | R,
    E
  >,
) {
  return createRuntimeCommand(runtime, {
    label: "environment-data:connect-mcp-approval",
    execute: callConnectMcpApproval,
  });
}
