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

// Self-signed RSA-2048 fixtures generated once with openssl (not at test time).
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUY07uz+vKYeBK3NYMhk03eWyTPKkwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYS50ZXN0MB4XDTI2MDgyNDE1NDM0
NFoXDTM2MDgyMTE1NDM0NFowHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzUAYVVO5iOluteYkxOqA
bBF+EnWrtfsUMoPJPXBEIrmT66G+vx+rArDsRxJqnWr9YstEQKsHtkErGF37avZr
12jTIiKWk9auxyhN8O6WD2jND13m+IfsdeWKSIFx3j/RJ0McJQYu4YuN8ViZm3t9
o3f5N+4DczgqzloV7U6/DFeMZ23nwBD9IgrUf6KyGoC/sJ4twTjpxSECekiOHgyn
/M7SwrBTJYJTsMXzqYBPVjk7f17+7LAwNqBNzQx6HsGV8sZX4kDlcMAL53obLV1z
kkJHhP3suaWCUl5uarZ9r5vc7DC2j6vvtghFsDvRWqqram3fCEOJOQmoAVlChbtq
SwIDAQABo3IwcDAdBgNVHQ4EFgQUEicpezwWkZY3JMEwx1D0eraiFCEwHwYDVR0j
BBgwFoAUEicpezwWkZY3JMEwx1D0eraiFCEwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJhbGNoZW15LXNzbC1hLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAMRj
u6+KYAYwX/cuJruXaX7Pa9kX4Es+637dDPWBP9lLedVOGEpOujiDn2JUuNZNl6vo
eqaJrjQuJkSgVVYikz3dGWTEvqlDIJ5nbRIo8etW1d5eoZeWcd95t2VXNRlfULBS
eNOFYOI6iaPW2CQXFvNAgER/Azj8Y4ilky504m0bqkZWTl/2f+x1KaiBqkxqiOdX
n5gPpu+jujVOyJni7KJo4+iIdWtQI1xAazXyOFefTMkPGLkXeQ/+tXrmY9NoVvNO
JBEe8o+wi/LxH/K9/It1rCfWckb5zHU57li4ZxetlwYssVW4Of25sMp9c4JNF3gJ
mkhcNRA0cRkbnom+kn8=
-----END CERTIFICATE-----`;

const KEY_A = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDNQBhVU7mI6W61
5iTE6oBsEX4Sdau1+xQyg8k9cEQiuZProb6/H6sCsOxHEmqdav1iy0RAqwe2QSsY
Xftq9mvXaNMiIpaT1q7HKE3w7pYPaM0PXeb4h+x15YpIgXHeP9EnQxwlBi7hi43x
WJmbe32jd/k37gNzOCrOWhXtTr8MV4xnbefAEP0iCtR/orIagL+wni3BOOnFIQJ6
SI4eDKf8ztLCsFMlglOwxfOpgE9WOTt/Xv7ssDA2oE3NDHoewZXyxlfiQOVwwAvn
ehstXXOSQkeE/ey5pYJSXm5qtn2vm9zsMLaPq++2CEWwO9Faqqtqbd8IQ4k5CagB
WUKFu2pLAgMBAAECggEASEceaonZx69gV7jsUNW9lJDSYyDB74sz0RgceUC8Fbhh
MTSbrcUynPd9tQd0uOuQwEYRSm6QACvRx7psy31se4ZD93zTpssOcD6ut73k5RdE
QvmP2QxQhjHncOH4ncm+VwOoeRdE0hMpUIihSyIBG9wnTH1KBLyOQm1x1EgLOgZH
DPtZPUg4j/KeMF5HbI0ZycSeMtWmwhYfsHrgFH/lIm/6TKaEJ0SNlFcW4GzMlxi3
KEeoBw5RhKwY+Hs+zEy78udGqe+5aahSqk7IaO1UlDEmBFoNksuC6ZyEXITPJKbV
BU8rH6jI/xdHqdOaWBI/rLYxgm2IMrqANR3B0hF78QKBgQDnpFmpyfoj2w7nxhlg
d+9RuXC55Q0UMXPPIZ3b4lmNqmPcgkC55pu64D6snxj3HBeWvZ8a8E7WifW6fo0V
68wpzBfMIiE7h0YWeNpfhCZnz61xOblshTpKy+QHIl5iBmrQUUfMuMjJKmIynjyI
WRT/d+OzzWm2eDsNoajpT4gFcQKBgQDi1Uy76+xggrLvHYfhEFyz6UYn9xVe7Chl
ru1vHQjTIx+V0pDmlHpKbK0+tyspZTeWYYMwRzqol7u76mmXZXZ7WK3aFA6Q8aYl
4KO6wS70Lryt5oB5QFvpkiSMFl1bzHGvCxCTX+uieR796Pfms6zHwzK0/ibe8lEJ
KNplRXMdewKBgQC9aHG4l+LldrWVZzJQ40DY/lziZBxxqo4bjE1cApVfdTf6krcC
S0KDZ+FXnS/4vwu6wopaqKyOWHiJaflLN2fVtYCv9iheWJpCvccx2wjcUcBsmNq5
laa4ikeGXd/3H3AvroabK21isDljUmgExXKaAho6Z3hNL7p5xvoq7FE4wQKBgQC5
bXCK9nOG+ZDYk6VuQHfnwrxNE1ju/dKQPQ1vlaaPItlBGp7FP38ws+JzsDyiXFGy
pwgdQT0ccN1Q4nFrB9BxSK7l5Rt7NW+C6z4s/psplcM7zYAcnpYEPCmQMwAieOA+
HadxMipn6OeC3R06BIsryc/70P9ppWDFQhY2Ty2pXQKBgCPjmTUuOwE1J0aegpb3
eBZPBH701wZufH75uMVB5PApxO1PKMyRqeOMhbLGxws6jgf2YOPqmB9zSjQWEeQ/
ME7uU5bUhTH24H7jqxo3U7wWVRWgy2TvR4gfcfI9QKVXSzDBauq1DiW86j6edI+2
fygch3+OZKV+N0l93MQpSWv4
-----END PRIVATE KEY-----`;

