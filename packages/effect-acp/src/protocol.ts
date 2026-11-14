import type * as AcpCompat from "./compat.ts";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Stream from "effect/Stream";
import type * as Stdio from "effect/Stdio";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcServer from "effect/rpc/RpcServer";

import type * as AcpSchema from "./schema.ts";
import type * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import type * as AcpError from "./errors.ts";

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface AcpRequestContext {
  readonly requestId: string;
  readonly method: string;
}



export type AcpRequestHandler<Request, Response> = (
  request: Request,
  context: AcpRequestContext,
) => Effect.Effect<Response, AcpError.AcpError>;

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params:
        | AcpSchema.UpdateSessionNotification
        | AcpSchemaV1.SessionNotification
        | AcpCompat.SessionNotification;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.elicitation_complete | "session/elicitation/complete";
      readonly params: AcpSchema.CompleteElicitationNotification;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpStdio extends Omit<Stdio.Stdio, "stdin"> {
  readonly stdin: Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpError.AcpError>;
}

export interface AcpPatchedProtocolOptions {
  readonly stdio: AcpStdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onIncomingRequest?: (
    requestId: string,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, never>;

  readonly transformSessionUpdate?: (
    notification:
      | AcpSchema.UpdateSessionNotification
      | AcpSchemaV1.SessionNotification
      | AcpCompat.SessionNotification,
  ) =>
    | AcpSchema.UpdateSessionNotification
    | AcpSchemaV1.SessionNotification
    | AcpCompat.SessionNotification;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
    context: AcpRequestContext,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
  readonly onOutgoingResponseFailure?: (
    requestId: string,
    error: AcpError.AcpError,
  ) => Effect.Effect<void, never>;
  readonly onOutgoingResponse?: (requestId: string) => Effect.Effect<void, never>;
  readonly testHooks?: {
    readonly onOutgoingWriteAdmitted?: () => Effect.Effect<void>;
    readonly onOutgoingWriterExit?: (input: {
      readonly intentionalEnd: boolean;
    }) => Effect.Effect<void>;
  };
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

export { acpRequestIdentity } from "./protocolIdentity.ts";
export { makeAcpPatchedProtocol, RPC_REQUEST_ID_START } from "./protocolPatched.ts";
