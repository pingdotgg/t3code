import type {
  SourceControlAppAccess,
  SourceControlProviderKind,
  SourceControlSignInError,
  SourceControlSignInPrompt,
  SourceControlSignInResult,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { SourceControlDefinition } from "../shared/definition.ts";

import type { SourceControlProviderDiscoverySpec } from "./discovery.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import type * as SourceControlHost from "./SourceControlHost.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

export interface SourceControlMediaRequest {
  /** A `fetchUrl` this host's definition returned from `mediaUrl`. */
  readonly url: string;
  /** Request headers to forward, such as `range`. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The server side of a definition's `credentials.appSignIn`. */
export interface SourceControlSignIn {
  /** Replaces any sign-in already pending for `host`; the driver finishes it on its own. */
  readonly start: (
    host: string,
  ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
  /** The outcome of the latest sign-in `start` began for `host`, waiting for it if pending. */
  readonly wait: (
    host: string,
  ) => Effect.Effect<SourceControlSignInResult, SourceControlSignInError>;
  /** Ends the sign-in pending for `host`; its `wait` fails as cancelled. */
  readonly cancel: (host: string) => Effect.Effect<void>;
  /** Whether the sign-in reaches `owner/name`, so clients can suggest installing the app there. */
  readonly access: (
    host: string,
    repository: string,
  ) => Effect.Effect<SourceControlAppAccess["status"]>;
}

export interface SourceControlDriverInstance {
  readonly sourceControl: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
  /** Null for a host whose pull requests this build cannot read. */
  readonly pullRequests: PullRequestProviderApi | null;
  /**
   * Fetches media the definition's `mediaUrl` claimed, with the credential the host serves it
   * to. Null when the fetch went nowhere a response could come from, such as a redirect loop.
   */
  readonly fetchMedia?: (
    request: SourceControlMediaRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse | null,
    HttpClientError.HttpClientError,
    Scope.Scope
  >;
  readonly signIn?: SourceControlSignIn;
  /** Whether the server's account on `host` starred `repository` (`owner/name`). */
  readonly isRepositoryStarred?: (host: string, repository: string) => Effect.Effect<boolean>;
}

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SourceControlDriverServices =
  | SourceControlHost.SourceControlHost
  | SourceControlRateLimit.SourceControlRateLimit
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Crypto.Crypto;

export interface SourceControlDriver {
  readonly kind: SourceControlProviderKind;
  readonly definition: SourceControlDefinition;
  /**
   * Run once per server, in a scope that lasts as long as the server. State a host shares across
   * everything that talks to it, such as GitHub's quota reserve and rate-limit pause, lives in
   * what this builds, so building it twice would split that state.
   */
  readonly make: Effect.Effect<
    SourceControlDriverInstance,
    never,
    SourceControlDriverServices | Scope.Scope
  >;
}

export const defineSourceControlDriver = (driver: SourceControlDriver): SourceControlDriver =>
  driver;

/**
 * `make` over a host's own `services`, built into the caller's scope so they live as long as the
 * instance that holds them.
 */
export const withOwnServices = <A, R, ROut, RIn>(
  make: Effect.Effect<A, never, R>,
  services: Layer.Layer<ROut, never, RIn>,
): Effect.Effect<A, never, Exclude<R, ROut> | RIn | Scope.Scope> =>
  Layer.build(services).pipe(Effect.flatMap((context) => make.pipe(Effect.provide(context))));
