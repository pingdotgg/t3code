import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/gcp/dns_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (
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

test.provider(
  "getResponsePolicyRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        dns.getResponsePolicyRules({
          project,
          responsePolicy: "alchemy-missing-policy",
          responsePolicyRule: "alchemy-missing-rule",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a response policy rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            description: "alchemy response policy for rule test",
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            dnsName: "rule.internal.example.com.",
            localData: [{ type: "A", ttl: 300, rrdatas: ["10.0.0.20"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(created.rule.responsePolicy).toEqual(
        created.policy.responsePolicyName,
      );
      expect(created.rule.dnsName).toEqual("rule.internal.example.com.");

      const fetched = yield* dns.getResponsePolicyRules({
        project: created.rule.project,
        responsePolicy: created.policy.responsePolicyName,
        responsePolicyRule: created.rule.ruleName,
      });
      expect(fetched.dnsName).toEqual("rule.internal.example.com.");
      expect(fetched.localData?.localDatas?.[0]?.rrdatas).toEqual([
        "10.0.0.20",
      ]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
            responsePolicyName: created.policy.responsePolicyName,
            description: "alchemy response policy for rule test",
            networks: [vpc.networkName],
          });
          const rule = yield* GCP.DNS.ResponsePolicyRule("Internal", {
            responsePolicy: policy.responsePolicyName,
            ruleName: created.rule.ruleName,
            dnsName: "rule.internal.example.com.",
            localData: [{ type: "A", ttl: 60, rrdatas: ["10.0.0.21"] }],
          });
          return { vpc, policy, rule };
        }),
      );

      expect(updated.rule.ruleName).toEqual(created.rule.ruleName);
      expect(updated.rule.localData).toEqual([
        {
          name: "rule.internal.example.com.",
          type: "A",
          ttl: 60,
          rrdatas: ["10.0.0.21"],
        },
      ]);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.rule.project,
        created.policy.responsePolicyName,
        created.rule.ruleName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 120_000 },
);
