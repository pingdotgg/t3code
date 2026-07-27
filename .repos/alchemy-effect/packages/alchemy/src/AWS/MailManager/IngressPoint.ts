import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readMailManagerTags,
  repeatUntilMailManagerStable,
  retryWhileMailManagerConflict,
  sameShape,
  syncMailManagerTags,
} from "./internal.ts";

export interface IngressPointProps {
  /**
   * Name of the ingress point. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Renames apply in place.
   */
  ingressPointName?: string;
  /**
   * Type of the ingress endpoint: `OPEN` accepts unauthenticated SMTP;
   * `AUTH` requires SMTP AUTH credentials (see
   * {@link IngressPointProps.ingressPointConfiguration}); `MTLS` requires
   * client certificates. Immutable — changing the type replaces the ingress
   * point.
   */
  type: mm.IngressPointType;
  /**
   * ID of the rule set applied to email arriving through this ingress
   * point. Updates apply in place.
   */
  ruleSetId: string;
  /**
   * ID of the traffic policy evaluated against connections to this ingress
   * point. Updates apply in place.
   */
  trafficPolicyId: string;
  /**
   * Authentication configuration for `AUTH`/`MTLS` ingress points: an SMTP
   * password, a Secrets Manager secret ARN, or a TLS trust store. Updates
   * apply in place.
   */
  ingressPointConfiguration?: mm.IngressPointConfiguration;
  /**
   * Network configuration: public (with IP type) or VPC-endpoint private.
   * Immutable — changing it replaces the ingress point.
   * @default public IPV4
   */
  networkConfiguration?: mm.NetworkConfiguration;
  /**
   * TLS policy for inbound connections: `REQUIRED`, `OPTIONAL`, or `FIPS`.
   * Omitting it applies AWS's `FIPS` default. Changes between `REQUIRED` and
   * `OPTIONAL` update in place; AWS rejects updates from or to `FIPS`
   * (including the omitted default), so those transitions replace the
   * ingress point.
   */
  tlsPolicy?: mm.TlsPolicy;
  /**
   * Tags applied to the ingress point. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface IngressPoint extends Resource<
  "AWS.MailManager.IngressPoint",
  IngressPointProps,
  {
    /** Server-assigned ID of the ingress point. */
    ingressPointId: string;
    /** ARN of the ingress point. */
    ingressPointArn: string;
    /** Name of the ingress point. */
    ingressPointName: string;
    /** DNS A record (SMTP endpoint host) of the ingress point. */
    aRecord: string | undefined;
    /** Current status (PROVISIONING, ACTIVE, CLOSED, FAILED, ...). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager ingress point — the SMTP endpoint that receives
 * incoming email, screens it with a traffic policy, and processes it with a
 * rule set.
 *
 * `type` and `networkConfiguration` are immutable (changes replace the
 * endpoint); everything else updates in place.
 * @resource
 * @section Creating Ingress Points
 * @example Open Ingress Point
 * ```typescript
 * import * as MailManager from "alchemy/AWS/MailManager";
 *
 * const ruleSet = yield* MailManager.RuleSet("Inbound", {
 *   rules: [{ Name: "DropAll", Actions: [{ Drop: {} }] }],
 * });
 * const trafficPolicy = yield* MailManager.TrafficPolicy("Edge", {
 *   defaultAction: "ALLOW",
 * });
 * const ingress = yield* MailManager.IngressPoint("Smtp", {
 *   type: "OPEN",
 *   ruleSetId: ruleSet.ruleSetId,
 *   trafficPolicyId: trafficPolicy.trafficPolicyId,
 * });
 * // point your domain's MX record at ingress.aRecord
 * ```
 *
 * @example Authenticated Ingress Point
 * ```typescript
 * const ingress = yield* MailManager.IngressPoint("Smtp", {
 *   type: "AUTH",
 *   ruleSetId: ruleSet.ruleSetId,
 *   trafficPolicyId: trafficPolicy.trafficPolicyId,
 *   ingressPointConfiguration: { SecretArn: secret.secretArn },
 *   tlsPolicy: "REQUIRED",
 * });
 * ```
 */
export const IngressPoint = Resource<IngressPoint>(
  "AWS.MailManager.IngressPoint",
);

export const IngressPointProvider = () =>
  Provider.effect(
    IngressPoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { ingressPointName?: string },
      ) {
        return (
          props.ingressPointName ??
          (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }))
        );
      });

      const getById = (ingressPointId: string) =>
        mm
          .getIngressPoint({ IngressPointId: ingressPointId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (name: string) =>
        mm.listIngressPoints.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.IngressPoints ?? [])
              .find((p) => p.IngressPointName === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: IngressPoint["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.ingressPointId !== undefined) {
          const found = yield* getById(output.ingressPointId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.IngressPointId === undefined) return undefined;
        return yield* getById(summary.IngressPointId);
      });

      // Provisioning/updating is asynchronous — wait (bounded, ~2 min) for
      // the endpoint to leave its transitional state before mutating it.
      const waitForStable = (ingressPointId: string) =>
        repeatUntilMailManagerStable(
          getById(ingressPointId),
          (r) =>
            r === undefined ||
            (r.Status !== "PROVISIONING" && r.Status !== "UPDATING"),
        );

      const toAttrs = Effect.fn(function* (
        ingress: mm.GetIngressPointResponse,
      ) {
        if (ingress.IngressPointArn === undefined) {
          return yield* Effect.fail(
            new Error(
              `Mail Manager ingress point '${ingress.IngressPointId}' returned without an ARN`,
            ),
          );
        }
        return {
          ingressPointId: ingress.IngressPointId,
          ingressPointArn: ingress.IngressPointArn,
          ingressPointName: ingress.IngressPointName,
          aRecord: ingress.ARecord,
          status: ingress.Status,
        };
      });

      return IngressPoint.Provider.of({
        stables: ["ingressPointId", "ingressPointArn"],

        list: () =>
          mm.listIngressPoints.pages({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.forEach(
                Array.from(chunk)
                  .flatMap((page) => page.IngressPoints ?? [])
                  .map((p) => p.IngressPointId),
                (ingressPointId) => getById(ingressPointId),
              ),
            ),
            Effect.flatMap((results) =>
              Effect.forEach(
                results.flatMap((p) => (p === undefined ? [] : [p])),
                (p) => toAttrs(p),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.ingressPointName ?? (yield* createName(id, olds ?? {}));
          const ingress = yield* observe(output, name);
          if (ingress === undefined) return undefined;
          const attrs = yield* toAttrs(ingress);
          const tags = yield* readMailManagerTags(attrs.ingressPointArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // `type` and `networkConfiguration` are create-only — changing
        // either replaces the ingress point. TlsPolicy transitions from or
        // to FIPS (including the omitted-default, which AWS creates as
        // FIPS) are rejected by UpdateIngressPoint, so they replace too.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (olds.type !== news.type) {
            return { action: "replace" } as const;
          }
          if (
            !sameShape(olds.networkConfiguration, news.networkConfiguration)
          ) {
            return { action: "replace" } as const;
          }
          if (olds.tlsPolicy !== news.tlsPolicy) {
            const fipsInvolved =
              olds.tlsPolicy === undefined ||
              news.tlsPolicy === undefined ||
              olds.tlsPolicy === "FIPS" ||
              news.tlsPolicy === "FIPS";
            if (fipsInvolved) return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE.
          let ingress = yield* observe(output, name);

          // 2. ENSURE — create if missing; a Conflict race re-observes.
          if (ingress === undefined) {
            yield* session.note(`creating ingress point ${name}`);
            const created = yield* mm
              .createIngressPoint({
                IngressPointName: name,
                Type: news.type,
                RuleSetId: news.ruleSetId,
                TrafficPolicyId: news.trafficPolicyId,
                IngressPointConfiguration: news.ingressPointConfiguration,
                NetworkConfiguration: news.networkConfiguration,
                TlsPolicy: news.tlsPolicy,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            ingress =
              created !== undefined
                ? yield* getById(created.IngressPointId)
                : yield* observe(undefined, name);
          }
          if (ingress === undefined) {
            return yield* Effect.fail(
              new Error(
                `Mail Manager ingress point '${name}' not found after create`,
              ),
            );
          }

          // Provisioning is asynchronous — settle before mutating.
          const settled = yield* waitForStable(ingress.IngressPointId);
          ingress = settled ?? ingress;

          // 3. SYNC — diff OBSERVED state against desired. The auth
          //    configuration is write-only (the Get response only exposes
          //    password versions / secret ARN), so `olds` is used as a hint
          //    to push it when the prop changed.
          const configChanged =
            news.ingressPointConfiguration !== undefined &&
            !sameShape(
              olds?.ingressPointConfiguration,
              news.ingressPointConfiguration,
            );
          // AWS rejects any update from or to FIPS — those transitions go
          // through replacement (see diff), so only non-FIPS deltas are
          // pushed here.
          const tlsChanged =
            news.tlsPolicy !== undefined &&
            news.tlsPolicy !== "FIPS" &&
            ingress.TlsPolicy !== "FIPS" &&
            ingress.TlsPolicy !== news.tlsPolicy;
          if (
            ingress.IngressPointName !== name ||
            ingress.RuleSetId !== news.ruleSetId ||
            ingress.TrafficPolicyId !== news.trafficPolicyId ||
            tlsChanged ||
            configChanged
          ) {
            yield* mm.updateIngressPoint({
              IngressPointId: ingress.IngressPointId,
              IngressPointName: name,
              RuleSetId: news.ruleSetId,
              TrafficPolicyId: news.trafficPolicyId,
              IngressPointConfiguration: configChanged
                ? news.ingressPointConfiguration
                : undefined,
              TlsPolicy: tlsChanged ? news.tlsPolicy : undefined,
            });
            const updated = yield* waitForStable(ingress.IngressPointId);
            ingress = updated ?? ingress;
          }

          // 3b. SYNC TAGS.
          const attrs = yield* toAttrs(ingress);
          yield* syncMailManagerTags(attrs.ingressPointArn, desiredTags);

          yield* session.note(attrs.ingressPointId);
          return { ...attrs, ingressPointName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting mid-provision conflicts — retry through the window.
          yield* retryWhileMailManagerConflict(
            mm.deleteIngressPoint({ IngressPointId: output.ingressPointId }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deprovisioning is asynchronous and the endpoint keeps its rule
          // set and traffic policy "in use" until it is fully gone — wait
          // (bounded, ~3 min) so dependent deletes don't conflict.
          yield* repeatUntilMailManagerStable(
            getById(output.ingressPointId),
            (r) => r === undefined,
            36,
          );
        }),
      });
    }),
  );
