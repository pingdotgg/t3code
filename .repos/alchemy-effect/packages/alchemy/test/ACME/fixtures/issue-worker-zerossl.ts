import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ZeroSSLAccount, Zone } from "./shared.ts";

/**
 * The deployed-Worker variant of `issue-worker.ts`: same routes, but the
 * bound account is ZeroSSL — Let's Encrypt answers 525 to Workers egress.
 */
export default class AcmeIssueZeroSslWorker extends Cloudflare.Worker<AcmeIssueZeroSslWorker>()(
  "AcmeIssueZeroSslWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const acme = yield* ACME.IssueCertificate(ZeroSSLAccount);
    const dns = yield* Cloudflare.DNS.WriteDns(Zone);
    const solver = Cloudflare.DNS.acmeDnsSolver(dns);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (url.pathname !== "/issue") {
          return yield* HttpServerResponse.json({ ok: true, version: 2 });
        }
        const name = url.searchParams.get("name") ?? "";
        return yield* Effect.gen(function* () {
          const issued = yield* acme.issue({ identifiers: [name], solver });
          const parsed = yield* ACME.parseCertificate(issued.certificate);
          yield* acme.revoke({
            certificate: issued.certificate,
            privateKey: issued.privateKey,
          });
          return yield* HttpServerResponse.json({
            issuer: issued.issuer,
            notAfter: issued.notAfter,
            serial: issued.serial,
            dnsNames: parsed.dnsNames,
            hasKey: Redacted.value(issued.privateKey).includes(
              "BEGIN PRIVATE KEY",
            ),
            chainLength: ACME.splitPemChain(issued.chain).length,
          });
        }).pipe(
          // Failures and defects alike come back as JSON so the test can
          // show what went wrong inside the Worker.
          Effect.catchCause((cause) =>
            HttpServerResponse.json(
              { error: Cause.pretty(cause) },
              { status: 500 },
            ),
          ),
        );
      }),
    };
  }).pipe(
    Effect.provide(ACME.IssueCertificateHttp),
    Effect.provide(Cloudflare.DNS.WriteDnsHttp),
  ),
) {}
