import * as AWS from "@/AWS";
import { Certificate, waitForRoute53Change } from "@/AWS/ACM/Certificate.ts";
import { HostedZone } from "@/AWS/Route53";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// ACM certificates for CloudFront are provider-pinned to us-east-1; every
// out-of-band ACM call in this file must target the same region.
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "polls Route53 validation changes returned with resource-path IDs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* stack.deploy(
        HostedZone("CertificateValidationZone", {
          name: "alchemy-certificate-change-id.alchemy.",
          forceDestroy: true,
        }),
      );

      const change = yield* route53.changeResourceRecordSets({
        HostedZoneId: zone.id.replace(/^\/hostedzone\//, ""),
        ChangeBatch: {
          Comment: "ACM Route53 change ID regression test",
          Changes: [
            {
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: `_validation.${zone.name}`,
                Type: "TXT",
                TTL: 60,
                ResourceRecords: [{ Value: '"alchemy"' }],
              },
            },
          ],
        },
      });

      expect(change.ChangeInfo.Id).toMatch(/^\/change\//);
      const completed = yield* waitForRoute53Change(change.ChangeInfo.Id);
      expect(completed.Status).toBe("INSYNC");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

// Canonical `list()` test (AWS account/region-scoped collection): request a
// real ACM certificate (no DNS validation, stays PENDING_VALIDATION), resolve
// the provider from context via the typed `findProvider` helper, call `list()`,
// and assert the deployed certificate ARN appears in the exhaustively-paginated
// result. A PENDING certificate is fully enumerable and deletable.
test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("ListCertificate", {
            domainName: "alchemy-acm-list-test.example.com",
          });
        }),
      );

      expect(cert.certificateArn).toBeDefined();

      const provider = yield* Provider.findProvider(Certificate);
      // ACM `ListCertificates` is eventually consistent — a freshly requested
      // certificate can take a few seconds to surface in the paginated
      // listing. Poll until our ARN appears, bounded.
      const all = yield* Effect.gen(function* () {
        const result = yield* provider.list();
        if (!result.some((c) => c.certificateArn === cert.certificateArn)) {
          return yield* Effect.fail(new CertificateNotListed());
        }
        return result;
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "CertificateNotListed",
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );

      expect(all.some((c) => c.certificateArn === cert.certificateArn)).toBe(
        true,
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

class CertificateNotListed extends Data.TaggedError("CertificateNotListed") {}

// Exportability is fixed at request time — ACM rejects
// `UpdateCertificateOptions` for the export option ("Export option for
// certificates cannot be updated"), so changing `export` must REPLACE the
// certificate with a freshly requested one.
test.provider.skipIf(!!process.env.FAST)(
  "replaces the certificate when the export option changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = "alchemy-acm-options-test.example.com";
      const deployWith = (exportOption: "ENABLED" | "DISABLED") =>
        stack.deploy(
          Certificate("OptionsCertificate", {
            domainName,
            export: exportOption,
          }),
        );

      const created = yield* deployWith("ENABLED");
      expect(created.certificateArn).toBeDefined();
      expect(created.export).toBe("ENABLED");

      const updated = yield* deployWith("DISABLED");
      expect(updated.certificateArn).not.toEqual(created.certificateArn);
      expect(updated.export).toBe("DISABLED");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// A `creating` state row persisted before upstream Outputs resolve cannot
// round-trip Output-valued props (`domainName` from a HostedZone Output,
// `hostedZoneId`) — they deserialize as `undefined`. In the worst case the
// row's props are junk and the engine's deletion-planning branch (which every
// `destroy` and every deploy that drops the resource runs) calls
// `provider.read` with those junk `olds`. Before the fix, `read` dereferenced
// `olds!` unconditionally (`findManagedCertificate` reads
// `props.keyAlgorithm` / `props.domainName`), so planning crashed with a
// TypeError and wedged the stack — plan/deploy/destroy all build a plan, so
// there was no CLI escape hatch.
//
// Simulate exactly that row after a real deploy and assert the guarded `read`
// reports "not found" instead of crashing: destroy succeeds (skipping the
// physical delete, since no attr could be recovered), and a follow-up deploy
// of the same program converges on the SAME leaked certificate (found by
// domain + SAN + alchemy ownership tags) — no duplicate is requested.
test.provider.skipIf(!!process.env.FAST)(
  "recovers a wedged creating-state certificate whose props were lost (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = "alchemy-acm-recovery-736.example.com";
      const deployCertificate = () =>
        stack.deploy(
          Certificate("RecoveryCertificate", {
            domainName,
            // List the primary domain explicitly: ACM's DescribeCertificate
            // reports it in SubjectAlternativeNames, and recovery-by-search
            // (`findManagedCertificate`) compares that list against the
            // props' SAN list — aligning them is what lets the redeploy
            // below converge on the leaked certificate.
            subjectAlternativeNames: [domainName],
          }),
        );

      const created = yield* deployCertificate();
      expect(created.certificateArn).toBeDefined();

      // Safety net: reclaim the certificate on scope close even if the body
      // fails mid-way (e.g. during the pre-fix crash verification).
      yield* Effect.addFinalizer(() =>
        withUsEast1(
          acm.deleteCertificate({ CertificateArn: created.certificateArn }),
        ).pipe(Effect.ignore),
      );

      // `ListCertificates` is eventually consistent; the recovery redeploy
      // below finds the certificate through it, so wait (bounded) until the
      // fresh ARN is visible before wedging the state.
      yield* Effect.gen(function* () {
        const listed = yield* withUsEast1(acm.listCertificates({}));
        if (
          !listed.CertificateSummaryList?.some(
            (summary) => summary.CertificateArn === created.certificateArn,
          )
        ) {
          return yield* Effect.fail(new CertificateNotListed());
        }
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "CertificateNotListed",
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(18),
          ]),
        }),
      );

      // Rewrite the certificate's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and the
      // props lost in the Output round-trip.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) &&
          r.row.resourceType === "AWS.ACM.Certificate",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no AWS.ACM.Certificate state row found after deploy"),
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
          props: undefined as never,
        },
      });

      // Deletion planning reads the wedged row with `olds: undefined`.
      // Before the fix this crashed with
      // `TypeError: undefined is not an object (evaluating 'props.keyAlgorithm')`;
      // after it, `read` reports "not found", the physical delete is skipped
      // (no attr could be recovered) and the row is reaped.
      yield* stack.destroy();

      // The certificate itself leaked (the wedged row had no recoverable
      // attr) — redeploying the same program must converge on it via
      // domain + SAN + ownership tags instead of requesting a duplicate.
      const recovered = yield* deployCertificate();
      expect(recovered.certificateArn).toEqual(created.certificateArn);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
