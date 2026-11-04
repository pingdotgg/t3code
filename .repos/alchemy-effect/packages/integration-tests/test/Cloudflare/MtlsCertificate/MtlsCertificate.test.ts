import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import type { InferEnv } from "@alchemy.run/cloudflare/Workers/InferEnv";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as mtls from "@distilled.cloud/cloudflare/mtls-certificates";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Provider from "alchemy/Provider";
import { poll } from "alchemy/Util/poll";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import { CA_CERT_1, CA_CERT_2, LEAF_CERT, LEAF_KEY } from "./fixtures/certs.ts";
import MtlsFetchWorker, { FetchCert } from "./fixtures/fetch-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Compile-time: an MtlsCertificate in `env` is typed as a Fetcher.
type CertEnv = InferEnv<{ CERT: Cloudflare.MtlsCertificate.MtlsCertificate }>;
const _certIsFetcher: CertEnv["CERT"] extends Fetcher ? true : never = true;
void _certIsFetcher;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Cloudflare dedups mTLS certificates by PEM content account-wide and rejects
// a duplicate upload with `CertificateAlreadyExists` (code 1471). Three of
// these cases upload the same `CA_CERT_1`, so under the suite's default
// concurrent execution they collide on identical content (and the
// adopt-by-content recovery races a sibling that is mid-create or mid-delete).
// `describe.sequential` runs them one at a time so each create→…→destroy owns
// the content exclusively.
describe.sequential(
  "MtlsCertificate",
  { tags: ["provider:cloudflare", "provider:cloudflare:mtlscertificate", "live"] },
  () => {
    test.provider("create and delete a CA certificate", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const cert = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("CaCert", {
            ca: true,
            certificates: CA_CERT_1,
          }),
        );

        expect(cert.mtlsCertificateId).toBeDefined();
        expect(cert.ca).toEqual(true);
        expect(cert.name).toBeDefined();
        expect(cert.expiresOn).toBeDefined();

        const actual = yield* mtls.getMtlsCertificate({
          accountId,
          mtlsCertificateId: cert.mtlsCertificateId,
        });
        expect(actual.id).toEqual(cert.mtlsCertificateId);
        expect(actual.ca).toEqual(true);
        expect(actual.name).toEqual(cert.name);

        yield* stack.destroy();

        yield* waitForDelete(accountId, cert.mtlsCertificateId);
      }).pipe(logLevel),
    );

    test.provider("create and delete a leaf certificate with private key", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const cert = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("LeafCert", {
            ca: false,
            certificates: LEAF_CERT,
            privateKey: Redacted.make(LEAF_KEY),
          }),
        );

        expect(cert.mtlsCertificateId).toBeDefined();
        expect(cert.ca).toEqual(false);

        const actual = yield* mtls.getMtlsCertificate({
          accountId,
          mtlsCertificateId: cert.mtlsCertificateId,
        });
        expect(actual.id).toEqual(cert.mtlsCertificateId);
        expect(actual.ca).toEqual(false);

        yield* stack.destroy();

        yield* waitForDelete(accountId, cert.mtlsCertificateId);
      }).pipe(logLevel),
    );

    test.provider("replaces the certificate when the PEM changes", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const original = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("ReplaceCert", {
            ca: true,
            certificates: CA_CERT_1,
          }),
        );

        const replaced = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("ReplaceCert", {
            ca: true,
            certificates: CA_CERT_2,
          }),
        );

        expect(replaced.mtlsCertificateId).toBeDefined();
        expect(replaced.mtlsCertificateId).not.toEqual(original.mtlsCertificateId);
        expect(replaced.serialNumber).not.toEqual(original.serialNumber);

        // The old certificate must be gone after the replacement completes.
        yield* waitForDelete(accountId, original.mtlsCertificateId);

        const actual = yield* mtls.getMtlsCertificate({
          accountId,
          mtlsCertificateId: replaced.mtlsCertificateId,
        });
        expect(actual.id).toEqual(replaced.mtlsCertificateId);

        yield* stack.destroy();

        yield* waitForDelete(accountId, replaced.mtlsCertificateId);
      }).pipe(logLevel),
    );

    // Regression for #2359: with an explicit name the replacement shares the
    // old certificate's name. Cloudflare rejects duplicate names, so the
    // replacement deletes first and uploads the new PEM instead of adopting
    // the old certificate by name.
    test.provider("replaces a named certificate when the PEM changes", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = `alchemy-mtls-named-${stack.stage}`.toLowerCase();

        yield* stack.destroy();

        const original = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("NamedReplaceCert", {
            name,
            ca: true,
            certificates: CA_CERT_1,
          }),
        );

        const replacePlan = yield* stack.plan(
          Cloudflare.MtlsCertificate.MtlsCertificate("NamedReplaceCert", {
            name,
            ca: true,
            certificates: CA_CERT_2,
          }),
        );
        const replaceChange = replacePlan.resources.NamedReplaceCert!;
        expect(replaceChange.action).toEqual("replace");
        if (replaceChange.action === "replace") expect(replaceChange.deleteFirst).toBe(true);

        const replaced = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("NamedReplaceCert", {
            name,
            ca: true,
            certificates: CA_CERT_2,
          }),
        );

        expect(replaced.name).toEqual(name);
        expect(replaced.mtlsCertificateId).not.toEqual(original.mtlsCertificateId);
        expect(replaced.serialNumber).not.toEqual(original.serialNumber);

        yield* waitForDelete(accountId, original.mtlsCertificateId);

        const actual = yield* mtls.getMtlsCertificate({
          accountId,
          mtlsCertificateId: replaced.mtlsCertificateId,
        });
        expect(actual.certificates?.trim()).toEqual(CA_CERT_2.trim());

        // State now matches the cloud, so a redeploy is a noop.
        const plan = yield* stack.plan(
          Cloudflare.MtlsCertificate.MtlsCertificate("NamedReplaceCert", {
            name,
            ca: true,
            certificates: CA_CERT_2,
          }),
        );
        expect(plan.resources.NamedReplaceCert!.action).toEqual("noop");

        yield* stack.destroy();

        yield* waitForDelete(accountId, replaced.mtlsCertificateId);
      }).pipe(logLevel),
    );

    // A certificate passed in a Worker's `env` becomes an `mtls_certificate`
    // binding, exposed to the Worker as a Fetcher (#2048). On destroy,
    // right after the Worker is deleted, Cloudflare still rejects the
    // certificate delete with "Certificate cannot be deleted while in use."
    // Destroy must ride that out (#2080).
    test.provider(
      "binds a certificate in Worker env and destroys it after the Worker",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { cert, worker } = yield* stack.deploy(
            Effect.gen(function* () {
              const cert = yield* Cloudflare.MtlsCertificate.MtlsCertificate("BoundCert", {
                ca: false,
                certificates: LEAF_CERT,
                privateKey: Redacted.make(LEAF_KEY),
              });
              const worker = yield* Cloudflare.Worker("MtlsBoundWorker", {
                script: `export default {
  fetch: (_request, env) => new Response("cert-fetch:" + typeof env.CERT?.fetch),
};`,
                env: { CERT: cert },
              });
              return { cert, worker };
            }),
          );

          const settings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: worker.workerName,
          });
          expect(
            (settings.bindings ?? []).some(
              (b) => b.type === "mtls_certificate" && b.certificateId === cert.mtlsCertificateId,
            ),
          ).toBe(true);
          // The runtime hands the Worker a Fetcher for the binding.
          yield* expectUrlContains(worker.url!, "cert-fetch:function", {
            timeout: "60 seconds",
            label: "mtls_certificate binding is a Fetcher",
          });

          yield* stack.destroy();

          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
          yield* waitForDelete(accountId, cert.mtlsCertificateId);
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    // `Cloudflare.MtlsCertificate.Fetch` binds the certificate from an Effect
    // Worker and sends requests through it.
    test.provider(
      "an Effect Worker sends requests through the Fetch binding",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { cert, worker } = yield* stack.deploy(
            Effect.gen(function* () {
              const worker = yield* MtlsFetchWorker;
              const cert = yield* FetchCert;
              return { cert, worker };
            }),
          );

          const settings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: worker.workerName,
          });
          expect(
            (settings.bindings ?? []).some(
              (b) =>
                b.type === "mtls_certificate" &&
                b.name === "FetchCert" &&
                b.certificateId === cert.mtlsCertificateId,
            ),
          ).toBe(true);
          yield* expectUrlContains(worker.url!, "origin-status:200", {
            timeout: "60 seconds",
            label: "request sent through the mTLS Fetch binding",
          });

          yield* stack.destroy();

          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
          yield* waitForDelete(accountId, cert.mtlsCertificateId);
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test.provider("list enumerates the deployed mTLS certificate", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const cert = yield* stack.deploy(
          Cloudflare.MtlsCertificate.MtlsCertificate("ListCert", {
            ca: true,
            certificates: CA_CERT_1,
          }),
        );

        const provider = yield* Provider.findProvider(Cloudflare.MtlsCertificate.MtlsCertificate);

        // A freshly-deployed certificate is eventually consistent in the
        // account-wide list(); poll until it appears before asserting.
        const all = yield* poll({
          description: "list() includes the deployed mTLS certificate",
          effect: provider.list(),
          predicate: (all) => all.some((c) => c.mtlsCertificateId === cert.mtlsCertificateId),
        });

        expect(all.some((c) => c.mtlsCertificateId === cert.mtlsCertificateId)).toBe(true);

        yield* stack.destroy();

        yield* waitForDelete(accountId, cert.mtlsCertificateId);
      }).pipe(logLevel),
    );
  },
);

const waitForDelete = (accountId: string, mtlsCertificateId: string) =>
  mtls.getMtlsCertificate({ accountId, mtlsCertificateId }).pipe(
    Effect.flatMap((cert) =>
      cert.id === mtlsCertificateId
        ? Effect.fail({ _tag: "CertificateNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );
