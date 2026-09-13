import * as Hetzner from "@/Hetzner";
import { waitForAction } from "@/Hetzner/actions.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;
const managedEnabled = !!process.env.HCLOUD_TEST_MANAGED_CERT;
const managedDomain = process.env.HCLOUD_TEST_MANAGED_CERT_DOMAIN;

/**
 * Self-signed RSA-2048 certificates generated once with openssl and checked
 * in so every test run uploads identical PEMs (never generated at test time):
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout cert1.key -out cert1.pem \
 *   -days 3650 -subj "/CN=alchemy-hetzner-cert-1.test/O=Alchemy/C=US"
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout cert2.key -out cert2.pem \
 *   -days 3650 -subj "/CN=alchemy-hetzner-cert-2.test/O=Alchemy/C=US"
 * ```
 */
const CERT_1 = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe4CCQCYVsVxbXZqpzANBgkqhkiG9w0BAQsFADBFMSQwIgYDVQQDDBth
bGNoZW15LWhldHpuZXItY2VydC0xLnRlc3QxEDAOBgNVBAoMB0FsY2hlbXkxCzAJ
BgNVBAYTAlVTMB4XDTI2MDgxOTAyMzIyNloXDTM2MDgxNjAyMzIyNlowRTEkMCIG
A1UEAwwbYWxjaGVteS1oZXR6bmVyLWNlcnQtMS50ZXN0MRAwDgYDVQQKDAdBbGNo
ZW15MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMaBAUIwQTo4NGnmAZofYr+rXA3bOzgEQFb3algRdWJ+Nhxb/ztnofTcwSCDAg+G
ylGKsmDb2Rn/ycpnWnMZ+TUcChtta1KCd6z5OhM0/qArkN7ymQra7GcquEev9eeO
e+YnK71qbE6bpWDvf6KB38iWihEh2yv0WjD7zgYXZ8vaE5s0hXp+TzAphqIs4rqr
1WHKOYCJvOxwf3GUS5JmpvfBxEPoVcaEIzita+gq9AQ803ng6i3b2tKTynD2WMgt
XioTLx0tLCMsGX4gzTn/ppGzr6h9UTB4Z5z51SvGxBgu1Hflkjbamgt+B8sGAOwa
QmYTkKbh9oOZzlwPxzvciCECAwEAATANBgkqhkiG9w0BAQsFAAOCAQEARW7Y+Y3A
25HPbn/myawc6RZnO3upBhgwcWGE0uKOC1YFW1aoyUFeKxHTDyUILGyTIruQZzdi
oRGaFvgDsJ3w4uFX0GLA5yqqyOmPLwOCAM6jPTPMDo3jTK1GqmhvfEHX1EQSjvBN
CQIQRoEoCZ/P8C/S28OHm68xzmoGHVUrkcFF7p5pvYNEmFv5feGnNdETo+PXsYk8
34+twQPo+3l2XLMvxZ23LuR5MOYPb2Zngqwr9O3kUGgRaA1d4pOTgKqFnyURpRxP
dgm5M499x1rgGi6w2g4iUCdfXRUg0/NmYjRLqzsWiIf2zQY3n3EOZQZpcnSjcw67
y9e7q3mdV0YX4g==
-----END CERTIFICATE-----
`;

const KEY_1 = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDGgQFCMEE6ODRp
5gGaH2K/q1wN2zs4BEBW92pYEXVifjYcW/87Z6H03MEggwIPhspRirJg29kZ/8nK
Z1pzGfk1HAobbWtSgnes+ToTNP6gK5De8pkK2uxnKrhHr/XnjnvmJyu9amxOm6Vg
73+igd/IlooRIdsr9Fow+84GF2fL2hObNIV6fk8wKYaiLOK6q9VhyjmAibzscH9x
lEuSZqb3wcRD6FXGhCM4rWvoKvQEPNN54Oot29rSk8pw9ljILV4qEy8dLSwjLBl+
IM05/6aRs6+ofVEweGec+dUrxsQYLtR35ZI22poLfgfLBgDsGkJmE5Cm4faDmc5c
D8c73IghAgMBAAECggEBAJv466s9TVNYrF51WtbmSGpAVCGTHFHkjUWIPKgcd7a/
YvcflknwIQLMnndUWT8n8zrlF0oiFNFn+f+u/BQq2XTQpmRssoJvf2eLoQVMg7II
6Vk1F+m+oThjCc9SRI8Alvv91VGNGLMfe2/SX+Cp2dO77ZqOlq9P3bpVcMm6hFVY
jdgpEmtFroowpmtyh1mZswuf4iQVHhKwKu2nIYmaIPHpzn+M5/nSYJZ6IvQXSsp/
s0Vzf28XgEtzD+yzsTf8gUmUoFtv6zmHOtuiZheuSTRUrND5CRRqtyZyKQKeBD00
O1jFkn3CDgrwO+Hd/f5Ls6kiXpIoGZmrd68lChce110CgYEA+8kX0WRroawDsQQJ
RSP/JmWlPS8I5GZzcNHZzrhbX6YYHXotbK70B2IdPSaU3npdHyDJ0HIi88fLywxY
X+zZp3R5OEiBxswIgCYAw6sHLjVUj2g0q25UNE+ELtGJ5wfP8WkoPnsQbS3b61r1
YAPbx27uc/oznlYpvl6MemkMya8CgYEAydOZVmOs4p7xRO5OtplMlscdiON8ZAQB
l8jYpJvnXN/k+kZzEmFpIZsK43Q0tK7DivsIh7EZS5Fy05TmmqBUDOb/S6++8eX2
wB8aN5zb0iAjpJmt8ElkpXBr7G9PqnltkIsBBU8LKCcnPCZH3Gr6Mu+thwoAAAvi
vrNaAHpBzy8CgYAxhpWbx2/wZiB3wj58jh8TE21UQpsyKgDNEUoRgmvevZICwlSL
C0LO7PqpW5xuwozsoYtw5/J+Fy+76dq8S59oc92gN4rnapzFcDQ4SLzp1u2iI7Iw
gkwn2fg7KVZBzmSVrMSQva42e43FlqerUjb53JUk1PMwUux1GK3zKhSs2wKBgFR8
OVIKg5KSCllakKSrY34yd9CXubh8XNZXAylVAfLE3qtN1lm5YTLqHhK80FtaVQzW
rOlwXzBdAH5FdIsB1m1YPUJHnVzRcQtXebgR94rsXT9H/aH6dyEyAFuG9QhdsFmz
dofsYLU8PpZVR/ui5H1yC2fd7cYXM6G0nlZY1zeNAoGBAIslugHQdDguMaTo/D3F
aReim26Q1wa0bRoq0Pf96DQjDJFi4tKpDPh/nuVrqhND6r3gySFf0uGHvGvuz3DP
QDrbiXojN6AOtwUaqdn2l9J64io3MF5N6GLF/03MfSyUQpTl9BVH/fqQ4o74n9Cr
4AYpPy5ePvZaKOxuaOY7o6v7
-----END PRIVATE KEY-----
`;

