import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord } from "./common.ts";

export interface OpenIDConnectProviderProps {
  /**
   * The identity provider URL.
   */
  url: string;
  /**
   * Client IDs allowed for the provider. AWS rejects requests with an
   * empty list, so the prop is typed as a non-empty tuple.
   */
  clientIDList?: [string, ...string[]];
  /**
   * Certificate thumbprints for the provider. AWS auto-manages thumbprints
   * for well-known IdPs (e.g. GitHub Actions), so this is optional — but
   * `iam.updateOpenIDConnectProviderThumbprint` rejects an empty list, so
   * the prop is typed as a non-empty tuple when supplied.
   */
  thumbprintList?: [string, ...string[]];
  /**
   * User-defined tags to apply to the provider.
   */
  tags?: Record<string, string>;
}

export interface OpenIDConnectProvider extends Resource<
  "AWS.IAM.OpenIDConnectProvider",
  OpenIDConnectProviderProps,
  {
    openIDConnectProviderArn: string;
    url: string;
    clientIDList: string[];
    /**
     * Reflects the desired state — `undefined` when the user opted out of
     * managing thumbprints (AWS auto-manages them for well-known IdPs).
     */
    thumbprintList: string[] | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM OpenID Connect provider for web identity federation.
 *
 * `OpenIDConnectProvider` registers an external OIDC issuer so IAM roles can be
 * assumed through web identity federation flows such as GitHub Actions.
 *
 * @section Federating with OIDC
 * @example Create a GitHub Actions OIDC Provider
 * ```typescript
 * const oidc = yield* OpenIDConnectProvider("GithubOidc", {
 *   url: "https://token.actions.githubusercontent.com",
 *   clientIDList: ["sts.amazonaws.com"],
 *   thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
 * });
 * ```
 */
export const OpenIDConnectProvider = Resource<OpenIDConnectProvider>(
  "AWS.IAM.OpenIDConnectProvider",
);

export const OpenIDConnectProviderProvider = () =>
  Provider.effect(
    OpenIDConnectProvider,
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment;
      const oidcArnFromUrl = (url: string) =>
        `arn:aws:iam::${accountId}:oidc-provider/${url.replace(/^https?:\/\//, "")}`;

      const readProvider = Effect.fn(function* (providerArn: string) {
        const response = yield* iam
          .getOpenIDConnectProvider({
            OpenIDConnectProviderArn: providerArn,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response;
      });

      return {
        stables: ["openIDConnectProviderArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.url !== news.url) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const providerArn =
            output?.openIDConnectProviderArn ?? oidcArnFromUrl(olds.url);
          const provider = yield* readProvider(providerArn);
          if (!provider?.Url) {
            return undefined;
          }
          const tags = yield* iam.listOpenIDConnectProviderTags({
            OpenIDConnectProviderArn: providerArn,
          });
          return {
            openIDConnectProviderArn: providerArn,
            url: provider.Url,
            clientIDList: provider.ClientIDList ?? [],
            thumbprintList: provider.ThumbprintList ?? [],
            tags: toTagRecord(tags.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // The OIDC provider's ARN is deterministic from its URL, so we
          // can observe with or without prior output.
          const providerArn =
            output?.openIDConnectProviderArn ?? oidcArnFromUrl(news.url);

          // Observe — read the live provider; absent when missing.
          let observed = yield* readProvider(providerArn);
          let observedClientIds: string[] = [];
          let observedThumbprints: string[] = [];
          let observedTags: Record<string, string> = {};

          if (observed?.Url) {
            observedClientIds = observed.ClientIDList ?? [];
            observedThumbprints = observed.ThumbprintList ?? [];
            const tagsResp = yield* iam.listOpenIDConnectProviderTags({
              OpenIDConnectProviderArn: providerArn,
            });
            observedTags = toTagRecord(tagsResp.Tags);
          }

          // Ensure — create the provider when it is missing. The API does
          // not return idempotently for OIDC, but the deterministic ARN
          // means a race manifests as `EntityAlreadyExistsException`.
          if (!observed?.Url) {
            yield* iam
              .createOpenIDConnectProvider({
                Url: news.url,
                ClientIDList: news.clientIDList,
                ThumbprintList: news.thumbprintList,
                Tags: Object.entries(news.tags ?? {}).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "EntityAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            observed = yield* readProvider(providerArn);
            observedClientIds = observed?.ClientIDList ?? [];
            observedThumbprints = observed?.ThumbprintList ?? [];
            const tagsResp = yield* iam.listOpenIDConnectProviderTags({
              OpenIDConnectProviderArn: providerArn,
            });
            observedTags = toTagRecord(tagsResp.Tags);
          }

          // Sync client IDs against the observed list.
          const desiredClientIds = news.clientIDList ?? [];
          const observedClientSet = new Set(observedClientIds);
          const desiredClientSet = new Set(desiredClientIds);
          for (const clientId of desiredClientIds) {
            if (!observedClientSet.has(clientId)) {
              yield* iam.addClientIDToOpenIDConnectProvider({
                OpenIDConnectProviderArn: providerArn,
                ClientID: clientId,
              });
            }
          }
          for (const clientId of observedClientIds) {
            if (!desiredClientSet.has(clientId)) {
              yield* iam.removeClientIDFromOpenIDConnectProvider({
                OpenIDConnectProviderArn: providerArn,
                ClientID: clientId,
              });
            }
          }

          // Sync thumbprints — `updateOpenIDConnectProviderThumbprint`
          // replaces the entire list, so call it whenever the set differs.
          // When the user didn't request a list we leave the cloud-managed
          // thumbprints alone (AWS auto-manages for well-known IdPs).
          const desiredThumbprints = news.thumbprintList;
          if (
            desiredThumbprints &&
            JSON.stringify([...observedThumbprints].sort()) !==
              JSON.stringify([...desiredThumbprints].sort())
          ) {
            yield* iam.updateOpenIDConnectProviderThumbprint({
              OpenIDConnectProviderArn: providerArn,
              ThumbprintList: desiredThumbprints,
            });
          }

          // Sync tags against the observed cloud tags.
          const desiredTags = news.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagOpenIDConnectProvider({
              OpenIDConnectProviderArn: providerArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagOpenIDConnectProvider({
              OpenIDConnectProviderArn: providerArn,
              TagKeys: removed,
            });
          }

          yield* session.note(providerArn);
          return {
            openIDConnectProviderArn: providerArn,
            url: news.url,
            clientIDList: desiredClientIds,
            thumbprintList: desiredThumbprints,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteOpenIDConnectProvider({
              OpenIDConnectProviderArn: output.openIDConnectProviderArn,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
