import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { TrustStore } from "@/AWS/ELBv2";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A self-signed CA certificate generated once and checked in (never created at
// test time, per the fixture convention). X.509 v3 with basicConstraints
// CA:TRUE + keyCertSign — ELBv2 trust stores reject v1 certs
// ("The certificate version is not supported").
const CA_BUNDLE_PEM = `-----BEGIN CERTIFICATE-----
MIIC2jCCAcKgAwIBAgIJAJyM/Dvd55qtMA0GCSqGSIb3DQEBCwUAMBoxGDAWBgNV
BAMMD2FsY2hlbXktdGVzdC1jYTAeFw0yNjA2MTcwNjA5MDlaFw0zNjA2MTQwNjA5
MDlaMBoxGDAWBgNVBAMMD2FsY2hlbXktdGVzdC1jYTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBANgo7XPCQMpyecXg2SCj6Tn6R1snlmhSA1vKGQnHoQBS
QA11DMpv+iFRT9s1d3izaGA4GEcxfrXOsmUBkzYIHJIYakCWdr6qcUXs6lS2uhnZ
qcyR0CamDtHTqAxRKEK+QPaISoxyD3BIwQqE0I8yNzV3/6osIE513e+7tp9E+J04
dBhyG5goSwR3ueqs53gQioYVp/fgLKo4MqFcsA3p7anEE9hyeq1Q/lGAXxQwZmXT
3kQli/JjMoF8OfccpA3aBx9Y2aDTCU8HXTscVYmPSHbnTGkTARGBwnag+Jwq5Uni
YvM2OeDUPwvszgpi3JgiblZQhZQAy4/MeNhmE8qgIa8CAwEAAaMjMCEwDwYDVR0T
AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAJnp
el0xBbL/eQY87evhy0o+ZTHMVCdI9Uc+kDK0XPMi4hc5OfjWNIy8u5/s33kPkNYS
Y5Jhm5KtGtMb9kXioCWjSi0aREA8zijGrXn1jC+0rksMQmJka63bKsJ4TjFaHMcc
m/xt25xX1Ssp/gWr9YX3MzbPhcn57Uu9OTtzf13F6CMv1XtRS1RKFYtkLZrhvzBR
WPdos3xvn3D0Fjd5H5AgVKTkeb2YPhINfN4jyzn3J09teKZpNN/qHTAQewIh2FnO
MeplcuT3eQVUZNTBelvUE7VKHe11AUc8TkvVMS/XOFeN6OHAJtq08EegbTcjwz9Z
lyGGetkNMmdhGRV6AlY=
-----END CERTIFICATE-----
`;

// Idempotent out-of-band delete for the probe trust store below. The probe
// create is EXPECTED to fail, but if it ever unexpectedly succeeded the store
// would live outside the stack — so cleanup must be guaranteed. Not-found is
// success; any other error is a defect, so the error channel is `never` and
// this is a valid `Effect.ensuring` finalizer.
const deleteTrustStoreByNameIdempotent = (name: string) =>
  elbv2.describeTrustStores({ Names: [name] }).pipe(
    Effect.flatMap((r) =>
      Effect.forEach(
        (r.TrustStores ?? []).flatMap((t) =>
          t.TrustStoreArn ? [t.TrustStoreArn] : [],
        ),
        (arn) => elbv2.deleteTrustStore({ TrustStoreArn: arn }),
      ),
    ),
    Effect.catchTag("TrustStoreNotFoundException", () => Effect.void),
    Effect.orDie,
    Effect.asVoid,
  );

// Fast unconditional probe: createTrustStore against a non-existent bundle
// must surface a typed error (not an untyped catch-all). Proves both the
// resource wiring and the distilled typed-error path.
test.provider(
  "trust store create with missing bundle returns a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probeName =
        `alchemy-mtls-probe-${stack.name.replace(/[^a-zA-Z0-9]/g, "")}`.slice(
          0,
          32,
        );

      // Pre-clean: reclaim a probe trust store leaked by a prior crashed run
      // (a leftover would turn the expected error into DuplicateTrustStoreName).
      yield* deleteTrustStoreByNameIdempotent(probeName);

      yield* Effect.gen(function* () {
        const result = yield* elbv2
          .createTrustStore({
            Name: probeName,
            CaCertificatesBundleS3Bucket: "alchemy-no-such-bucket-elbv2-probe",
            CaCertificatesBundleS3Key: "missing.pem",
          })
          .pipe(Effect.flip);

        // AWS rejects a missing/inaccessible bundle with one of these typed tags.
        expect(
          [
            "CaCertificatesBundleNotFoundException",
            "InvalidCaCertificatesBundleException",
          ].includes(result._tag),
        ).toBe(true);
      }).pipe(
        // Guaranteed cleanup if the create ever unexpectedly succeeds.
        Effect.ensuring(deleteTrustStoreByNameIdempotent(probeName)),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Full mTLS-verify lifecycle: upload a CA bundle to a stack-owned bucket,
// create an ACTIVE trust store, then destroy. Runs ungated — verified live on
// the standard testing account (completes in a few seconds).
test.provider(
  "trust store full lifecycle from an uploaded CA bundle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TsBucket", { forceDestroy: true });
          return { bucketName: bucket.bucketName };
        }),
      );

      const key = "ca-bundle.pem";
      yield* s3.putObject({
        Bucket: deployed.bucketName,
        Key: key,
        Body: CA_BUNDLE_PEM,
        ContentType: "application/x-pem-file",
      });

      const ts = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TsBucket", { forceDestroy: true });
          const trustStore = yield* TrustStore("TsStore", {
            caCertificatesBundleS3Bucket: bucket.bucketName,
            caCertificatesBundleS3Key: key,
          });
          return { trustStore };
        }),
      );

      expect(ts.trustStore.status).toBe("ACTIVE");
      expect(ts.trustStore.numberOfCaCertificates).toBeGreaterThanOrEqual(1);

      const observed = yield* elbv2
        .describeTrustStores({
          TrustStoreArns: [ts.trustStore.trustStoreArn],
        })
        .pipe(Effect.map((r) => r.TrustStores?.[0]));
      expect(observed?.Status).toBe("ACTIVE");

      yield* stack.destroy();

      const after = yield* elbv2
        .describeTrustStores({
          TrustStoreArns: [ts.trustStore.trustStoreArn],
        })
        .pipe(
          Effect.map((r) => r.TrustStores?.length ?? 0),
          Effect.catchTag("TrustStoreNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
