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

const CERT_B = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUW1TNbunaoG4/NzJZSThMKRTZuw4wDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYi50ZXN0MB4XDTI2MDgyNDE1NDM0
NFoXDTM2MDgyMTE1NDM0NFowHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYi50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA77IIHhQKx9IOuqN9lUwn
oqPG+LeafxTE9cKaQsO21FgjlsSvHlZqGdtdojevDYucWYgWwtOpj5FASpMGW5Kg
2PcZk8dgpXT6byYIicDA8jJVx93sFBxn2BhYvvCfWRbqPSo3SoF3DCS6AQiZX8zl
u+Cs63Tfo2OCbCqlPylm2DGhNfs1KI22lLrU3ay0zHjeUtiK4+CQVij8He+e48mH
MwwWtWXKP/eikQlnV4c6OYA6rLLXBvKy3g1zavBAEY5GLECP/xt1bj2qgTUge8L4
Xr45pBj3l6Ku1thDefS9mXcHt456VeEkWir0O7cnBN903BbzhNV7vTHVfS5I8ZTg
jQIDAQABo3IwcDAdBgNVHQ4EFgQU07mM+3JilvETyfGSF5I6Al+B8gIwHwYDVR0j
BBgwFoAU07mM+3JilvETyfGSF5I6Al+B8gIwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJhbGNoZW15LXNzbC1iLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAOFT
KwWAxvo2/g+ErYxKT7Tl3ObBmUGC93T2KX38bw2jq7+7dgTJnz2kN6V5PRaq1iXj
lmCF++dJJpCPdSiBhYNkoUIk7st0n9Mz/3oJBzass3wFY0dHw7r895rTfjkRF+F5
Fw9dTXzy0a0Gni4I6jEWflEVXAFb0q6RJ6zHdGiriJsXvXKC8eVBJqRCy+NbufpL
efSfgplQfXSteOlOnRP9iWsK3AH1TVw6RwLaT3iVWSbWjICf3f+8xJ65j/vNjbnY
2F2+hBmKEXfRv5liZIhV1Q9gxbpjvzw2OzaoQxkZYNbaU96yy5TsG1jGd0wqX/vT
MbTsvjb7gbJeTqYGQeA=
-----END CERTIFICATE-----`;

const waitUntilGone = (name: string) =>
  certificatemanager.getProjectsLocationsTrustConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const pemOf = (value: string | undefined) => (value ?? "").replace(/\s+/g, "");

test.provider(
  "create, update, and delete a trust config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.TrustConfig("ClientMtls", {
            location: "global",
            description: "mtls a",
            labels: { env: "test" },
            trustStores: [
              {
                trustAnchors: [{ pemCertificate: CERT_A }],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/trustConfigs/");
      expect(created.trustConfigId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("mtls a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.trustStores).toHaveLength(1);
      expect(
        pemOf(created.trustStores[0]?.trustAnchors?.[0]?.pemCertificate),
      ).toEqual(pemOf(CERT_A));

      const fetched =
        yield* certificatemanager.getProjectsLocationsTrustConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("mtls a");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.trustStores).toHaveLength(1);
      expect(
        pemOf(fetched.trustStores?.[0]?.trustAnchors?.[0]?.pemCertificate),
      ).toEqual(pemOf(CERT_A));
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.TrustConfig("ClientMtls", {
            trustConfigId: created.trustConfigId,
            location: "global",
            description: "mtls b",
            labels: { env: "prod", role: "mtls" },
            trustStores: [
              {
                trustAnchors: [{ pemCertificate: CERT_A }],
              },
            ],
            allowlistedCertificates: [{ pemCertificate: CERT_B }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("mtls b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "mtls" });
      expect(updated.allowlistedCertificates).toHaveLength(1);
      expect(pemOf(updated.allowlistedCertificates[0]?.pemCertificate)).toEqual(
        pemOf(CERT_B),
      );

      const refetched =
        yield* certificatemanager.getProjectsLocationsTrustConfigs({
          name: created.name,
        });
      expect(refetched.description).toEqual("mtls b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("mtls");
      expect(
        pemOf(refetched.allowlistedCertificates?.[0]?.pemCertificate),
      ).toEqual(pemOf(CERT_B));
      expect(
        pemOf(refetched.trustStores?.[0]?.trustAnchors?.[0]?.pemCertificate),
      ).toEqual(pemOf(CERT_A));

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 90_000,
  },
);
