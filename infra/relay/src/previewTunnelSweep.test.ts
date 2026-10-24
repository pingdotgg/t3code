import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { sweepPreviewStage } from "./previewTunnelSweep.ts";

const KEY = "0123456789abcdef";
const TUNNEL_NAME = `t3coderelay-managedendpoint-pr-42-${KEY}`;

// Answers the Cloudflare endpoints the sweep calls and records each request.
const fakeCloudflare = (options: {
  readonly tunnels: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly zoneExists: boolean;
  readonly deleteStatus?: number;
}) => {
  const seen: Array<string> = [];
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    const reply = (status: number, body: unknown) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    if (request.method === "DELETE") {
      return reply(options.deleteStatus ?? 200, { success: true });
    }
    if (url.pathname.endsWith("/cfd_tunnel")) return reply(200, { result: options.tunnels });
    if (url.pathname.endsWith("/zones")) {
      return reply(200, { result: options.zoneExists ? [{ id: "zone-1" }] : [] });
    }
    if (url.pathname.endsWith("/dns_records")) return reply(200, { result: [] });
    return reply(404, {});
  });
  return { client, seen };
};

const sweep = (cloudflare: ReturnType<typeof fakeCloudflare>) =>
  sweepPreviewStage({
    stage: "pr-42",
    tunnelZoneName: "tunnels.example.com",
    accountId: "account-1",
    token: Redacted.make("token"),
  }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, cloudflare.client)));

describe("sweepPreviewStage", () => {
  it.effect("does not need the zone once no tunnels remain", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ tunnels: [], zoneExists: false });
      yield* sweep(cloudflare);
      expect(cloudflare.seen.some((request) => request.includes("/zones"))).toBe(false);
    }),
  );

  it.effect("removes tunnels even when their zone is already gone", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({
        tunnels: [{ id: "tunnel-1", name: TUNNEL_NAME }],
        zoneExists: false,
      });
      yield* sweep(cloudflare);
      expect(cloudflare.seen).toContain(
        "DELETE /client/v4/accounts/account-1/cfd_tunnel/tunnel-1/connections",
      );
      expect(cloudflare.seen).toContain("DELETE /client/v4/accounts/account-1/cfd_tunnel/tunnel-1");
      expect(cloudflare.seen.some((request) => request.includes("/dns_records"))).toBe(false);
    }),
  );

  it.effect("treats an already-deleted tunnel as swept", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({
        tunnels: [{ id: "tunnel-1", name: TUNNEL_NAME }],
        zoneExists: false,
        deleteStatus: 404,
      });
      const exit = yield* Effect.exit(sweep(cloudflare));
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("fails when Cloudflare rate-limits a delete so the next run retries it", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({
        tunnels: [{ id: "tunnel-1", name: TUNNEL_NAME }],
        zoneExists: false,
        deleteStatus: 429,
      });
      const exit = yield* Effect.exit(sweep(cloudflare));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
