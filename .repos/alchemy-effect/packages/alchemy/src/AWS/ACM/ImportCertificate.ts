import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The full import request. `PrivateKey` is sensitive — pass it as
 * `Redacted.make(bytes)` so it never leaks into logs or traces. Pass
 * `CertificateArn` to re-import (rotate) an existing imported certificate;
 * omit it to import a new one.
 */
export interface ImportCertificateRequest
  extends acm.ImportCertificateRequest {}

/**
 * Runtime binding for `acm:ImportCertificate`.
 *
 * An account-level operation (no certificate argument) that imports an
 * externally issued certificate into ACM in `us-east-1` — the classic
 * rotation flow where a function obtains a renewed certificate from an
 * outside CA and re-imports it over the existing ACM entry by passing its
 * `CertificateArn`. Provide the implementation with
 * `Effect.provide(AWS.ACM.ImportCertificateHttp)`.
 * @binding
 * @section Importing Certificates
 * @example Rotate an Externally Issued Certificate
 * ```typescript
 * // init — account-level binding takes no resource
 * const importCertificate = yield* AWS.ACM.ImportCertificate();
 *
 * // runtime — re-import a renewed certificate over the existing ARN
 * const encoder = new TextEncoder();
 * const result = yield* importCertificate({
 *   CertificateArn: existingArn,
 *   Certificate: encoder.encode(certificatePem),
 *   PrivateKey: Redacted.make(encoder.encode(privateKeyPem)),
 *   CertificateChain: encoder.encode(chainPem),
 * });
 * ```
 */
export interface ImportCertificate extends Binding.Service<
  ImportCertificate,
  "AWS.ACM.ImportCertificate",
  () => Effect.Effect<
    (
      request: ImportCertificateRequest,
    ) => Effect.Effect<
      acm.ImportCertificateResponse,
      acm.ImportCertificateError
    >
  >
> {}

export const ImportCertificate = Binding.Service<ImportCertificate>(
  "AWS.ACM.ImportCertificate",
);