const CERT_2 = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe4CCQD19r7W0wv1wDANBgkqhkiG9w0BAQsFADBFMSQwIgYDVQQDDBth
bGNoZW15LWhldHpuZXItY2VydC0yLnRlc3QxEDAOBgNVBAoMB0FsY2hlbXkxCzAJ
BgNVBAYTAlVTMB4XDTI2MDgxOTAyMzIyNloXDTM2MDgxNjAyMzIyNlowRTEkMCIG
A1UEAwwbYWxjaGVteS1oZXR6bmVyLWNlcnQtMi50ZXN0MRAwDgYDVQQKDAdBbGNo
ZW15MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ANUS0qNOphwQpQZjxs86IrWR2AQqSNxErdFh8O5nLQIlCdSoTizkM/g8IMoTbNFb
KGoFYH+poNKcWuXbqzzmUm6Q2Nd5Iyry+3FEUxh9tu4+ynbGIe8wG/16wuHC2pU/
bdj65LYF7X3cazPcPRokRrNxm2E/GxNhju91A8NfilMspUCau3PhKT+h9Bc2lukH
a6+eTjFW7LHyo5yXyIi1/hUb7FNgVsCdAQ8cy3Re48Z4ekmhVmwpd+BNMdUNQ0u6
FMuV8NwJVuldVNUL9FW6sjjLL9AkMdRcKkOmCRJK8V7Q9dL0/2AvG5Pm2aL/FNiI
eEam9wWW9kncjdBTICVuel0CAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAHvU4jLKC
a2uqt49j68i6z8GZgyLj4gXI+Xsx26aY7ZqpO2JLubBoh8oDAMAa2MsXFX0cLzjU
K75C9/JmtD/eNyN4cx5x2gamw/SA9Of+5MK5MoaGUT3gvYaci0MtG6oVy/rg/6oJ
bw+EDhZr2vl1RB1B8W+ioIc//T6h2x//DL5j3sHKBQoPCzkr6eCv4DxpnmT29xNz
0IM1CDCraCMagE0Yy8tZUZ6Hx+4xTl51CNdITOjgChx0ml05hi2kXmOoXO1p0QO+
g940wVRm3D/w+k/Kcrr3MjD80fYtwR4KsUGI0CDmd4kD0sfLbea5/A2Pa/vpqfL8
as0SaX4IMSA4Xw==
-----END CERTIFICATE-----
`;

const KEY_2 = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDVEtKjTqYcEKUG
Y8bPOiK1kdgEKkjcRK3RYfDuZy0CJQnUqE4s5DP4PCDKE2zRWyhqBWB/qaDSnFrl
26s85lJukNjXeSMq8vtxRFMYfbbuPsp2xiHvMBv9esLhwtqVP23Y+uS2Be193Gsz
3D0aJEazcZthPxsTYY7vdQPDX4pTLKVAmrtz4Sk/ofQXNpbpB2uvnk4xVuyx8qOc
l8iItf4VG+xTYFbAnQEPHMt0XuPGeHpJoVZsKXfgTTHVDUNLuhTLlfDcCVbpXVTV
C/RVurI4yy/QJDHUXCpDpgkSSvFe0PXS9P9gLxuT5tmi/xTYiHhGpvcFlvZJ3I3Q
UyAlbnpdAgMBAAECggEAIxs81Wdp+wnLBuh9ozsi6OOkwdrtsk0mjm8isUUSp13O
5tjsOH1JCsdtZ54Xuc7ZM866/Y3HT6wvVdwBtMEGJ+15rNbqsnLiduEZB9n+v/Zc
iYFPqgc1NWh6n5PpS9ntkWiVMmB7ptcgWqUY9Cux8nLvdPBe16ylTlLrUc92DQnr
CCxsJkvAFUbQksrbbUDPRPszpo/DyPzKBckzFq8Y68cqnArkKtlOaPJcx5hxIb6h
fLZT1KoBJSgIktVapXVUHbka1ARa2/0ktvTv6INkSF89p25cAkesEIMa1Q1q73ky
FoavMYFjbEKgXLRMy9Kr+D8s7fYE1P1fobdqz+LOSQKBgQD105ibO1RGfjjd8jYj
SjxU5P29szD9YJBlE3b8hB6+Rjn4VtDz33DtuQ6qJHv6hBQOTXWPxhG7cSVs5Wu0
kQjKSDV0GAfAd4RoLWphBExXqhllag0jYJF6BBYVOOyeWecvF57z44UyVNWg4m1Z
1dDHm7d6Z/DrIE10ROcFyJEhzwKBgQDd5Dm8xanM95X+QY9PuT72OLdnb5rzJApP
i2AHhyur2U/m6x9ugLFVJNGiMLR5NeFJbyje5wJnP0jTI+7Pk0pQLZ6W6ayMt1wD
dampwkxWY++3LebM0CqCJ8dx7M2cQY4tufFW6++LIjCMjXBcgdpbM7Q8b0zuBl8N
bXpQt92IEwKBgHxf0EhJ3jvERPVWRLnaJ2g0a4T9En4/yw64qGzeU8elNFNHaXTZ
ygMcrCS9TNTU2mjaG+7gIbyaZHsSIEo9Txs5KYJRXiqszZr/z2DCkfWQpETBQWBy
zWfUhW+7W0xK5ELZSpzOsmdisKszpGvdWEKFsHEIAcaUk1uOOOyeK3/VAoGABeNH
cO3hypGLRlrg/aGRvSDWJQV+HBOJvoCZRLnee8nhZ+Q3SkxZ6EN42I/oSgsW9kbf
08JXevvf59JdRN7IqwX63lBHBtjatTDLFrkUI3q1YqvyIt8nMZrynOBGuG244xe7
Aq5yBcQbe69JGvtLGv5tOulNJke+//E2vKuUUkcCgYA7PG17Scu2+N94/o6bY1GA
cGIAvpDoI/4O/+Eq9OAQwGVgax7JvTT2dbmFeZHrsemd0priwn0sLP0aE54nq1x7
4Mv53B1l2UJNwJB/sjhBOyALnq5PPzuox8abmFBhJ79+PYpsksE0Rxs3MBsuYg2M
MVO4iP/qwP+7FslwWXMKPw==
-----END PRIVATE KEY-----
`;

