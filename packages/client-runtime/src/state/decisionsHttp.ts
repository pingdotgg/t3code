import type {
  DecisionAnswer,
  DecisionAnswerInput,
  DecisionItem,
  DecisionItemWithAnswer,
  DecisionListQuery,
  DecisionMediaRef,
  DecisionMediaUploadQuery,
  DecisionProjectBlurb,
  DecisionProjectBlurbInput,
  ThreadBrief,
  ThreadDigest,
} from "@cz/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const BRIEF_TIMEOUT_MS = 45_000;

/** Decisions on one environment, over its authenticated HTTP API (ccez/DECISIONS.md). */
export class DecisionsHttpClient extends Context.Service<
  DecisionsHttpClient,
  {
    readonly list: (
      prepared: PreparedConnection,
      query: DecisionListQuery,
    ) => Effect.Effect<ReadonlyArray<DecisionItemWithAnswer>, RemoteEnvironmentRequestError>;
    readonly answer: (
      prepared: PreparedConnection,
      id: string,
      input: DecisionAnswerInput,
    ) => Effect.Effect<DecisionAnswer, RemoteEnvironmentRequestError>;
    readonly withdraw: (
      prepared: PreparedConnection,
      id: string,
    ) => Effect.Effect<DecisionItem, RemoteEnvironmentRequestError>;
    readonly upload: (
      prepared: PreparedConnection,
      meta: DecisionMediaUploadQuery,
      bytes: Uint8Array,
    ) => Effect.Effect<DecisionMediaRef, RemoteEnvironmentRequestError>;
    /** One-line descriptions for the projects with open decisions. */
    readonly projects: (
      prepared: PreparedConnection,
    ) => Effect.Effect<ReadonlyArray<DecisionProjectBlurb>, RemoteEnvironmentRequestError>;
    readonly describeProject: (
      prepared: PreparedConnection,
      input: DecisionProjectBlurbInput,
    ) => Effect.Effect<DecisionProjectBlurb, RemoteEnvironmentRequestError>;
    /** Feed card extras for threads: latest result and the folder they worked in. */
    readonly threadDigests: (
      prepared: PreparedConnection,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ThreadDigest>, RemoteEnvironmentRequestError>;
    /** The owner's brief: threads that ended since they last looked. */
    readonly brief: (
      prepared: PreparedConnection,
    ) => Effect.Effect<ThreadBrief, RemoteEnvironmentRequestError>;
    /** The owner opened the feed. */
    readonly briefSeen: (
      prepared: PreparedConnection,
    ) => Effect.Effect<void, RemoteEnvironmentRequestError>;
    /** Asks stopped or failed threads to pick up where they left off. */
    readonly retryThreads: (
      prepared: PreparedConnection,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<number, RemoteEnvironmentRequestError>;
  }
>()("@cz/client-runtime/state/decisionsHttp/DecisionsHttpClient") {}

export const layer: Layer.Layer<DecisionsHttpClient, never, HttpClient.HttpClient> = Layer.effect(
  DecisionsHttpClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const common = (prepared: PreparedConnection) =>
      ({ prepared, signer, remoteAuthorization, group: "decisions" }) as const;
    const threads = (prepared: PreparedConnection) =>
      ({ prepared, signer, remoteAuthorization, group: "threads" }) as const;
    const urls = (httpBaseUrl: string) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).decisions;
    const run = <A>(
      effect: Effect.Effect<A, RemoteEnvironmentRequestError, HttpClient.HttpClient>,
    ) => effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    return DecisionsHttpClient.of({
      list: (prepared, query) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "GET",
            url: (base) => urls(base).list({ query }),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.list({ query, headers }),
          }).pipe(Effect.map((result) => result.items)),
        ),
      answer: (prepared, id, input) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "POST",
            url: (base) => urls(base).answer({ params: { id } }),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.answer({ params: { id }, payload: input, headers }),
          }),
        ),
      withdraw: (prepared, id) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "POST",
            url: (base) => urls(base).withdraw({ params: { id } }),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.withdraw({ params: { id }, headers }),
          }),
        ),
      upload: (prepared, meta, bytes) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "POST",
            url: (base) => urls(base).upload({ query: meta }),
            timeoutMs: UPLOAD_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.upload({ query: meta, payload: bytes, headers }),
          }),
        ),
      projects: (prepared) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "GET",
            url: (base) => urls(base).projects(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.projects({ headers }),
          }).pipe(Effect.map((result) => result.blurbs)),
        ),
      describeProject: (prepared, input) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...common(prepared),
            method: "POST",
            url: (base) => urls(base).describeProject(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.describeProject({ payload: input, headers }),
          }),
        ),
      threadDigests: (prepared, threadIds) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            prepared,
            signer,
            remoteAuthorization,
            group: "threads",
            method: "POST",
            url: (base) => makeEnvironmentHttpApiUrlBuilder(base).threads.digests(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.digests({ payload: { threadIds }, headers }),
          }).pipe(Effect.map((result) => result.digests)),
        ),
      brief: (prepared) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...threads(prepared),
            method: "GET",
            url: (base) => makeEnvironmentHttpApiUrlBuilder(base).threads.brief(),
            // The server waits up to 20 s for the model before answering with counts.
            timeoutMs: BRIEF_TIMEOUT_MS,
            request: ({ client, headers }) => client.brief({ headers }),
          }),
        ),
      briefSeen: (prepared) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...threads(prepared),
            method: "POST",
            url: (base) => makeEnvironmentHttpApiUrlBuilder(base).threads.briefSeen(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.briefSeen({ headers }),
          }),
        ),
      retryThreads: (prepared, threadIds) =>
        run(
          executeAuthenticatedEnvironmentHttpRequest({
            ...threads(prepared),
            method: "POST",
            url: (base) => makeEnvironmentHttpApiUrlBuilder(base).threads.retry(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.retry({ payload: { threadIds }, headers }),
          }).pipe(Effect.map((result) => result.retried)),
        ),
    });
  }),
);
