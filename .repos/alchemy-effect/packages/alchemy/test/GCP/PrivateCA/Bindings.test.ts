import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import PrivateCaBindingsHost, { Pool, Root } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PrivateCABindings");

let baseUrl: string;
let hostAccount: string;
let poolName: string;
let caName: string;

/**
 * Roles the host holds on the CA pool (CAs have no IAM policy of their
 * own, so both bindings grant on the parent pool).
 */
const expectPoolGrants = Effect.gen(function* () {
  const policy = yield* privateca.getIamPolicyProjectsLocationsCaPools({
    resource: poolName,
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();
  expect(roles).toEqual([
    "roles/privateca.auditor",
    "roles/privateca.poolReader",
  ]);
});

describe.skipIf(!dockerAvailable)(
  "PrivateCA Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:privateca",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* PrivateCaBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              pool: (yield* Pool).name,
              ca: (yield* Root).name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        poolName = out.pool;
        caName = out.ca;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("FetchCaCerts", () => {
      test.provider(
        "fetches the pool's trust anchors as the host's service account, granted on the pool only",
        (_stack) =>
          Effect.gen(function* () {
            const certs = yield* expectProbe<privateca.FetchCaCertsResponse>(
              baseUrl,
              "fetchCaCerts",
            );
            const pems = (certs.caCerts ?? []).flatMap(
              (chain) => chain.certificates ?? [],
            );
            // The enabled root CA is the pool's only trust anchor.
            const ca =
              yield* privateca.getProjectsLocationsCaPoolsCertificateAuthorities(
                { name: caName },
              );
            expect(pems.map((pem) => pem.trim())).toEqual(
              (ca.pemCaCertificates ?? []).map((pem) => pem.trim()),
            );
            expect(pems[0]).toContain("BEGIN CERTIFICATE");
            yield* expectPoolGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:privateca", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetCertificateAuthority", () => {
      test.provider(
        "reads the CA as the host's service account, granted on the pool only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<privateca.CertificateAuthority>(
              baseUrl,
              "getCertificateAuthority",
            );
            expect(live.name).toEqual(caName);
            expect(live.type).toEqual("SELF_SIGNED");
            expect(live.state).toEqual("ENABLED");
            yield* expectPoolGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:privateca", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
