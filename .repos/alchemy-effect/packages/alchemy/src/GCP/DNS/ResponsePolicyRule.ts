import * as dns from "@distilled.cloud/gcp/dns_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_TTL = 300;

export type ResponsePolicyRuleLocalData = {
  /**
   * DNS name for this record. Defaults to the rule's `dnsName`.
   */
  name?: string;
  /**
   * DNS record type (`A`, `AAAA`, `CNAME`, `TXT`, …). SOA and NS are
   * not allowed.
   */
  type: string;
  /**
   * TTL in seconds.
   * @default 300
   */
  ttl?: number;
  /**
   * Resource-record data.
   */
  rrdatas?: string[];
};

export type ResponsePolicyRuleBehavior = dns.ResponsePolicyRuleBehaviorEnum;

export type ResponsePolicyRuleProps = {
  /**
   * Response policy name that owns this rule. Immutable — changing it
   * replaces the rule.
   */
  responsePolicy: string;
  /**
   * User-assigned rule name, unique within the response policy. If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the rule.
   */
  ruleName?: string;
  /**
   * DNS name (wildcard or exact) this rule matches, for instance
   * `"internal.example.com."` or `"*.example.com."`. A trailing dot is
   * added if omitted.
   */
  dnsName: string;
  /**
   * Local DNS answers that override private zones, public DNS, and GCP
   * internal DNS for the matched name. Mutually exclusive with
   * `behavior`.
   */
  localData?: ResponsePolicyRuleLocalData[];
  /**
   * Answer with a behavior instead of DNS data. `bypassResponsePolicy`
   * skips this response policy (and falls through to ordinary DNS) for
   * the matched name. Mutually exclusive with `localData`.
   */
  behavior?: ResponsePolicyRuleBehavior;
};

export type ResponsePolicyRule = Resource<
  "GCP.DNS.ResponsePolicyRule",
  ResponsePolicyRuleProps,
  {
    /** Project id. */
    project: string;
    /** Parent response policy name. */
    responsePolicy: string;
    /** User-assigned rule name. */
    ruleName: string;
    /** DNS name selector, with trailing dot. */
    dnsName: string;
    /** Local override records, if this is not a behavior rule. */
    localData: ReadonlyArray<ResponsePolicyRuleLocalData>;
    /** Behavior, if this is not a local-data rule. */
    behavior: string | undefined;
    /** Server-reported kind (`dns#responsePolicyRule`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud DNS response policy rule.
 *
 * Identity is `(responsePolicy, ruleName)`. `dnsName`, `localData`, and
 * `behavior` update in place. Rules have no labels; `list` / nuke
 * discover them by enumerating response policies stamped with
 * `alchemy-*` labels.
 *
 * ### Creating a Rule
 * **Example:** Local A record override
 * ```typescript
 * const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
 *   networks: ["app-vpc"],
 * });
 * const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
 *   responsePolicy: policy.responsePolicyName,
 *   dnsName: "app.internal.example.com.",
 *   localData: [{ type: "A", ttl: 300, rrdatas: ["10.0.0.10"] }],
 * });
 * ```
 *
 * **Example:** Bypass the response policy for a name
 * ```typescript
 * const passthrough = yield* GCP.DNS.ResponsePolicyRule("Passthrough", {
 *   responsePolicy: policy.responsePolicyName,
 *   dnsName: "cdn.example.com.",
 *   behavior: "bypassResponsePolicy",
 * });
 * ```
 *
 * @resource
 * @category DNS
 */
export const ResponsePolicyRule = Resource<ResponsePolicyRule>(
  "GCP.DNS.ResponsePolicyRule",
);

export class ResponsePolicyRuleNotResolved extends Data.TaggedError(
  "GCP.DNS.ResponsePolicyRuleNotResolved",
)<{
  responsePolicy: string;
  ruleName: string;
}> {}

export class ResponsePolicyRulePolicyNotFound extends Data.TaggedError(
  "GCP.DNS.ResponsePolicyRulePolicyNotFound",
)<{
  responsePolicy: string;
}> {}

const withTrailingDot = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

const normalizeFqdn = (name: string) => withTrailingDot(name).toLowerCase();

const toRuleName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^[^a-z]+/, "r")
      .slice(0, MAX_NAME_LENGTH)
      .replace(/-+$/g, "");
    return rfc.length > 0 ? rfc : "r";
  });

const toLocalData = (
  dnsName: string,
  records: ResponsePolicyRuleLocalData[] | undefined,
): ResponsePolicyRuleLocalData[] =>
  (records ?? []).map((record) => ({
    name: normalizeFqdn(record.name ?? dnsName),
    type: record.type.toUpperCase(),
    ttl: record.ttl ?? DEFAULT_TTL,
    rrdatas: record.rrdatas ?? [],
  }));

const observedLocalData = (
  rule: dns.ResponsePolicyRule,
): ResponsePolicyRuleLocalData[] =>
  (rule.localData?.localDatas ?? []).map((record) => ({
    name: record.name ? normalizeFqdn(record.name) : "",
    type: (record.type ?? "").toUpperCase(),
    ttl: record.ttl ?? DEFAULT_TTL,
    rrdatas: record.rrdatas ?? [],
  }));

const sameLocalData = (
  left: ResponsePolicyRuleLocalData[],
  right: ResponsePolicyRuleLocalData[],
) => JSON.stringify(left) === JSON.stringify(right);

