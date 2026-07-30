import type {
  EmitterWebhookEvent,
  EmitterWebhookEventName,
} from "@octokit/webhooks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { Providers } from "./Providers.ts";

/**
 * A reference to the GitHub repository whose events you want to receive.
 */
export interface RepositoryRef {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;
}

/**
 * The bare GitHub webhook event names (e.g. `push`, `pull_request`), sourced
 * from `@octokit/webhooks`. Excludes the `event.action` emitter variants
 * (e.g. `pull_request.opened`) — webhooks are configured by bare event name.
 */
export type GitHubEventName = Exclude<
  EmitterWebhookEventName,
  `${string}.${string}`
>;

/**
 * Names selectable in {@link RepositoryEventSourceProps.events}: every bare
 * GitHub event name plus `"*"` to subscribe to all of them.
 *
 * @see {@link https://docs.github.com/en/webhooks/webhook-events-and-payloads | GitHub webhook events and payloads}
 */
export type WebhookEventName = GitHubEventName | "*";

/**
 * A single GitHub webhook delivery — Octokit's `EmitterWebhookEvent`, a
 * complete discriminated union of `{ id, name, payload }` keyed on `name`
 * with a fully-typed `payload` per event. `Name` narrows the union to the
 * events the subscriber selected, so `switch (event.name)` exhaustively
 * narrows `event.payload`.
 */
export type WebhookEvent<Name extends GitHubEventName = GitHubEventName> =
  EmitterWebhookEvent<Name>;

/**
 * The set of event names a handler can observe given the `events` it
 * selected. Selecting `"*"` (or omitting `events`) widens back to every
 * {@link GitHubEventName}; otherwise it's the union of the chosen literals.
 */
export type SelectedEvent<E extends readonly WebhookEventName[]> =
  "*" extends E[number] ? GitHubEventName : Exclude<E[number], "*">;

export interface RepositoryEventSourceProps<
  E extends readonly WebhookEventName[] = readonly WebhookEventName[],
> extends RepositoryRef {
  /**
   * GitHub event names to subscribe to (e.g. `["push", "pull_request"]`).
   * Use `["*"]` to receive every event GitHub emits.
   * @default ["push"]
   */
  events?: E;

  /**
   * Secret used to verify each delivery's `HMAC-SHA256` signature. When set,
   * the event source provisions the webhook with this secret and the runtime
   * rejects deliveries whose `X-Hub-Signature-256` header doesn't match.
   * Strongly recommended — without it, anyone who learns the delivery URL can
   * forge events.
   */
  secret?: Redacted.Redacted<string>;

  /**
   * Path on the host that GitHub delivers to. Defaults to a deterministic
   * per-repository path so deliveries don't collide with your application
   * routes. Override only if you need a fixed, well-known path.
   */
  path?: string;
}

/**
 * Subscribe to events emitted by a GitHub repository.
 *
 * Call it in the init phase of a host (e.g. a Cloudflare Worker) and pass a
 * `process` function that receives each {@link WebhookEvent} and returns an
 * `Effect`. The handler runs once per webhook delivery.
 *
 * Wiring the webhook (delivery URL, secret, IAM/bindings) is handled by the
 * host-specific runtime layer — see
 * `Cloudflare.Workers.GitHubRepositoryEventSourceLive` for the Cloudflare Worker
 * implementation.
 * @binding
 * @example
 * ```typescript
 * // `event.name` is narrowed to "push" | "pull_request"
 * yield* GitHub.consumeRepositoryEvents(
 *   {
 *     owner: "my-org",
 *     repository: "my-repo",
 *     events: ["push", "pull_request"],
 *     secret,
 *   },
 *   (event) => Effect.log(`received ${event.name} (${event.id})`),
 * );
 * ```
 *
 * @example
 * ```typescript
 * // When you don't need to pass any options, the handler is the only argument.
 * yield* GitHub.consumeRepositoryEvents((event) =>
 *   Effect.log(`received ${event.name} (${event.id})`),
 * );
 * ```
 */
export function consumeRepositoryEvents<Req = never>(
  process: (
    event: WebhookEvent<SelectedEvent<readonly WebhookEventName[]>>,
  ) => Effect.Effect<void, never, Req | Providers>,
): Effect.Effect<void, never, RepositoryEventSource>;
export function consumeRepositoryEvents<
  const E extends readonly WebhookEventName[] = readonly WebhookEventName[],
  Req = never,
>(
  props: RepositoryEventSourceProps<E>,
  process: (
    event: WebhookEvent<SelectedEvent<E>>,
  ) => Effect.Effect<void, never, Req | Providers>,
): Effect.Effect<void, never, RepositoryEventSource>;
export function consumeRepositoryEvents<
  const E extends readonly WebhookEventName[] = readonly WebhookEventName[],
  Req = never,
>(
  propsOrProcess:
    | RepositoryEventSourceProps<E>
    | ((
        event: WebhookEvent<SelectedEvent<E>>,
      ) => Effect.Effect<void, never, Req | Providers>),
  maybeProcess?: (
    event: WebhookEvent<SelectedEvent<E>>,
  ) => Effect.Effect<void, never, Req | Providers>,
) {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as RepositoryEventSourceProps<E>, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return RepositoryEventSource.use((source) => source(props, process));
}

export type RepositoryEventSourceService = <
  E extends readonly WebhookEventName[] = readonly WebhookEventName[],
  Req = never,
>(
  props: RepositoryEventSourceProps<E>,
  process: (
    event: WebhookEvent<SelectedEvent<E>>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class RepositoryEventSource extends Context.Service<
  RepositoryEventSource,
  RepositoryEventSourceService
>()("GitHub.RepositoryEventSource") {}

/**
 * Deterministic delivery path for a repository's webhook. Shared by the
 * deploy-time policy (which registers the webhook URL) and the runtime
 * (which only claims requests on this path), so both sides agree.
 */
export const webhookPath = (props: RepositoryRef & { path?: string }): string =>
  props.path ?? `/__alchemy/github/${props.owner}/${props.repository}`;

/**
 * Deterministic env var name under which the deploy-time policy stores the
 * webhook secret on the host, so the runtime can read it back to verify
 * signatures.
 */
export const webhookSecretEnvName = (repository: RepositoryRef): string =>
  `ALCHEMY_GITHUB_WEBHOOK_SECRET_${sanitizeKey(repository.owner)}_${sanitizeKey(
    repository.repository,
  )}`;
