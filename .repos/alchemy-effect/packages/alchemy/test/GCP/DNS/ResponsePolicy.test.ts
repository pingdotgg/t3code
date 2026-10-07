import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/gcp/dns_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilPolicyGone = (project: string, responsePolicy: string) =>
  dns.getResponsePolicies({ project, responsePolicy }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilRuleGone = (
  project: string,
  responsePolicy: string,
  ruleName: string,
) =>
  dns
    .getResponsePolicyRules({
      project,
      responsePolicy,
      responsePolicyRule: ruleName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const lastSegment = (url: string) => url.split("/").pop() ?? url;

test.provider(
  "create, update, replace, and delete a response policy and rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            description: "alchemy test response policy",
            labels: { env: "test" },
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            dnsName: "app.internal.example.com.",
            localData: [{ type: "A", ttl: 300, rrdatas: ["10.0.0.10"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(created.policy.responsePolicyName).toEqual(expect.any(String));
      expect(created.policy.description).toEqual(
        "alchemy test response policy",
      );
      expect(created.policy.labels).toMatchObject({ env: "test" });
      expect(created.policy.networks.map(lastSegment)).toContain(
        created.vpc.networkName,
      );
      expect(created.rule.responsePolicy).toEqual(
        created.policy.responsePolicyName,
      );
      expect(created.rule.dnsName).toEqual("app.internal.example.com.");
      expect(created.rule.localData).toEqual([
        {
          name: "app.internal.example.com.",
          type: "A",
          ttl: 300,
          rrdatas: ["10.0.0.10"],
        },
      ]);

      const fetched = yield* dns.getResponsePolicies({
        project: created.policy.project,
        responsePolicy: created.policy.responsePolicyName,
      });
      expect(fetched.responsePolicyName).toEqual(
        created.policy.responsePolicyName,
      );
      expect(fetched.description).toEqual("alchemy test response policy");
      expect(fetched.labels?.env).toEqual("test");

      const fetchedRule = yield* dns.getResponsePolicyRules({
        project: created.rule.project,
        responsePolicy: created.policy.responsePolicyName,
        responsePolicyRule: created.rule.ruleName,
      });
      expect(fetchedRule.dnsName).toEqual("app.internal.example.com.");
      expect(fetchedRule.localData?.localDatas?.[0]?.rrdatas).toEqual([
        "10.0.0.10",
      ]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            responsePolicyName: created.policy.responsePolicyName,
            description: "updated alchemy test response policy",
            labels: { env: "prod", role: "dns" },
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            ruleName: created.rule.ruleName,
            dnsName: "app.internal.example.com.",
            localData: [{ type: "A", ttl: 60, rrdatas: ["10.0.0.20"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(updated.policy.responsePolicyName).toEqual(
        created.policy.responsePolicyName,
      );
      expect(updated.policy.description).toEqual(
        "updated alchemy test response policy",
      );
      expect(updated.policy.labels).toMatchObject({
        env: "prod",
        role: "dns",
      });
      expect(updated.rule.localData).toEqual([
        {
          name: "app.internal.example.com.",
          type: "A",
          ttl: 60,
          rrdatas: ["10.0.0.20"],
        },
      ]);

      const fetchedUpdate = yield* dns.getResponsePolicies({
        project: created.policy.project,
        responsePolicy: created.policy.responsePolicyName,
      });
      expect(fetchedUpdate.description).toEqual(
        "updated alchemy test response policy",
      );
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("dns");

      const fetchedUpdatedRule = yield* dns.getResponsePolicyRules({
        project: created.rule.project,
        responsePolicy: created.policy.responsePolicyName,
        responsePolicyRule: created.rule.ruleName,
      });
      expect(fetchedUpdatedRule.localData?.localDatas?.[0]?.ttl).toEqual(60);
      expect(fetchedUpdatedRule.localData?.localDatas?.[0]?.rrdatas).toEqual([
        "10.0.0.20",
      ]);

      const replacedRuleName = `r${created.rule.ruleName}`.slice(0, 63);
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            responsePolicyName: created.policy.responsePolicyName,
            description: "updated alchemy test response policy",
            labels: { env: "prod", role: "dns" },
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            ruleName: replacedRuleName,
            dnsName: "api.internal.example.com.",
            localData: [{ type: "A", ttl: 120, rrdatas: ["10.0.0.30"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(replaced.rule.ruleName).toEqual(replacedRuleName);
      expect(replaced.rule.dnsName).toEqual("api.internal.example.com.");
      expect(replaced.rule.localData[0]?.rrdatas).toEqual(["10.0.0.30"]);

      const previousRuleGone = yield* waitUntilRuleGone(
        created.rule.project,
        created.policy.responsePolicyName,
        created.rule.ruleName,
      );
      expect(previousRuleGone).toEqual("gone");

      const fetchedReplacedRule = yield* dns.getResponsePolicyRules({
        project: created.rule.project,
        responsePolicy: created.policy.responsePolicyName,
        responsePolicyRule: replacedRuleName,
      });
      expect(fetchedReplacedRule.dnsName).toEqual("api.internal.example.com.");

      const replacedPolicyName = `r${created.policy.responsePolicyName}`.slice(
        0,
        63,
      );
      const replacedPolicy = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            responsePolicyName: replacedPolicyName,
            description: "replaced alchemy test response policy",
            labels: { env: "prod", role: "dns" },
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            ruleName: replacedRuleName,
            dnsName: "api.internal.example.com.",
            localData: [{ type: "A", ttl: 120, rrdatas: ["10.0.0.30"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(replacedPolicy.policy.responsePolicyName).toEqual(
        replacedPolicyName,
      );
      expect(replacedPolicy.policy.description).toEqual(
        "replaced alchemy test response policy",
      );
      expect(replacedPolicy.rule.responsePolicy).toEqual(replacedPolicyName);

      const previousPolicyGone = yield* waitUntilPolicyGone(
        created.policy.project,
        created.policy.responsePolicyName,
      );
      expect(previousPolicyGone).toEqual("gone");

      const fetchedReplacement = yield* dns.getResponsePolicies({
        project: created.policy.project,
        responsePolicy: replacedPolicyName,
      });
      expect(fetchedReplacement.responsePolicyName).toEqual(replacedPolicyName);
      expect(fetchedReplacement.description).toEqual(
        "replaced alchemy test response policy",
      );

      yield* stack.destroy();

      const ruleGone = yield* waitUntilRuleGone(
        created.rule.project,
        replacedPolicyName,
        replacedRuleName,
      );
      expect(ruleGone).toEqual("gone");

      const gone = yield* waitUntilPolicyGone(
        created.policy.project,
        replacedPolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 120_000 },
);
