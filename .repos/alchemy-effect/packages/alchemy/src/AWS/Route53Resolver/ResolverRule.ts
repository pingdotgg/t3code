import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  fetchResolverTags,
  syncResolverTags,
  toResolverTagList,
} from "./internal.ts";

export interface ResolverRuleTargetIp {
  /**
   * IPv4 address of the DNS resolver on your network that queries are
   * forwarded to.
   */
  ip?: string;
  /**
   * IPv6 address of the DNS resolver on your network.
   */
  ipv6?: string;
  /**
   * Port the target resolver listens on.
   * @default 53
   */
  port?: number;
  /**
   * Protocol used to reach the target.
   * @default "Do53"
   */
  protocol?: "Do53" | "DoH";
}

export interface ResolverRuleProps {
  /**
   * Friendly name of the rule. Also used as the `CreatorRequestId`.
   * Changing it forces replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * How Resolver handles queries for `domainName`. Only `FORWARD` rules
   * can carry `targetIps`. Changing it forces replacement.
   * @default "FORWARD"
   */
  ruleType?: "FORWARD" | "SYSTEM" | "RECURSIVE" | "DELEGATE";
  /**
   * Domain name that DNS queries are matched against (longest suffix
   * match). Changing it forces replacement.
   */
  domainName: string;
  /**
   * IP addresses of the DNS resolvers on your network that matching
   * queries are forwarded to. Updatable in place.
   */
  targetIps?: ResolverRuleTargetIp[];
  /**
   * ID of the OUTBOUND resolver endpoint the forwarded queries pass
   * through. Updatable in place.
   */
  resolverEndpointId?: string;
  /**
   * Tags to apply to the rule. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ResolverRule extends Resource<
  "AWS.Route53Resolver.ResolverRule",
  ResolverRuleProps,
  {
    /**
     * ID of the resolver rule (e.g. `rslvr-rr-...`).
     */
    resolverRuleId: string;
    /**
     * ARN of the resolver rule.
     */
    resolverRuleArn: string;
    /**
     * Name of the rule.
     */
    name: string;
    /**
     * Domain name the rule matches (as stored by Route 53 Resolver, with a
     * trailing dot).
     */
    domainName: string;
  },
  never,
  Providers
> {}

/**
 * A Route 53 Resolver rule — tells Resolver how to handle DNS queries for a
 * domain that originate in your VPCs.
 *
 * A `FORWARD` rule sends matching queries through an OUTBOUND
 * `ResolverEndpoint` to the DNS resolvers on your network listed in
 * `targetIps`. The rule takes effect in a VPC once attached with a
 * `ResolverRuleAssociation`.
 * @resource
 * @section Forwarding Rules
 * @example Forward a Domain to On-Prem Resolvers
 * ```typescript
 * import * as Route53Resolver from "alchemy/AWS/Route53Resolver";
 *
 * const rule = yield* Route53Resolver.ResolverRule("CorpForward", {
 *   domainName: "corp.example.com",
 *   resolverEndpointId: outbound.resolverEndpointId,
 *   targetIps: [{ ip: "192.168.1.10" }, { ip: "192.168.1.11", port: 53 }],
 * });
 * ```
 *
 * @section Attaching to VPCs
 * @example Associate the Rule with a VPC
 * ```typescript
 * const association = yield* Route53Resolver.ResolverRuleAssociation(
 *   "CorpForwardAssoc",
 *   {
 *     resolverRuleId: rule.resolverRuleId,
 *     vpcId: vpc.vpcId,
 *   },
 * );
 * ```
 */
export const ResolverRule = Resource<ResolverRule>(
  "AWS.Route53Resolver.ResolverRule",
);

/**
 * Creating a FORWARD rule can transiently fail while its OUTBOUND endpoint
 * is still provisioning (`ResourceUnavailableException`), and recreating a
 * rule whose deterministic `CreatorRequestId` is held by a `DELETING`
 * predecessor raises `ResourceExistsException`. Both are bounded races —
 * retry (~2 min).
 *
 * Explicitly typed: inlining `Effect.retry` in provider lifecycle code can
 * widen the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
const retryRuleCreateRaces = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ResourceUnavailableException" ||
      e._tag === "ResourceExistsException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
  });

/**
 * A rule cannot be deleted while it is still associated with VPCs
 * (`ResourceInUseException`). Association teardown is asynchronous, so
 * retry deletion on a bounded schedule (~60s) while associations drain.
 *
 * @internal
 */
const retryRuleInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ResourceInUseException" ||
      e._tag === "InvalidRequestException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

/**
 * Route 53 Resolver stores domain names lowercased with a trailing dot;
 * normalize both sides before comparing.
 *
 * @internal
 */
const normalizeDomain = (domain: string) =>
  domain.toLowerCase().replace(/\.+$/, "");

