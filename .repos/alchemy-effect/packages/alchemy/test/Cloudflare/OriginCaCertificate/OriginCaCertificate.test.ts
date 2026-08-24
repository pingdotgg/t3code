import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as originCa from "@distilled.cloud/cloudflare/origin-ca-certificates";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

import { TEST_CSR } from "./fixtures/csr.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName = "alchemy-test-2.us";
// Each test owns a DISTINCT hostname. Adoption keys purely off the hostname
// set (the engine probes `read` with `olds: news` even on a fresh deploy, so
// `findByHostnames` runs every time), and Origin CA certs carry no other
// identity. A shared hostname therefore couples the tests: a leftover cert
// from another test or a prior crashed run can be adopted, and a sibling's
// destroy can revoke a cert this test is mid-verifying. Per-test hostnames
// make each test fully self-contained.

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getCertificate = (certificateId: string) =>
  originCa.getOriginCaCertificate({ certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// After destroy, the certificate is revoked. GET keeps returning a revoked
// certificate (with `revokedAt` set) for a while, and may eventually flip to
// `CertificateNotFound` — either state counts as gone.
const expectRevoked = (certificateId: string) =>
  getCertificate(certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.revokedAt
        ? Effect.void
        : Effect.fail({ _tag: "CertificateNotRevoked" } as const),
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotRevoked",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("issue, verify, and revoke a certificate", (stack) =>
  Effect.gen(function* () {
    const hostname = `originissue.${zoneName}`;
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("Cert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    // Issuance is synchronous — the signed PEM comes back on create.
    expect(cert.certificateId).toBeTruthy();
    expect(cert.certificate).toContain("-----BEGIN CERTIFICATE-----");
    expect(cert.csr).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(cert.hostnames).toEqual([hostname]);
    expect(cert.requestType).toEqual("origin-rsa");
    expect(cert.requestedValidity).toEqual(90);
    expect(cert.expiresOn).toBeTruthy();

    // Out-of-band verification: the certificate is live and not revoked.
    const live = yield* getCertificate(cert.certificateId);
    expect(live.id).toEqual(cert.certificateId);
    expect(live.hostnames).toEqual([hostname]);
    expect(live.revokedAt ?? null).toBeNull();

    // Redeploying identical props is a no-op (same certificate).
    const noop = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("Cert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(noop.certificateId).toEqual(cert.certificateId);

    // Destroy revokes the certificate; a second destroy is idempotent.
    yield* stack.destroy();
    yield* expectRevoked(cert.certificateId);
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("list enumerates issued certificates", (stack) =>
  Effect.gen(function* () {
    const hostname = `originlist.${zoneName}`;
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("ListCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.OriginCaCertificate.OriginCaCertificate,
    );
    const all = yield* provider.list();

    // `list()` is account-wide but enumerated per zone with the `zone_id`
    // query param; a zone the scoped token can't read for Origin CA rejects
    // with the typed `Forbidden` tag, which is swallowed so that zone simply
    // contributes []. The standing token can list the test zone, so the
    // freshly issued certificate must appear in the exhaustively-paginated
    // result in the `read` Attributes shape.
    expect(Array.isArray(all)).toBe(true);
    const match = all.find((c) => c.certificateId === cert.certificateId);
    expect(match).toBeDefined();
    expect(match!.certificateId).toEqual(cert.certificateId);
    expect(match!.hostnames).toEqual([hostname]);
    expect(match!.requestType).toEqual("origin-rsa");

    yield* stack.destroy();
    yield* expectRevoked(cert.certificateId);
  }).pipe(logLevel),
);

// Explicit revoke for certificates the wedged-state recovery orphans out of
// engine state (their rows lose `attr`, so `stack.destroy()` can't reclaim
// them). Revoked/absent both count as cleaned up.
const revokeQuietly = (certificateId: string) =>
  originCa.deleteOriginCaCertificate({ certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.catchTag("CertificateAlreadyRevoked", () => Effect.void),
  );

test.provider(
  "recovers a creating-state row whose Output-valued hostnames were lost (#736)",
  (stack) =>
    Effect.gen(function* () {
      const hostname = `originwedged.${zoneName}`;
      yield* stack.destroy();

      const deployCert = () =>
        stack.deploy(
          Cloudflare.OriginCaCertificate.OriginCaCertificate("WedgedCert", {
            csr: TEST_CSR,
            hostnames: [hostname],
            requestType: "origin-rsa",
            requestedValidity: 90,
          }).pipe(adopt(true)),
        );

      const created = yield* deployCert();
      expect(created.certificateId).toBeTruthy();

      // Rewrite the certificate's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and the
      // Output-valued props lost in the state round-trip (#736).
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const wedgeRow = (junk: Record<string, unknown>) =>
        Effect.gen(function* () {
          const fqns = yield* state.list({ stack: stack.name, stage });
          const rows = yield* Effect.forEach(fqns, (fqn) =>
            state
              .get({ stack: stack.name, stage, fqn })
              .pipe(Effect.map((row) => ({ fqn, row }))),
          );
          const wedged = rows.find(
            (r): r is { fqn: string; row: ResourceState } =>
              isResourceState(r.row) &&
              r.row.resourceType ===
                "Cloudflare.OriginCaCertificate.OriginCaCertificate",
          );
          if (!wedged) {
            return yield* Effect.die(
              new Error("no OriginCaCertificate state row found after deploy"),
            );
          }
          yield* state.set({
            stack: stack.name,
            stage,
            fqn: wedged.fqn,
            value: {
              ...wedged.row,
              status: "creating",
              attr: undefined,
              props: { ...wedged.row.props, ...junk },
            },
          });
        });

      // The wedge orphans the previous certificate out of engine state, so
      // destroy can never reclaim it — revoke it explicitly on scope close
      // even if the body fails mid-way.
      yield* Effect.addFinalizer(() =>
        revokeQuietly(created.certificateId).pipe(Effect.ignore),
      );

      // Wedge 1 — the #736 shape: the hostnames array survives serialization
      // but its Output-valued ELEMENT deserializes as undefined. Before the
      // fix, read's cold path only checked `hostnames?.length`, passed the
      // truthy-length junk array into `findByHostnames`, and crashed on
      // `hostnames[0].replace(...)`. After the fix, read reports "missing"
      // and the engine re-creates.
      yield* wedgeRow({ hostnames: [undefined] });
      const recovered = yield* deployCert();
      expect(recovered.certificateId).toBeTruthy();
      expect(recovered.hostnames).toEqual([hostname]);
      const live = yield* getCertificate(recovered.certificateId);
      expect(live.hostnames).toEqual([hostname]);
      expect(live.revokedAt ?? null).toBeNull();

      yield* Effect.addFinalizer(() =>
        revokeQuietly(recovered.certificateId).pipe(Effect.ignore),
      );

      // Wedge 2 — every Output-valued prop lost wholesale (`undefined`, not
      // `[undefined]`): the whole hostnames array AND the csr. Guarded both
      // before and after the fix in `read`; csr must be wedged too because
      // `diff` keys its "no prior props" guard off `olds.csr`. Recovery is
      // the same: read reports missing, the engine re-creates.
      yield* wedgeRow({ hostnames: undefined, csr: undefined });
      const recovered2 = yield* deployCert();
      expect(recovered2.certificateId).toBeTruthy();
      expect(recovered2.hostnames).toEqual([hostname]);
      const live2 = yield* getCertificate(recovered2.certificateId);
      expect(live2.hostnames).toEqual([hostname]);
      expect(live2.revokedAt ?? null).toBeNull();

      yield* stack.destroy();
      yield* expectRevoked(recovered2.certificateId);

      // Explicitly reclaim the certificates the wedges orphaned.
      yield* revokeQuietly(created.certificateId);
      yield* revokeQuietly(recovered.certificateId);
      yield* expectRevoked(created.certificateId);
      yield* expectRevoked(recovered.certificateId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider("replacement on requestedValidity change", (stack) =>
  Effect.gen(function* () {
    const hostname = `originvalidity.${zoneName}`;
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("ValidityCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(initial.requestedValidity).toEqual(90);

    // There is no update API — changing the validity issues a new
    // certificate and revokes the old one.
    const replaced = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("ValidityCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 30,
      }).pipe(adopt(true)),
    );

    expect(replaced.certificateId).not.toEqual(initial.certificateId);
    expect(replaced.requestedValidity).toEqual(30);
    yield* expectRevoked(initial.certificateId);

    const live = yield* getCertificate(replaced.certificateId);
    expect(live.revokedAt ?? null).toBeNull();

    yield* stack.destroy();
    yield* expectRevoked(replaced.certificateId);
  }).pipe(logLevel),
);

test.provider("replacement on hostnames change", (stack) =>
  Effect.gen(function* () {
    const hostname = `originhostsa.${zoneName}`;
    const altHostname = `originhostsb.${zoneName}`;
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("HostnamesCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(initial.hostnames).toEqual([hostname]);

    // Hostnames are immutable — changing the set issues a new certificate
    // and revokes the old one.
    const replaced = yield* stack.deploy(
      Cloudflare.OriginCaCertificate.OriginCaCertificate("HostnamesCert", {
        csr: TEST_CSR,
        hostnames: [hostname, altHostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    expect(replaced.certificateId).not.toEqual(initial.certificateId);
    expect([...replaced.hostnames].sort()).toEqual(
      [hostname, altHostname].sort(),
    );
    yield* expectRevoked(initial.certificateId);

    yield* stack.destroy();
    yield* expectRevoked(replaced.certificateId);
  }).pipe(logLevel),
);
