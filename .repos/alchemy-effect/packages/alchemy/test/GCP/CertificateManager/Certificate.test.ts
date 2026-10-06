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

const KEY_B = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDvsggeFArH0g66
o32VTCeio8b4t5p/FMT1wppCw7bUWCOWxK8eVmoZ212iN68Ni5xZiBbC06mPkUBK
kwZbkqDY9xmTx2CldPpvJgiJwMDyMlXH3ewUHGfYGFi+8J9ZFuo9KjdKgXcMJLoB
CJlfzOW74KzrdN+jY4JsKqU/KWbYMaE1+zUojbaUutTdrLTMeN5S2Irj4JBWKPwd
757jyYczDBa1Zco/96KRCWdXhzo5gDqsstcG8rLeDXNq8EARjkYsQI//G3VuPaqB
NSB7wvhevjmkGPeXoq7W2EN59L2Zdwe3jnpV4SRaKvQ7tycE33TcFvOE1Xu9MdV9
LkjxlOCNAgMBAAECggEALtTNYjcPPihL6WpM/JEDA3NVSj3xKRghPVUWt6mufIF1
/pySDG7czw19l1ai1JYs548/xzP8oojCE2/zY4vb8lgg/q8LMniO/41iSKvI5ukv
uluhJvK/1Ug4eqHfuFPSUz3+zIdL/6rjTpVkBgQt9I26q0xL74vfLQwN+i+4IM/8
v9C8SMtjxcDkrJWzuSpL4aeL8ld1d4Mja5o4GcL8LLx3zVBuJELD/36v+jWVu5kF
6G4KFlTIiK8xdPlvLpk/g0j1rrr+4h5XHlgns/W1VYrWhw5XMsMmHOPEcb+M+pKa
1h0lQHMdaq8SL/WSa00Tg2YeLBUb37F4NsEcU6iDAQKBgQD33kKNRpG9qe4RdRkb
PkpedauSG+YEi74CRdkbPm9/JIx2Lk5+sp7/DvJkqok5Fzg12bBTM86xDg193RWk
RHgCTQcKUhuwGzlEtXwOYKa++UiE6hQmopU7Ge6C8GbB/vIcfBUWYDF67ayycNOS
f6CTqKqV9Rqrt9pGnVv3PjocgQKBgQD3jyHTqrCyjI9GwLVDB0nmHnbS5Y9oVW/Y
eJQn8EN9nGLENaKOmtA4s1Qwgv7nv8pz76abXnv4Bs5YBCJwshPvB/iOP7vkc3im
61D8gt2UkbsUhmtqQuNjrszqYd5hSQ5h4uAtUSgctRFjSkdtb9AxO7UwPk2Ae5f1
EurHZ2JuDQKBgQCnLzbca3jp4LA+/iiNA5rN07iBuGeRMWBb0Bj8E0TJETHclKdF
Nd2gU8iStaQQ6eR0DfysYglLyxq2hmSOg9AeXS4ee/tI8VPTUEX4vKA7t5B+dhRZ
atgVIQyLLPNibj+Hjvn6Oa+mJqGRSiCqc4MvlVhaBRSUNlH3xzO8tDAmAQKBgQCI
9uzNMfvO3UuL5qSisA6nvaUaK537KIHX72Zw7lI41eQjEFWetnKLXFQw/tjPGWKG
YEn6Xf0SjZluQuNXHH9A2VUgRozK6UQQfdLx0emMAFDUG0akpNsv1I9VAc7KXmQR
rjc/e05JC7jSCU+ZcaprAtDNHzs74aWCFvREXKOtpQKBgQCrVxSthxuWGy96GpXV
yrNQTQ25BaINmZFdvwF6r5Go5jMwBKV5x4oq8zioH7CXH8yAHIGOAYW5zjQ4Oebb
uCSz3dimQ+PlEDhAWYsnJbwpJvWfKLk4WaePLqkKzQ5nNGnPXqltwMDaPZzgDVsm
6oSOe7OlpzcSQhEUgsBvtSzTwg==
-----END PRIVATE KEY-----`;

const waitUntilGone = (name: string) =>
  certificatemanager.getProjectsLocationsCertificates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.Certificate("FrontendTls", {
            location: "global",
            description: "frontend tls a",
            labels: { env: "test" },
            pemCertificate: CERT_A,
            pemPrivateKey: KEY_A,
          });
        }),
      );

      expect(created.name).toContain("/certificates/");
      expect(created.certificateId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("SELF_MANAGED");
      expect(created.scope).toEqual("DEFAULT");
      expect(created.description).toEqual("frontend tls a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.pemCertificate).toEqual(expect.any(String));
      expect(created.sanDnsnames).toContain("alchemy-ssl-a.test");
      expect(created.expireTime).toEqual(expect.any(String));

      const fetched =
        yield* certificatemanager.getProjectsLocationsCertificates({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("frontend tls a");
      expect(fetched.pemCertificate).toContain("BEGIN CERTIFICATE");
      expect(fetched.sanDnsnames).toContain("alchemy-ssl-a.test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.Certificate("FrontendTls", {
            certificateId: created.certificateId,
            location: "global",
            description: "frontend tls b",
            labels: { env: "prod", role: "tls" },
            pemCertificate: CERT_A,
            pemPrivateKey: KEY_A,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("frontend tls b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tls" });
      expect(updated.sanDnsnames).toContain("alchemy-ssl-a.test");

      const refetched =
        yield* certificatemanager.getProjectsLocationsCertificates({
          name: created.name,
        });
      expect(refetched.description).toEqual("frontend tls b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");
      expect(refetched.sanDnsnames).toContain("alchemy-ssl-a.test");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.Certificate("FrontendTls", {
            certificateId: created.certificateId,
            location: "global",
            description: "frontend tls c",
            labels: { env: "prod", role: "tls" },
            pemCertificate: CERT_B,
            pemPrivateKey: KEY_B,
          });
        }),
      );

      expect(replaced.certificateId).toEqual(created.certificateId);
      expect(replaced.description).toEqual("frontend tls c");
      expect(replaced.sanDnsnames).toContain("alchemy-ssl-b.test");
      expect(replaced.sanDnsnames).not.toContain("alchemy-ssl-a.test");

      const replacedFetched =
        yield* certificatemanager.getProjectsLocationsCertificates({
          name: created.name,
        });
      expect(replacedFetched.sanDnsnames).toContain("alchemy-ssl-b.test");
      expect(replacedFetched.description).toEqual("frontend tls c");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 90_000,
  },
);