export const ResolverRuleProvider = () =>
  Provider.effect(
    ResolverRule,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const getRule = (ruleId: string) =>
        r53r.getResolverRule({ ResolverRuleId: ruleId }).pipe(
          Effect.map((r) => r.ResolverRule),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const observe = Effect.fn(function* (
        name: string,
        ruleId: string | undefined,
      ) {
        if (ruleId !== undefined) {
          const byId = yield* getRule(ruleId);
          if (byId !== undefined && byId.Status !== "DELETING") {
            return byId;
          }
        }
        return yield* r53r.listResolverRules
          .items({
            Filters: [{ Name: "CreatorRequestId", Values: [name] }],
          })
          .pipe(
            Stream.filter((rule) => rule.Status !== "DELETING"),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      });

      // Desired-vs-observed comparison of target IPs, tolerant of the
      // defaults Route 53 Resolver fills in (port 53, protocol Do53).
      const targetKey = (targets: readonly r53r.TargetAddress[]) =>
        targets
          .map(
            (t) =>
              `${t.Ip ?? ""}|${t.Ipv6 ?? ""}|${t.Port ?? 53}|${t.Protocol ?? "Do53"}`,
          )
          .sort()
          .join(",");
      const toWireTargets = (
        targets: readonly ResolverRuleTargetIp[],
      ): r53r.TargetAddress[] =>
        targets.map((t) => ({
          Ip: t.ip,
          Ipv6: t.ipv6,
          Port: t.port,
          Protocol: t.protocol,
        }));

      return ResolverRule.Provider.of({
        stables: ["resolverRuleId", "resolverRuleArn", "name", "domainName"],
        // Top-level resource: enumerate every resolver rule in the ambient
        // account/region (includes AWS-managed SYSTEM rules, which read as
        // Unowned).
        list: () =>
          r53r.listResolverRules.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ResolverRules ?? [])
                .flatMap((rule) =>
                  rule.Id !== undefined &&
                  rule.Arn !== undefined &&
                  // Autodefined rules (e.g. the Internet Resolver rule for
                  // `.`, id `rslvr-autodefined-rr-internet-resolver`) are
                  // owned by Route 53 Resolver itself and can never be
                  // deleted — keep them out of enumeration for account-wide
                  // teardown (nuke).
                  !rule.Id.startsWith("rslvr-autodefined")
                    ? [
                        {
                          resolverRuleId: rule.Id,
                          resolverRuleArn: rule.Arn,
                          name: rule.Name ?? "",
                          domainName: rule.DomainName ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const rule = yield* observe(name, output?.resolverRuleId);
          if (rule?.Id === undefined || rule.Arn === undefined) {
            return undefined;
          }
          const attrs = {
            resolverRuleId: rule.Id,
            resolverRuleArn: rule.Arn,
            name: rule.Name ?? name,
            domainName: rule.DomainName ?? "",
          };
          const tags = yield* fetchResolverTags(rule.Arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        // Replacement detection: domain name and rule type are immutable;
        // target IPs and the endpoint reference update in place.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if ((olds.ruleType ?? "FORWARD") !== (news.ruleType ?? "FORWARD")) {
            return { action: "replace" } as const;
          }
          if (
            normalizeDomain(olds.domainName) !==
            normalizeDomain(news.domainName)
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let rule = yield* observe(name, output?.resolverRuleId);

          // 2. ENSURE — create if missing, riding out the bounded races
          //    (endpoint still provisioning, DELETING predecessor).
          if (rule === undefined) {
            yield* session.note(`creating resolver rule ${name}`);
            rule = yield* retryRuleCreateRaces(
              r53r.createResolverRule({
                CreatorRequestId: name,
                Name: name,
                RuleType: news.ruleType ?? "FORWARD",
                DomainName: news.domainName,
                TargetIps: news.targetIps
                  ? toWireTargets(news.targetIps)
                  : undefined,
                ResolverEndpointId: news.resolverEndpointId,
                Tags: toResolverTagList(desiredTags),
              }),
            ).pipe(Effect.map((r) => r.ResolverRule!));
          }
          const ruleId = rule.Id!;

          // 3. SYNC — name, target IPs, and the endpoint reference are
          //    mutable via UpdateResolverRule. Diff observed against
          //    desired; skip the API on no-op.
          const desiredTargets = news.targetIps
            ? toWireTargets(news.targetIps)
            : undefined;
          const targetsDelta =
            desiredTargets !== undefined &&
            targetKey(rule.TargetIps ?? []) !== targetKey(desiredTargets);
          const endpointDelta =
            news.resolverEndpointId !== undefined &&
            rule.ResolverEndpointId !== news.resolverEndpointId;
          const nameDelta = rule.Name !== name;
          if (targetsDelta || endpointDelta || nameDelta) {
            rule = yield* r53r
              .updateResolverRule({
                ResolverRuleId: ruleId,
                Config: {
                  ...(nameDelta ? { Name: name } : {}),
                  ...(targetsDelta ? { TargetIps: desiredTargets } : {}),
                  ...(endpointDelta
                    ? { ResolverEndpointId: news.resolverEndpointId }
                    : {}),
                },
              })
              .pipe(Effect.map((r) => r.ResolverRule ?? rule!));
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const arn = rule.Arn!;
          yield* syncResolverTags(arn, desiredTags);

          yield* session.note(ruleId);
          return {
            resolverRuleId: ruleId,
            resolverRuleArn: arn,
            name: rule.Name ?? name,
            domainName: rule.DomainName ?? news.domainName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A rule associated with VPCs cannot be deleted — disassociate all
          // associations first (idempotent: a vanished association is
          // already gone).
          const associations = yield* r53r.listResolverRuleAssociations
            .pages({
              Filters: [
                { Name: "ResolverRuleId", Values: [output.resolverRuleId] },
              ],
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.ResolverRuleAssociations ?? [],
                ),
              ),
              Effect.catch(() =>
                Effect.succeed([] as r53r.ResolverRuleAssociation[]),
              ),
            );
          yield* Effect.forEach(
            associations,
            (assoc) =>
              assoc.VPCId
                ? r53r
                    .disassociateResolverRule({
                      ResolverRuleId: output.resolverRuleId,
                      VPCId: assoc.VPCId,
                    })
                    .pipe(
                      Effect.catchTag("ResourceNotFoundException", () =>
                        Effect.succeed(undefined),
                      ),
                      Effect.asVoid,
                    )
                : Effect.void,
            { discard: true },
          );
          yield* retryRuleInUse(
            r53r.deleteResolverRule({
              ResolverRuleId: output.resolverRuleId,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
