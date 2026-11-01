import * as ACME from "@/ACME";
import * as Fly from "@/Fly";
import { FlyAuth } from "@/Fly/AuthProvider";
import { fromAuthProvider } from "@/Fly/Credentials";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Layer from "effect/Layer";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import CertificatesApi, {
  CertIp,
  CertSite,
} from "./fixtures/certificates-api.ts";

/**
 * Runtime certificate management on a Fly App: `request` a Fly-managed
 * certificate, upload a Let's Encrypt staging certificate, check, get, and remove.
 */
const providers = Layer.mergeAll(
  Fly.providers(),
  Cloudflare.providers(),
  ACME.providers(),
);
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });
const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const UPLOAD_HOST = `alchemy-wc-upload.${zoneName}`;
const REQUEST_HOST = `alchemy-wc-request.${zoneName}`;

const Stack = Alchemy.Stack(
  "FlyWriteCertificatesFixture",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* CertSite;
    yield* CertIp;
    const api = yield* CertificatesApi;
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: zoneName }).pipe(
      Effect.orDie,
    );
    if (!zone)
      return yield* Effect.die(new Error(`zone ${zoneName} not found`));
    const account = yield* ACME.Account("Issuer", {
      ca: ACME.LetsEncryptStaging,
      termsOfServiceAgreed: true,
    });
    const certificate = yield* ACME.Certificate("Upload", {
      account,
      identifiers: [UPLOAD_HOST],
      solver: Cloudflare.DNS.AcmeSolver({ zoneId: zone.id }),
      revokeOnDelete: true,
    });
    return {
      appName: site.appName,
      url: api.url,
      chain: certificate.chain,
      privateKey: certificate.privateKey,
    };
  }),
);

// This hook builds/pushes the runtime image and issues a real certificate.
// The test body's timeout does not cover setup; reserve time for both here.
const stack = beforeAll(deploy(Stack), { timeout: 180_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface Reply {
  ok: boolean;
  value?: any;
  error?: string;
}

test(
  "uploads, inspects and removes a custom certificate, and requests a Fly-managed one",
  Effect.gen(function* () {
    const { url, appName, chain, privateKey } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const call = (path: string, body?: unknown) =>
      Effect.gen(function* () {
        const request =
          body === undefined
            ? HttpClientRequest.get(`${url}${path}`)
            : HttpClientRequest.post(`${url}${path}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body),
              );
        const response = yield* client.execute(request);
        const text = yield* response.text;
        return JSON.parse(text || "null") as Reply;
      });

    const health = yield* call("/health").pipe(
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 8,
      }),
    );
    expect(health.ok).toBe(true);

    const uploaded = yield* call("/upload", {
      hostname: UPLOAD_HOST,
      fullchain: chain,
      privateKey: Redacted.value(privateKey),
    });
    expect(uploaded.error).toBeUndefined();
    expect(uploaded.ok).toBe(true);
    expect(uploaded.value?.hostname).toBe(UPLOAD_HOST);
    const observed = yield* machines
      .getAppCertificate({
        app_name: appName,
        hostname: UPLOAD_HOST,
      })
      .pipe(Effect.provide(fromAuthProvider().pipe(Layer.provide(FlyAuth))));
    expect(observed.hostname).toBe(UPLOAD_HOST);

    const fetched = yield* call(`/get?hostname=${UPLOAD_HOST}`);
    expect(fetched.ok).toBe(true);
    expect(fetched.value?.hostname).toBe(UPLOAD_HOST);
    expect(
      (fetched.value?.certificates ?? []).some(
        (c: { source?: string }) => c.source === "custom",
      ),
    ).toBe(true);

    // Re-upload replaces in place (conflict → delete + create).
    const reuploaded = yield* call("/upload", {
      hostname: UPLOAD_HOST,
      fullchain: chain,
      privateKey: Redacted.value(privateKey),
    });
    expect(reuploaded.ok).toBe(true);

    const checked = yield* call(`/check?hostname=${UPLOAD_HOST}`);
    expect(checked.ok).toBe(true);
    expect(checked.value?.hostname).toBe(UPLOAD_HOST);

    const requested = yield* call(`/request?hostname=${REQUEST_HOST}`);
    expect(requested.ok).toBe(true);
    const requestedDetail = yield* call(`/get?hostname=${REQUEST_HOST}`);
    expect(requestedDetail.value?.acme_requested).toBe(true);
    expect(requestedDetail.value?.dns_requirements).toBeDefined();

    const removed = yield* call(`/remove?hostname=${UPLOAD_HOST}`);
    expect(removed.ok).toBe(true);
    yield* call(`/remove?hostname=${REQUEST_HOST}`);
    const gone = yield* call(`/get?hostname=${UPLOAD_HOST}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (reply) => reply.value === null,
        times: 10,
      }),
    );
    expect(gone.value).toBeNull();
    // Removing again is a no-op.
    expect((yield* call(`/remove?hostname=${UPLOAD_HOST}`)).ok).toBe(true);
  }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:acme:certificate",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:zone",
      "provider:fly",
      "provider:fly:app",
      "provider:fly:certificate",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 240_000,
  },
);
