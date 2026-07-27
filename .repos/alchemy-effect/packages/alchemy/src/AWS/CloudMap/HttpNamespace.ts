import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitOperation,
  ensureNamespace,
  fetchObservedTags,
  observeNamespace,
  retryWhileResourceInUse,
  syncTags,
} from "./internal.ts";

export interface HttpNamespaceProps {
  /**
   * Name of the namespace. Changing the name replaces the namespace.
   * @default a generated DNS-compatible physical name
   */
  name?: string;
  /**
   * A description for the namespace.
   */
  description?: string;
  /**
   * Tags to apply to the namespace. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface HttpNamespace extends Resource<
  "AWS.CloudMap.HttpNamespace",
  HttpNamespaceProps,
  {
    /**
     * The unique identifier of the namespace.
     */
    namespaceId: string;
    /**
     * The ARN of the namespace.
     */
    namespaceArn: string;
    /**
     * Name of the namespace.
     */
    namespaceName: string;
    /**
     * The name clients use to discover instances via the HTTP discovery API.
     */
    httpName: string | undefined;
  },
  {},
  Providers
> {}

/**
 * An AWS Cloud Map HTTP namespace — an API-only service registry. Instances
 * registered in an HTTP namespace are discoverable via the
 * `DiscoverInstances` API but not via DNS, so no VPC or hosted zone is
 * required.
 *
 * Namespace creation and deletion are asynchronous — the provider polls the
 * Cloud Map operations API (bounded) until they complete.
 * @resource
 * @section Creating Namespaces
 * @example HTTP Namespace
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const namespace = yield* AWS.CloudMap.HttpNamespace("AppNamespace", {
 *   description: "API-only service discovery",
 * });
 * ```
 *
 * @section Registering Services
 * @example API-only Service
 * ```typescript
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 * });
 * ```
 */
export const HttpNamespace = Resource<HttpNamespace>(
  "AWS.CloudMap.HttpNamespace",
);

export const HttpNamespaceProvider = () =>
  Provider.effect(
    HttpNamespace,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 253, lowercase: true }))
        );
      });

      const toAttributes = (namespace: sd.Namespace) => ({
        namespaceId: namespace.Id!,
        namespaceArn: namespace.Arn!,
        namespaceName: namespace.Name!,
        httpName: namespace.Properties?.HttpProperties?.HttpName,
      });

      return HttpNamespace.Provider.of({
        stables: ["namespaceId", "namespaceArn", "namespaceName", "httpName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sd.listNamespaces
              .pages({
                Filters: [{ Name: "TYPE", Values: ["HTTP"], Condition: "EQ" }],
              })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Namespaces ?? [])
              .filter(
                (n) =>
                  n.Id !== undefined &&
                  n.Arn !== undefined &&
                  n.Name !== undefined,
              )
              .map((n) => ({
                namespaceId: n.Id!,
                namespaceArn: n.Arn!,
                namespaceName: n.Name!,
                httpName: n.Properties?.HttpProperties?.HttpName,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.namespaceName ?? (yield* createName(id, olds ?? {}));
          const namespace = yield* observeNamespace(
            "HTTP",
            name,
            output?.namespaceId,
          );
          if (namespace?.Id === undefined) {
            return undefined;
          }
          const attrs = toAttributes(namespace);
          const tags = yield* fetchObservedTags(attrs.namespaceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // description/tags fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = output?.namespaceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let namespace = yield* observeNamespace(
            "HTTP",
            name,
            output?.namespaceId,
          );

          // 2. ENSURE — create if missing (async operation); the created
          // namespace is observed by the operation's target id, riding out
          // a same-name predecessor still deleting (see ensureNamespace)
          if (namespace === undefined) {
            yield* session.note(`creating HTTP namespace ${name} (async)...`);
            namespace = yield* ensureNamespace(
              "HTTP",
              name,
              sd.createHttpNamespace({
                Name: name,
                Description: news.description,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            );
          }
          if (namespace?.Id === undefined) {
            return yield* Effect.fail(
              new sd.NamespaceNotFound({
                Message: `namespace ${name} not visible after create`,
              }),
            );
          }

          // 3. SYNC — description (updateHttpNamespace requires Description)
          if (
            news.description !== undefined &&
            news.description !== namespace.Description
          ) {
            const update = yield* sd.updateHttpNamespace({
              Id: namespace.Id,
              Namespace: { Description: news.description },
            });
            if (update.OperationId !== undefined) {
              yield* awaitOperation(update.OperationId);
            }
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = yield* fetchObservedTags(namespace.Arn!);
          yield* syncTags(namespace.Arn!, observedTags, desiredTags);

          yield* session.note(namespace.Id);
          return toAttributes(namespace);
        }),

        delete: Effect.fn(function* ({ output }) {
          const deleted = yield* retryWhileResourceInUse(
            sd.deleteNamespace({ Id: output.namespaceId }),
          ).pipe(
            Effect.catchTag("NamespaceNotFound", () =>
              Effect.succeed({ OperationId: undefined }),
            ),
            // an identical delete is already in flight — await THAT operation
            // instead of silently skipping the deletion
            Effect.catchTag("DuplicateRequest", (e) =>
              Effect.succeed({ OperationId: e.DuplicateOperationId }),
            ),
          );
          if (deleted.OperationId !== undefined) {
            yield* awaitOperation(deleted.OperationId);
          }
        }),
      });
    }),
  );