const toBody = (props: {
  ruleName: string;
  dnsName: string;
  localData: ResponsePolicyRuleLocalData[];
  behavior: string | undefined;
}): dns.ResponsePolicyRule => {
  const body: dns.ResponsePolicyRule = {
    ruleName: props.ruleName,
    dnsName: props.dnsName,
  };
  if (props.localData.length > 0) {
    body.localData = {
      localDatas: props.localData.map((record) => ({
        name: record.name,
        type: record.type,
        ttl: record.ttl,
        rrdatas: record.rrdatas,
      })),
    };
  } else if (props.behavior !== undefined) {
    body.behavior = props.behavior;
  }
  return body;
};

const toAttrs = (
  rule: dns.ResponsePolicyRule,
  project: string,
  responsePolicy: string,
) => ({
  project,
  responsePolicy,
  ruleName: rule.ruleName ?? "",
  dnsName: rule.dnsName ? normalizeFqdn(rule.dnsName) : "",
  localData: observedLocalData(rule),
  behavior: rule.behavior,
  kind: rule.kind,
});

const getPolicy = (project: string, responsePolicy: string) =>
  dns
    .getResponsePolicies({ project, responsePolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getByName = (project: string, responsePolicy: string, ruleName: string) =>
  dns
    .getResponsePolicyRules({
      project,
      responsePolicy,
      responsePolicyRule: ruleName,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRules = (project: string, responsePolicy: string) =>
  Effect.gen(function* () {
    const found: dns.ResponsePolicyRule[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* dns.listResponsePolicyRules({
        project,
        responsePolicy,
        maxResults: 1000,
        pageToken,
      });
      found.push(...(response.responsePolicyRules ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as dns.ResponsePolicyRule[]),
    ),
  );

const listAlchemyResponsePolicies = (project: string) =>
  Effect.gen(function* () {
    const found: dns.ResponsePolicy[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* dns.listResponsePolicies({
        project,
        maxResults: 1000,
        pageToken,
      });
      for (const policy of response.responsePolicies ?? []) {
        if (
          Object.keys(policy.labels ?? {}).some((key) =>
            key.startsWith(ALCHEMY_LABEL_PREFIX),
          )
        ) {
          found.push(policy);
        }
      }
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

export const ResponsePolicyRuleProvider = () =>
  Provider.succeed(ResponsePolicyRule, {
    stables: ["project", "responsePolicy", "ruleName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPolicy = olds?.responsePolicy ?? output?.responsePolicy;
      const previousName = olds?.ruleName ?? output?.ruleName;
      const nextName = news.ruleName ?? previousName;
      const policyChanged =
        previousPolicy !== undefined && news.responsePolicy !== previousPolicy;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;
      if (!policyChanged && !nameChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const responsePolicy = output?.responsePolicy ?? olds?.responsePolicy;
      if (responsePolicy === undefined) return undefined;
      const ruleName = yield* toRuleName(id, olds?.ruleName, output?.ruleName);
      const existing = yield* getByName(env.project, responsePolicy, ruleName);
      if (existing === undefined) return undefined;
      // Rules have no labels. Identity (policy + rule name) is
      // ownership — same as Cloud DNS record sets.
      return toAttrs(existing, env.project, responsePolicy);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const policies = yield* listAlchemyResponsePolicies(env.project);
        const pages = yield* Effect.forEach(
          policies,
          (policy) =>
            policy.responsePolicyName
              ? listRules(env.project, policy.responsePolicyName).pipe(
                  Effect.map((rules) =>
                    rules.map((rule) =>
                      toAttrs(
                        rule,
                        env.project,
                        policy.responsePolicyName ?? "",
                      ),
                    ),
                  ),
                )
              : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policy = yield* getPolicy(env.project, news.responsePolicy);
      if (policy === undefined || policy.responsePolicyName === undefined) {
        return yield* new ResponsePolicyRulePolicyNotFound({
          responsePolicy: news.responsePolicy,
        });
      }
      const responsePolicy = policy.responsePolicyName;
      const ruleName = yield* toRuleName(id, news.ruleName, output?.ruleName);
      const dnsName = normalizeFqdn(news.dnsName);
      const localData = toLocalData(dnsName, news.localData);
      const behavior = localData.length > 0 ? undefined : news.behavior;
      const desired = toBody({
        ruleName,
        dnsName,
        localData,
        behavior,
      });

      let current = yield* getByName(env.project, responsePolicy, ruleName);

      if (current === undefined) {
        const created = yield* dns
          .createResponsePolicyRules({
            project: env.project,
            responsePolicy,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(env.project, responsePolicy, ruleName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResponsePolicyRuleNotResolved({
          responsePolicy,
          ruleName,
        });
      }

      const dnsChanged = normalizeFqdn(current.dnsName ?? "") !== dnsName;
      const localChanged = !sameLocalData(
        observedLocalData(current),
        localData,
      );
      const behaviorChanged = (current.behavior ?? undefined) !== behavior;

      if (dnsChanged || localChanged || behaviorChanged) {
        const patched = yield* dns.patchResponsePolicyRules({
          project: env.project,
          responsePolicy,
          responsePolicyRule: ruleName,
          body: desired,
        });
        current =
          patched.responsePolicyRule ??
          (yield* getByName(env.project, responsePolicy, ruleName)) ??
          current;
      }

      return toAttrs(current, env.project, responsePolicy);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteResponsePolicyRules({
          project: output.project,
          responsePolicy: output.responsePolicy,
          responsePolicyRule: output.ruleName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
