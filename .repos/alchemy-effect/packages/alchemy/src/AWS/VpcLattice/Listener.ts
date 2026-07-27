import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryOnConflict, waitUntilAbsent } from "./internal.ts";

/**
 * The action a listener (or rule) applies to matched traffic: forward to
 * weighted target groups or answer with a fixed HTTP status.
 */
export type ListenerAction = vpclattice.RuleAction;

export interface ListenerProps {
  /**
   * ID or ARN of the lattice service the listener belongs to. Immutable —
   * changing it replaces the listener.
   */
  serviceIdentifier: string;
  /**
   * Name of the listener. If omitted, a unique name is generated. Immutable —
   * changing it replaces the listener.
   */
  name?: string;
  /**
   * Listener protocol (`HTTP`, `HTTPS`, or `TLS_PASSTHROUGH`). Immutable —
   * changing it replaces the listener.
   */
  protocol: "HTTP" | "HTTPS" | "TLS_PASSTHROUGH";
  /**
   * Listener port. Defaults to the protocol's default port (80 for HTTP,
   * 443 for HTTPS). Immutable — changing it replaces the listener.
   */
  port?: number;
  /**
   * Action applied to requests that match no rule: forward to weighted
   * target groups or return a fixed response status.
   */
  defaultAction: ListenerAction;
  /**
   * User-defined tags to apply to the listener.
   */
  tags?: Record<string, string>;
}

export interface Listener extends Resource<
  "AWS.VpcLattice.Listener",
  ListenerProps,
  {
    /**
     * Service-assigned unique ID of the listener.
     */
    listenerId: string;
    /**
     * ARN of the listener.
     */
    listenerArn: string;
    /**
     * Physical name of the listener.
     */
    name: string;
    /**
     * Listener protocol.
     */
    protocol: string;
    /**
     * Listener port.
     */
    port?: number;
    /**
     * ID of the owning lattice service.
     */
    serviceId: string;
    /**
     * ARN of the owning lattice service.
     */
    serviceArn?: string;
    /**
     * Current tags reported for the listener.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon VPC Lattice listener — the process on a lattice service that
 * checks for connection requests on a protocol/port and routes them via its
 * default action and rules.
 *
 * @resource
 * @section Creating Listeners
 * @example HTTP Listener with a Fixed Default Response
 * ```typescript
 * const listener = yield* Listener("HttpListener", {
 *   serviceIdentifier: service.serviceId,
 *   protocol: "HTTP",
 *   port: 80,
 *   defaultAction: { fixedResponse: { statusCode: 404 } },
 * });
 * ```
 *
 * @example Listener Forwarding to a Target Group
 * ```typescript
 * const listener = yield* Listener("ApiListener", {
 *   serviceIdentifier: service.serviceId,
 *   protocol: "HTTP",
 *   defaultAction: {
 *     forward: {
 *       targetGroups: [
 *         { targetGroupIdentifier: targets.targetGroupId, weight: 100 },
 *       ],
 *     },
 *   },
 * });
 * ```
 */
export const Listener = Resource<Listener>("AWS.VpcLattice.Listener");

export const ListenerProvider = () =>
  Provider.effect(
    Listener,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const observe = (serviceIdentifier: string, listenerIdentifier: string) =>
        vpclattice
          .getListener({ serviceIdentifier, listenerIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (serviceIdentifier: string, name: string) =>
        vpclattice.listListeners
          .pages({ serviceIdentifier })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.items ?? [])
                .find((l) => l.name === name),
            ),
            Effect.flatMap((summary) =>
              summary?.id
                ? observe(serviceIdentifier, summary.id)
                : Effect.succeed(undefined),
            ),
          )
          .pipe(
            // The owning service may already be gone during teardown races.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: [
          "listenerId",
          "listenerArn",
          "name",
          "serviceId",
          "serviceArn",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.serviceIdentifier !== news.serviceIdentifier ||
            olds?.protocol !== news.protocol ||
            (olds?.port ?? undefined) !== news.port
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const serviceIdentifier =
            output?.serviceId ?? olds?.serviceIdentifier;
          if (!serviceIdentifier) return undefined;
          const listener = output?.listenerId
            ? yield* observe(serviceIdentifier, output.listenerId)
            : yield* findByName(
                serviceIdentifier,
                yield* toName(id, olds ?? {}),
              );
          if (!listener?.arn || !listener.id || !listener.serviceId) {
            return undefined;
          }
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: listener.arn,
          });
          const attrs = {
            listenerId: listener.id,
            listenerArn: listener.arn,
            name: listener.name!,
            protocol: listener.protocol ?? "HTTP",
            port: listener.port,
            serviceId: listener.serviceId,
            serviceArn: listener.serviceArn,
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the stable id cache, fall back to name lookup.
          let listener = output?.listenerId
            ? yield* observe(news.serviceIdentifier, output.listenerId)
            : yield* findByName(news.serviceIdentifier, name);

          // Ensure — create if missing.
          if (!listener?.arn || !listener.id) {
            listener = yield* retryOnConflict(
              vpclattice.createListener({
                serviceIdentifier: news.serviceIdentifier,
                name,
                protocol: news.protocol,
                port: news.port,
                defaultAction: news.defaultAction,
              }),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                findByName(news.serviceIdentifier, name),
              ),
            );
            if (!listener?.arn || !listener.id) {
              return yield* Effect.fail(
                new Error(`Failed to create listener ${name}`),
              );
            }
          } else if (
            JSON.stringify(listener.defaultAction) !==
            JSON.stringify(news.defaultAction)
          ) {
            // Sync default action — the only mutable setting.
            yield* retryOnConflict(
              vpclattice.updateListener({
                serviceIdentifier: news.serviceIdentifier,
                listenerIdentifier: listener.id,
                defaultAction: news.defaultAction,
              }),
            );
          }

          yield* syncTags(listener.arn, desiredTags);

          yield* session.note(listener.arn);
          return {
            listenerId: listener.id,
            listenerArn: listener.arn,
            name,
            protocol: listener.protocol ?? news.protocol,
            port: listener.port,
            serviceId: listener.serviceId ?? news.serviceIdentifier,
            serviceArn: listener.serviceArn,
            tags: desiredTags,
          };
        }),
        // Sub-resource: listeners are keyed by their owning lattice service
        // and are removed with it, so nuke has nothing to enumerate.
        list: () => Effect.succeed([] as Listener["Attributes"][]),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            vpclattice.deleteListener({
              serviceIdentifier: output.serviceId,
              listenerIdentifier: output.listenerId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* waitUntilAbsent(observe(output.serviceId, output.listenerId));
        }),
      };
    }),
  );
