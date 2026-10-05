import * as ACME from "@/ACME";
import { describe, expect } from "alchemy-test";
import * as Test from "@/Test/Alchemy";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ROOT_CERTIFICATE } from "./fixtures/root-certificate.ts";

const { test } = Test.make({ providers: ACME.providers() });

/** `openssl req -text -verify` over a DER request. */
const inspectCsr = (der: Uint8Array) =>
  Effect.gen(function* () {
    const process = yield* ChildProcess.make(
      "openssl",
      ["req", "-inform", "DER", "-noout", "-text", "-verify"],
      {
        stdin: Stream.make(der),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        process.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        process.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(code).toBe(0);
    return [...stdout, ...stderr].join("");
  });

describe("ACME PKI", { tags: ["provider:acme", "local"] }, () => {
  for (const algorithm of ["ES256", "RS256"] as const) {
    test(
      `${algorithm} CSR verifies and carries every identifier as a SAN`,
      Effect.gen(function* () {
        const key = yield* ACME.generateKey(algorithm);
        expect(Redacted.value(key.privateKeyPem)).toContain(
          "BEGIN PRIVATE KEY",
        );
        const csr = yield* ACME.createCsr({
          key,
          identifiers: ["*.example.test", "example.test"],
        });
        const text = yield* inspectCsr(csr);
        expect(text).toMatch(/verify OK/i);
        expect(text).toContain("CN=*.example.test");
        expect(text).toContain("DNS:*.example.test");
        expect(text).toContain("DNS:example.test");
        expect(text).toContain(
          algorithm === "ES256"
            ? "ecdsa-with-SHA256"
            : "sha256WithRSAEncryption",
        );
      }),
    );
  }

  test(
    "parses a certificate's serial, validity, issuer and SANs",
    Effect.gen(function* () {
      const parsed = yield* ACME.parseCertificate(ROOT_CERTIFICATE);
      expect(parsed.issuer).toContain("CN=minica root ca");
      expect(parsed.subject).toBe(parsed.issuer);
      expect(parsed.serial).toMatch(/^[0-9a-f]+$/);
      expect(parsed.notBefore.getUTCFullYear()).toBe(2025);
      expect(parsed.notAfter.getUTCFullYear()).toBe(2125);
      expect(parsed.dnsNames).toEqual([]);
    }),
    { tags: ["unit"] },
  );

  test(
    "round-trips a PKCS#8 key through import and JWK export",
    Effect.gen(function* () {
      const key = yield* ACME.generateKey("ES256");
      const imported = yield* ACME.importPrivateKey(key.privateKeyPem);
      expect(imported.algorithm).toBe("ES256");
      const jwk = JSON.parse(
        Redacted.value(yield* ACME.privateKeyToJwk(key.privateKeyPem)),
      ) as { kty: string; crv: string; d?: string };
      expect(jwk.kty).toBe("EC");
      expect(jwk.crv).toBe("P-256");
      expect(jwk.d).toBeDefined();
    }),
    { tags: ["unit"] },
  );
});