const waitUntilGone = (id: number) =>
  Services.certificates.getCertificate({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete an uploaded certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("UploadedCert", {
            certificate: CERT_1,
            privateKey: KEY_1,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.type).toEqual("uploaded");
      expect(created.certificate).toContain("BEGIN CERTIFICATE");
      expect(created.fingerprint).toEqual(expect.any(String));
      expect(created.created).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.certificates.getCertificate({
        id: created.id,
      });
      expect(fetched.certificate.id).toEqual(created.id);
      expect(fetched.certificate.name).toEqual(created.name);
      expect(fetched.certificate.type).toEqual("uploaded");
      expect(fetched.certificate.fingerprint).toEqual(created.fingerprint);
      expect(fetched.certificate.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("UploadedCert", {
            name: `${created.name.slice(0, 55)}-renamed`,
            certificate: CERT_1,
            privateKey: KEY_1,
            labels: { env: "prod", role: "edge" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.fingerprint).toEqual(created.fingerprint);
      expect(updated.name).toEqual(`${created.name.slice(0, 55)}-renamed`);
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });

      const refetched = yield* Services.certificates.getCertificate({
        id: updated.id,
      });
      expect(refetched.certificate.name).toEqual(updated.name);
      expect(refetched.certificate.labels.env).toEqual("prod");
      expect(refetched.certificate.labels.role).toEqual("edge");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when the uploaded PEM changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("ReplaceCert", {
            certificate: CERT_1,
            privateKey: KEY_1,
          });
        }),
      );

      expect(created.type).toEqual("uploaded");
      expect(created.fingerprint).toEqual(expect.any(String));

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("ReplaceCert", {
            name: created.name,
            certificate: CERT_2,
            privateKey: KEY_2,
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.fingerprint).not.toEqual(created.fingerprint);
      expect(replaced.name).toEqual(created.name);

      const fetched = yield* Services.certificates.getCertificate({
        id: replaced.id,
      });
      expect(fetched.certificate.id).toEqual(replaced.id);
      expect(fetched.certificate.fingerprint).toEqual(replaced.fingerprint);

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("ListCert", {
            certificate: CERT_1,
            privateKey: KEY_1,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Certificate);
      const all = yield* provider.list();
      const found = all.find((cert) => cert.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.type).toEqual("uploaded");
      expect(found?.fingerprint).toEqual(deployed.fingerprint);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const MANAGED_PROBE_NAME = "alchemy-test-managed-probe";
const MANAGED_PROBE_DOMAIN = "alchemy-unmanaged-probe.example.com";

test.provider.skipIf(!hasHetznerCreds || managedEnabled)(
  "managed issuance is rejected when the domain is not in Hetzner DNS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const existing = yield* Services.certificates.listCertificates({
        name: MANAGED_PROBE_NAME,
        per_page: 50,
      });
      yield* Effect.forEach(existing.certificates, (cert) =>
        Services.certificates
          .deleteCertificate({ id: cert.id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      );

      const result = yield* Effect.result(
        Services.certificates.createCertificate({
          name: MANAGED_PROBE_NAME,
          type: "managed",
          domain_names: [MANAGED_PROBE_DOMAIN],
        }),
      );

      if (Result.isFailure(result)) {
        // Hetzner rejects managed issuance for domains it does not host
        // with 422 `dns_zone_not_found` (typed UnprocessableEntity).
        expect(result.failure._tag).toEqual("UnprocessableEntity");
      } else {
        const { certificate, action } = result.success;
        const outcome = action
          ? yield* Effect.result(waitForAction(action))
          : undefined;
        yield* Services.certificates
          .deleteCertificate({ id: certificate.id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        if (outcome !== undefined && Result.isFailure(outcome)) {
          // Issuance for a domain Hetzner does not host either fails the
          // Action or is still pending when the bounded poll expires.
          expect(["ActionFailed", "ActionTimeout"]).toContain(
            outcome.failure._tag,
          );
        } else {
          expect(certificate.status?.issuance).not.toEqual("completed");
        }
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds || !managedEnabled || !managedDomain)(
  "create, update, and delete a managed certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("ManagedCert", {
            type: "managed",
            domainNames: [managedDomain!],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.type).toEqual("managed");
      expect(created.domainNames).toContain(managedDomain);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.certificates.getCertificate({
        id: created.id,
      });
      expect(fetched.certificate.id).toEqual(created.id);
      expect(fetched.certificate.type).toEqual("managed");
      expect(fetched.certificate.domain_names).toContain(managedDomain);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Certificate("ManagedCert", {
            type: "managed",
            name: `${created.name.slice(0, 55)}-renamed`,
            domainNames: [managedDomain!],
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual(`${created.name.slice(0, 55)}-renamed`);
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
