import { AuthAccessReadScope, AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as TailcatRemoteAccess from "./TailcatRemoteAccess.ts";

/** HTTP surface for the CLI; the UI uses the equivalent RPC methods. */
export const tailcatHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tailcat",
  Effect.fnUntraced(function* (handlers) {
    const remoteAccess = yield* TailcatRemoteAccess.TailcatRemoteAccess;
    return handlers
      .handle(
        "remoteAccess",
        Effect.fn("environment.tailcat.remoteAccess")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          return yield* remoteAccess.state;
        }),
      )
      .handle(
        "setRemoteAccess",
        Effect.fn("environment.tailcat.setRemoteAccess")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* remoteAccess.setEnabled(args.payload.enabled);
        }),
      )
      .handle(
        "createConnectionCode",
        Effect.fn("environment.tailcat.createConnectionCode")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* remoteAccess.createConnectionCode(args.payload);
        }),
      )
      .handle(
        "revokeTrustedPeer",
        Effect.fn("environment.tailcat.revokeTrustedPeer")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* remoteAccess.revokeTrustedPeer(args.payload.peerId);
        }),
      );
  }),
);
