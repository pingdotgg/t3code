import { EnvironmentAuthenticatedPrincipal, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest } from "../auth/http.ts";
import * as FederationService from "./FederationService.ts";

/**
 * Peer-facing federation endpoints. Pairing and authentication are open by
 * design (they establish trust and sessions); everything else runs under the
 * ordinary session middleware and then checks the peer's federation grant.
 */
export const federationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "federation",
  Effect.fnUntraced(function* (handlers) {
    const federation = yield* FederationService.FederationService;

    const peerFor = (required: Parameters<typeof federation.authorizePeer>[1]) =>
      EnvironmentAuthenticatedPrincipal.pipe(
        Effect.flatMap((principal) =>
          federation.authorizePeer(
            { subject: principal.subject, scopes: principal.scopes },
            required,
          ),
        ),
      );

    return handlers
      .handle(
        "pair",
        Effect.fn("environment.federation.pair")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* federation.acceptPair(args.payload);
        }),
      )
      .handle(
        "challenge",
        Effect.fn("environment.federation.challenge")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* federation.issueChallenge(args.payload);
        }),
      )
      .handle(
        "token",
        Effect.fn("environment.federation.token")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* federation.redeemChallenge(args.payload);
        }),
      )
      .handle(
        "hello",
        Effect.fn("environment.federation.hello")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* peerFor("environment.read");
          return yield* federation.hello;
        }),
      )
      .handle(
        "projects",
        Effect.fn("environment.federation.projects")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* peerFor("projects.read");
          return yield* federation.localProjects;
        }),
      )
      .handle(
        "startRun",
        Effect.fn("environment.federation.startRun")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("runs.start");
          return yield* federation.startLocalRun(peer, args.payload);
        }),
      )
      .handle(
        "runStatus",
        Effect.fn("environment.federation.runStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("runs.read");
          return yield* federation.localRunStatus(peer, args.params.threadId);
        }),
      )
      .handle(
        "cancelRun",
        Effect.fn("environment.federation.cancelRun")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("runs.cancel");
          return yield* federation.cancelLocalRun(peer, args.params.threadId);
        }),
      )
      .handle(
        "runEvents",
        Effect.fn("environment.federation.runEvents")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("runs.read");
          return yield* federation.localRunEvents(
            peer,
            args.params.threadId,
            args.payload.afterSequence ?? 0,
          );
        }),
      )
      .handle(
        "runArtifacts",
        Effect.fn("environment.federation.runArtifacts")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("artifacts.read");
          return yield* federation.localRunArtifacts(peer, args.params.threadId);
        }),
      )
      .handle(
        "fetchArtifact",
        Effect.fn("environment.federation.fetchArtifact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const peer = yield* peerFor("artifacts.read");
          return yield* federation.fetchLocalArtifact(
            peer,
            args.params.threadId,
            args.params.turnId,
          );
        }),
      );
  }),
);
