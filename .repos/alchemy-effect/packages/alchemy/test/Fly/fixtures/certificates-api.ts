import * as Fly from "@/Fly";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const CERT_API_PORT = 3000;

export const CertSite = Fly.App("CertSite", { enableSubdomains: true });

export const CertIp = Fly.IpAssignment("CertShared", {
  app: CertSite,
  type: "shared_v4",
});

/**
 * HTTP Service exercising {@link Fly.WriteCertificates}: one route per
 * operation, the hostname from the query string, PEMs in the JSON body.
 */
export default class CertificatesApi extends Fly.Service<CertificatesApi>()(
  "CertificatesApi",
  {
    app: CertSite,
    main: import.meta.url,
    region: "iad",
    port: CERT_API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const certs = yield* Fly.WriteCertificates(CertSite);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        const hostname = url.searchParams.get("hostname") ?? "";

        // `suspend` turns a synchronous throw inside the client call into a
        // defect the cause handler below can report.
        const respond = <A, E, R>(make: () => Effect.Effect<A, E, R>) =>
          Effect.suspend(make).pipe(
            Effect.flatMap((value) =>
              HttpServerResponse.json({ ok: true, value: value ?? null }),
            ),
            Effect.catchCause((cause) =>
              HttpServerResponse.json(
                { ok: false, error: Cause.pretty(cause) },
                { status: 500 },
              ),
            ),
          );

        switch (url.pathname) {
          case "/health":
            return yield* HttpServerResponse.json({ ok: true, version: 2 });
          case "/request":
            return yield* respond(() => certs.request(hostname));
          case "/upload": {
            const body = (yield* request.json) as {
              hostname: string;
              fullchain: string;
              privateKey: string;
            };
            return yield* respond(() =>
              certs.upload({
                hostname: body.hostname,
                fullchain: body.fullchain,
                privateKey: Redacted.make(body.privateKey),
              }),
            );
          }
          case "/check":
            return yield* respond(() => certs.check(hostname));
          case "/get":
            return yield* respond(() => certs.get(hostname));
          case "/remove":
            return yield* respond(() => certs.remove(hostname));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Fly.WriteCertificatesHttp)),
) {}
