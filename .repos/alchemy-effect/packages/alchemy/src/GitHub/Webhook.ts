import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";
import type { WebhookEventName } from "./RepositoryEventSource.ts";

export interface WebhookProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * The URL that GitHub will `POST` events to. Accepts an `Output<string>`
   * (e.g. a Cloudflare Worker's `url`) so the webhook can target a
   * resource provisioned in the same stack.
   */
  url: Input<string>;

  /**
   * GitHub event names to subscribe to (e.g. `["push", "pull_request"]`).
   * Use `["*"]` to receive every event GitHub emits.
   * @default ["push"]
   */
  events?: WebhookEventName[];

  /**
   * Secret used to sign each delivery with `HMAC-SHA256`. The signature is
   * sent in the `X-Hub-Signature-256` header so the receiver can verify the
   * payload originated from GitHub. Wrap with `Redacted.make` to keep it out
   * of logs and state.
   */
  secret?: Redacted.Redacted<string>;

  /**
   * Payload media type.
   * @default "json"
   */
  contentType?: "json" | "form";

  /**
   * Whether deliveries are active.
   * @default true
   */
  active?: boolean;

  /**
   * Skip TLS verification of the delivery URL (`insecure_ssl`). Only use for
   * local/testing endpoints.
   * @default false
   */
  insecureSsl?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Webhook extends Resource<
  "GitHub.Webhook",
  WebhookProps,
  {
    /**
     * Numeric ID of the webhook in GitHub.
     */
    webhookId: number;

    /**
     * The configured delivery URL.
     */
    url: string;

    /**
     * URL used by GitHub to send a `ping` event.
     */
    pingUrl: string | undefined;

    /**
     * URL used by GitHub to re-deliver the last event.
     */
    testUrl: string | undefined;

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository webhook.
 *
 * `Webhook` manages the lifecycle of a repository webhook that `POST`s
 * events to a delivery URL. It is created on the first deploy and updated
 * in place on subsequent deploys, and is deleted when the resource is
 * destroyed.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (env, stored PAT, or `gh` CLI). The token needs
 * `repo` scope (admin access to the repository) to manage webhooks.
 *
 * Most users don't construct `Webhook` directly — prefer
 * {@link import("./RepositoryEventSource.ts").events | events(repository, handler)}
 * inside a Cloudflare Worker, which provisions the webhook, wires the
 * delivery URL to the Worker, and forwards verified events to your handler.
 * @resource
 * @section Creating a Webhook
 * @example Forward push events to a URL
 * ```typescript
 * yield* GitHub.Webhook("ci-webhook", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   url: "https://example.com/github",
 *   events: ["push", "pull_request"],
 *   secret: Redacted.make(process.env.WEBHOOK_SECRET!),
 * });
 * ```
 *
 * @example Point a webhook at a Worker
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", { ... });
 *
 * yield* GitHub.Webhook("repo-webhook", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   url: worker.url!,
 *   events: ["*"],
 * });
 * ```
 */
export const Webhook = Resource<Webhook>("GitHub.Webhook");

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookId"],

    // A webhook belongs to (host, owner, repository) — its server-assigned
    // id is meaningless in any other repo, so moving it replaces the
    // resource: the engine creates the new webhook first, then `delete`
    // removes the old one from the old repo. Everything else (url, events,
    // secret, active) is mutated in place by `reconcile`. Replacement is
    // safe here — a webhook is declarative config that is fully
    // re-creatable from props.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl);

      const config = {
        url: news.url as string,
        content_type: news.contentType ?? "json",
        secret: news.secret ? Redacted.value(news.secret) : undefined,
        insecure_ssl: news.insecureSsl ? "1" : "0",
      };
      const events = news.events ?? ["push"];
      const active = news.active ?? true;

      // Observe — GitHub assigns the hook id server-side. Probe for live
      // state via the cached id; a 404 (deleted out-of-band, or never
      // created) collapses to "no observed webhook" so we converge by
      // creating a fresh one.
      const observed = output?.webhookId
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.repos.getWebhook({
                  owner: news.owner,
                  repo: news.repository,
                  hook_id: output.webhookId,
                });
                return data;
              } catch (error: any) {
                if (error.status === 404) return undefined;
                throw error;
              }
            },
            catch: (e) => e as Error,
          })
        : undefined;

      // Ensure — POST creates the webhook.
      if (observed === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.repos.createWebhook({
            owner: news.owner,
            repo: news.repository,
            name: "web",
            active,
            events,
            config,
          }),
        );
        return toAttrs(data);
      }

      // Sync — PATCH the existing webhook with the desired config. The
      // secret can never be read back, so we always send the full config
      // to converge rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.repos.updateWebhook({
          owner: news.owner,
          repo: news.repository,
          hook_id: observed.id,
          active,
          events,
          config,
        }),
      );
      return toAttrs(data);
    }),

    // GitHub has no global webhook list — hooks are repo-scoped. Enumerate every
    // repository the authenticated token can see, then list each repo's webhooks.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      // `octokit.paginate` walks every page and flattens to a single array.
      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      });

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.tryPromise({
            try: async () => {
              try {
                const hooks = await octokit.paginate(
                  octokit.rest.repos.listWebhooks,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                );
                return hooks.map(toAttrs);
              } catch (error: any) {
                // Repos where the token lacks admin access reject the webhooks
                // endpoint with 403/404 — skip them per the per-item not-found
                // rule rather than failing the whole enumeration.
                if (error.status === 403 || error.status === 404) {
                  return [];
                }
                throw error;
              }
            },
            catch: (e) => e as Error,
          }),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.repos.deleteWebhook({
            owner: olds.owner,
            repo: olds.repository,
            hook_id: output.webhookId,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });

const toAttrs = (data: {
  id: number;
  config?: { url?: string } | null;
  ping_url?: string | null;
  test_url?: string | null;
  updated_at?: string | null;
}): Webhook["Attributes"] => ({
  webhookId: data.id,
  url: data.config?.url ?? "",
  pingUrl: data.ping_url ?? undefined,
  testUrl: data.test_url ?? undefined,
  updatedAt: data.updated_at ?? new Date().toISOString(),
});
