import {
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "./remote.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import {
  type ConnectionAttemptError,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    /** Lets the next direct authorization of this address skip its own descriptor read. */
    readonly rememberCheckedDescriptor: (
      httpBaseUrl: string,
      descriptor: Option.Option<ExecutionEnvironmentDescriptor>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CHECKED_DESCRIPTOR_TTL_NANOS = 5_000_000_000n;

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
});

const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;

  // A route or host check hands its descriptor to the connect it leads to, once,
  // so the connect skips a round trip. Only over HTTPS: a plain LAN address can
  // belong to another machine after a network change.
  const checkedDescriptors = new Map<
    string,
    { readonly descriptor: ExecutionEnvironmentDescriptor; readonly at: bigint }
  >();

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const checked = checkedDescriptors.get(input.httpBaseUrl);
      checkedDescriptors.delete(input.httpBaseUrl);
      // A remembered mismatch still reads again, so a host that answers for the
      // right environment a moment later is not blocked.
      const descriptor =
        checked !== undefined &&
        checked.descriptor.environmentId === input.expectedEnvironmentId &&
        (yield* Clock.monotonicTimeNanos) - checked.at <= CHECKED_DESCRIPTOR_TTL_NANOS
          ? checked.descriptor
          : yield* fetchDescriptor(input.httpBaseUrl).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        descriptor,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    // Untraced: it runs on every route and host check.
    rememberCheckedDescriptor: Effect.fnUntraced(function* (httpBaseUrl, descriptor) {
      if (Option.isNone(descriptor) || !httpBaseUrl.startsWith("https:")) {
        checkedDescriptors.delete(httpBaseUrl);
        return;
      }
      checkedDescriptors.set(httpBaseUrl, {
        descriptor: descriptor.value,
        at: yield* Clock.monotonicTimeNanos,
      });
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
