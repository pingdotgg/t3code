import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const DOMAIN_A = "a.alchemy-cm.example.com";
const DOMAIN_B = "b.alchemy-cm.example.com";

const waitUntilGone = (name: string) =>
  certificatemanager.getProjectsLocationsDnsAuthorizations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a dns authorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.DnsAuthorization("WwwAuth", {
            location: "global",
            description: "dns auth a",
            domain: DOMAIN_A,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dnsAuthorizations/");
      expect(created.dnsAuthorizationId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.domain).toEqual(DOMAIN_A);
      expect(created.type).toEqual("FIXED_RECORD");
      expect(created.description).toEqual("dns auth a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.dnsResourceRecordName).toEqual(expect.any(String));
      expect(created.dnsResourceRecordType).toEqual("CNAME");
      expect(created.dnsResourceRecordData).toEqual(expect.any(String));

      const fetched =
        yield* certificatemanager.getProjectsLocationsDnsAuthorizations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.domain).toEqual(DOMAIN_A);
      expect(fetched.description).toEqual("dns auth a");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.dnsResourceRecord?.type).toEqual("CNAME");
      expect(fetched.dnsResourceRecord?.data).toEqual(expect.any(String));
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.DnsAuthorization("WwwAuth", {
            dnsAuthorizationId: created.dnsAuthorizationId,
            location: "global",
            description: "dns auth b",
            domain: DOMAIN_A,
            labels: { env: "prod", role: "auth" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.domain).toEqual(DOMAIN_A);
      expect(updated.description).toEqual("dns auth b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "auth" });
      expect(updated.dnsResourceRecordData).toEqual(
        created.dnsResourceRecordData,
      );

      const refetched =
        yield* certificatemanager.getProjectsLocationsDnsAuthorizations({
          name: created.name,
        });
      expect(refetched.description).toEqual("dns auth b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("auth");
      expect(refetched.domain).toEqual(DOMAIN_A);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.DnsAuthorization("WwwAuth", {
            dnsAuthorizationId: created.dnsAuthorizationId,
            location: "global",
            description: "dns auth c",
            domain: DOMAIN_B,
            labels: { env: "prod", role: "auth" },
          });
        }),
      );

      expect(replaced.dnsAuthorizationId).toEqual(created.dnsAuthorizationId);
      expect(replaced.name).toEqual(created.name);
      expect(replaced.domain).toEqual(DOMAIN_B);
      expect(replaced.description).toEqual("dns auth c");
      expect(replaced.dnsResourceRecordName).toEqual(expect.any(String));
      expect(replaced.dnsResourceRecordData).toEqual(expect.any(String));

      const replacedFetched =
        yield* certificatemanager.getProjectsLocationsDnsAuthorizations({
          name: created.name,
        });
      expect(replacedFetched.domain).toEqual(DOMAIN_B);
      expect(replacedFetched.description).toEqual("dns auth c");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 90_000,
  },
);
