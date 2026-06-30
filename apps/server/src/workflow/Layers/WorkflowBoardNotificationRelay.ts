import {
  RelayApi,
  RELAY_BOARD_TICKET_PUBLISH_TYP,
  type RelayBoardTicketPublishProofPayload,
  type RelayBoardTicketState,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { signRelayJwt, normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../../cloud/environmentKeys.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowBoardNotificationRelay,
  type WorkflowBoardNotificationRelayShape,
} from "../Services/WorkflowBoardNotificationRelay.ts";

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const environmentKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(Effect.map((maybeBytes) => Option.getOrNull(Option.map(maybeBytes, (b) => new TextDecoder().decode(b)))));

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    return url && environmentCredential
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const makePublishProof = (input: {
    readonly relayIssuer: string;
    readonly environmentId: EnvironmentId;
    readonly boardId: string;
    readonly ticketId: string;
    readonly state: RelayBoardTicketState;
    readonly jti: string;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 5 });
      const payload = {
        iss: `t3-env:${input.environmentId}`,
        aud: normalizeRelayIssuer(input.relayIssuer),
        sub: input.environmentId,
        jti: input.jti,
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        environmentId: input.environmentId,
        boardId: input.boardId,
        ticketId: input.ticketId,
        state: input.state,
      } satisfies RelayBoardTicketPublishProofPayload;
      return yield* signRelayJwt({
        privateKey: environmentKeyPair.privateKey,
        typ: RELAY_BOARD_TICKET_PUBLISH_TYP,
        payload,
      });
    });

  const publishTicket: WorkflowBoardNotificationRelayShape["publishTicket"] = (input) =>
    Effect.gen(function* () {
      // Absent config legitimately returns null (standby no-op). A real
      // secret-store READ error propagates here and is wrapped by the outer
      // catchCause into a WorkflowEventStoreError, so the dispatcher retries
      // instead of marking the row sent and silently dropping the notification.
      const relayConfig = yield* readRelayConfig;
      if (!relayConfig) {
        yield* Effect.logDebug("board ticket notification standby; T3 Connect config missing", {
          boardId: input.boardId,
          ticketId: input.ticketId,
        });
        return;
      }

      const relayClient = yield* makeRelayClient(relayConfig);
      const proof = yield* makePublishProof({
        relayIssuer: relayConfig.issuer,
        environmentId: input.environmentId,
        boardId: input.boardId,
        ticketId: input.ticketId,
        state: input.state,
        jti: yield* crypto.randomUUIDv4,
      });

      yield* Effect.logInfo("publishing board ticket attention", {
        environmentId: input.environmentId,
        boardId: input.boardId,
        ticketId: input.ticketId,
        attentionKind: input.state.attentionKind,
      });

      const response = yield* relayClient.server.publishBoardTicket({
        params: {
          environmentId: input.environmentId,
          ticketId: input.ticketId,
        },
        payload: {
          state: input.state,
          proof,
        },
      });

      yield* Effect.logInfo("board ticket attention publish completed", {
        environmentId: input.environmentId,
        boardId: input.boardId,
        ticketId: input.ticketId,
        ok: response.ok,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new WorkflowEventStoreError({
            message: `board ticket relay publish failed for ticket ${input.ticketId}`,
            cause: Cause.squash(cause),
          }),
        ),
      ),
      Effect.withSpan("WorkflowBoardNotificationRelay.publishTicket"),
    );

  return {
    publishTicket,
  } satisfies WorkflowBoardNotificationRelayShape;
});

export const WorkflowBoardNotificationRelayLive = Layer.effect(
  WorkflowBoardNotificationRelay,
  make,
);