const certificateIdOf = (name: string) => name.split("/").pop() ?? name;

const hasCertificate = (
  names: readonly string[] | undefined,
  certName: string,
) =>
  (names ?? []).some(
    (name) => certificateIdOf(name) === certificateIdOf(certName),
  );

const waitUntilGone = (name: string) =>
  certificatemanager
    .getProjectsLocationsCertificateMapsCertificateMapEntries({ name })
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
  "create, update, and delete a certificate map entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.CertificateManager.CertificateMap(
            "FrontendMap",
            {
              location: "global",
              description: "frontend map for entries",
            },
          );
          const certA = yield* GCP.CertificateManager.Certificate("TlsA", {
            location: "global",
            pemCertificate: CERT_A,
            pemPrivateKey: KEY_A,
          });
          const entry = yield* GCP.CertificateManager.CertificateMapEntry(
            "Www",
            {
              certificateMap: map.name,
              description: "entry a",
              labels: { env: "test" },
              certificates: [certA.name],
              hostname: "alchemy-ssl-a.test",
            },
          );
          return { map, certA, entry };
        }),
      );

      expect(created.entry.name).toContain("/certificateMapEntries/");
      expect(created.entry.certificateMapEntryId).toEqual(expect.any(String));
      expect(created.entry.certificateMap).toEqual(created.map.name);
      expect(created.entry.location).toEqual("global");
      expect(created.entry.description).toEqual("entry a");
      expect(created.entry.labels).toMatchObject({ env: "test" });
      expect(created.entry.hostname).toEqual("alchemy-ssl-a.test");
      expect(created.entry.certificates).toContain(created.certA.name);
      expect(created.entry.createTime).toEqual(expect.any(String));

      const fetched =
        yield* certificatemanager.getProjectsLocationsCertificateMapsCertificateMapEntries(
          {
            name: created.entry.name,
          },
        );
      expect(fetched.name).toEqual(created.entry.name);
      expect(fetched.hostname).toEqual("alchemy-ssl-a.test");
      expect(fetched.description).toEqual("entry a");
      expect(fetched.labels?.env).toEqual("test");
      expect(hasCertificate(fetched.certificates, created.certA.name)).toEqual(
        true,
      );
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.CertificateManager.CertificateMap(
            "FrontendMap",
            {
              certificateMapId: created.map.certificateMapId,
              location: "global",
              description: "frontend map for entries",
            },
          );
          const certA = yield* GCP.CertificateManager.Certificate("TlsA", {
            certificateId: created.certA.certificateId,
            location: "global",
            pemCertificate: CERT_A,
            pemPrivateKey: KEY_A,
          });
          const entry = yield* GCP.CertificateManager.CertificateMapEntry(
            "Www",
            {
              certificateMap: map.name,
              certificateMapEntryId: created.entry.certificateMapEntryId,
              description: "entry b",
              labels: { env: "prod", role: "sni" },
              certificates: [certA.name],
              hostname: "alchemy-ssl-a.test",
            },
          );
          return { map, certA, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.description).toEqual("entry b");
      expect(updated.entry.labels).toMatchObject({ env: "prod", role: "sni" });
      expect(updated.entry.hostname).toEqual("alchemy-ssl-a.test");
      expect(updated.entry.certificates).toContain(created.certA.name);

      const refetched =
        yield* certificatemanager.getProjectsLocationsCertificateMapsCertificateMapEntries(
          {
            name: created.entry.name,
          },
        );
      expect(refetched.description).toEqual("entry b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("sni");
      expect(refetched.hostname).toEqual("alchemy-ssl-a.test");
      expect(
        hasCertificate(refetched.certificates, created.certA.name),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 120_000,
  },
);
