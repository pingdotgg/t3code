import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createBoatApiClient } from "./client.ts";

const sandbox = {
  id: "bx_23456789",
  name: "dev",
  state: "idle",
  type: "default",
  createdAt: "2026-11-05T00:00:00Z",
  archiveAfter: "2026-11-05T01:00:00Z",
};
const details = { ok: true, sandbox };
function setup(
  responses: readonly {
    readonly body: unknown;
    readonly status?: number;
    readonly headers?: Record<string, string>;
  }[],
) {
  const requests: {
    method: string;
    path: string;
    body: unknown;
    authorization: string | undefined;
    headers: Readonly<Record<string, string | undefined>>;
  }[] = [];
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      path: request.url,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null,
      authorization: request.headers.authorization,
      headers: request.headers,
    });
    const response = responses[requests.length - 1];
    if (!response) return Effect.die(new Error("Unexpected extra HTTP request."));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        response.status === 204
          ? new Response(null, { status: 204 })
          : Response.json(response.body, {
              status: response.status ?? 200,
              ...(response.headers ? { headers: response.headers } : {}),
            }),
      ),
    );
  });
  return { client: createBoatApiClient({ apiKey: "boat_test", httpClient }), requests };
}

describe("BoatApiClient", () => {
  it.effect("paginates documented sandbox envelopes and translates provider states", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: { ok: true, sandboxes: [sandbox], nextCursor: "next" } },
        { body: { ok: true, sandboxes: [{ ...sandbox, id: "bx_abcdef23", state: "archived" }] } },
      ]);
      const result = yield* client.listSandboxes();
      expect(result.map((entry) => entry.state)).toEqual(["ready", "stopped"]);
      expect(result[0]?.hourlyRateUsd).toBeNull();
      expect(new URL(requests[1]!.path).searchParams.get("cursor")).toBe("next");
      expect(requests.every((request) => request.authorization === "Bearer boat_test")).toBe(true);
    }),
  );
  it.effect("rejects malformed list responses rather than verifying credentials", () =>
    Effect.gen(function* () {
      for (const body of [
        { unexpected: true },
        { ok: false, sandboxes: [] },
        { ok: true, sandboxes: [{}] },
      ]) {
        const { client } = setup([{ body }]);
        const result = yield* client.listSandboxes().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );
  it.effect("preserves authentication, permission and rate-limit failures", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 429, 503]) {
        const { client } = setup([{ body: { ok: false }, status }]);
        const result = yield* client.listSandboxes().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.status).toBe(status);
      }
    }),
  );
  it.effect("reports the Retry-After wait on a rate-limited request", () =>
    Effect.gen(function* () {
      for (const body of [{ ok: false, window: "minute" }, { ok: false }]) {
        const { client } = setup([{ body, status: 429, headers: { "retry-after": "12" } }]);
        const result = yield* client.listSandboxes().pipe(Effect.flip);
        expect(result.rateLimit).toMatchObject({ scope: "paced", waitMs: 12_000 });
      }
    }),
  );
  it.effect("creates with provider sizing and TTL, then applies the display name", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: details, status: 202 },
        { body: { ...details, sandbox: { ...sandbox, name: "custom" } } },
      ]);
      const result = yield* client.createSandbox({
        name: "custom",
        size: "large",
        autoStopMinutes: 30,
        template: "snapshot",
      });
      expect(requests.map((request) => [request.method, request.body])).toEqual([
        ["POST", { type: "large", ttlSeconds: 1800, from: "snapshot" }],
        ["PATCH", { name: "custom" }],
      ]);
      expect(result.name).toBe("custom");
    }),
  );
  it.effect("stops a newly allocated sandbox when display-name setup fails", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: details, status: 202 },
        { body: {}, status: 500 },
        { body: { ok: true } },
      ]);
      const result = yield* client
        .createSandbox({ name: "dev", requestId: "create-attempt" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.sandboxId).toBe(sandbox.id);
      expect(requests[2]?.path).toContain(`${sandbox.id}/stop`);
    }),
  );

  it.effect("resumes and stops through action endpoints, then reads canonical state", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: { ok: true } },
        { body: details },
        { body: { ok: true } },
        { body: { ...details, sandbox: { ...sandbox, state: "archived" } } },
      ]);
      yield* client.resumeSandbox(sandbox.id, "large");
      expect((yield* client.stopSandbox(sandbox.id)).state).toBe("stopped");
      expect(requests[0]?.body).toEqual({ type: "large" });
      expect(requests[0]?.path).toContain("/resume");
      expect(requests[2]?.path).toContain("/stop");
    }),
  );
  it.effect("forks using the new sandbox ID rather than the parent", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: { ok: true, id: "bx_abcdef23" }, status: 202 },
        { body: { ...details, sandbox: { ...sandbox, id: "bx_abcdef23" } } },
      ]);
      expect(
        (yield* client.forkSandbox(sandbox.id, {
          size: "small",
          autoStopMinutes: 15,
          requestId: "fork-attempt",
        })).sandboxId,
      ).toBe("bx_abcdef23");
      expect(requests[0]?.body).toEqual({ type: "small", ttlSeconds: 900 });
      expect(requests[0]?.headers["idempotency-key"]).toBe("fork-attempt");
      expect(requests[1]?.path).toContain("bx_abcdef23");
    }),
  );
  it.effect("injects a public key through sshkey and retains the pinned host identity", () =>
    Effect.gen(function* () {
      const ssh = {
        machineIp: null,
        sshEndpoint: "host.boat.dev:2222",
        sshUser: "user",
        hostKey: "ssh-ed25519 AAAA",
      };
      const { client, requests } = setup([{ body: { ok: true, ...ssh } }]);
      expect(yield* client.addSshKey(sandbox.id, "ssh-ed25519 PUBLIC")).toEqual(ssh);
      expect(requests[0]?.path).toContain("/sshkey");
      expect(requests[0]?.body).toEqual({ key: "ssh-ed25519 PUBLIC" });
    }),
  );
  it.effect("extends using explicit hours and keeps hosted ports private", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: details },
        { body: details },
        { body: { port: 5173, url: "https://dev.on.boat.dev?_token=secret", isProtected: true } },
      ]);
      yield* client.extendAutoStop(sandbox.id, 13);
      yield* client.extendAutoStop(sandbox.id, 0.2501);
      const hosted = yield* client.exposePort(sandbox.id, 5173);
      expect(requests[0]?.body).toEqual({ ttlSeconds: 46800 });
      expect(requests[1]?.body).toEqual({ ttlSeconds: 900 });
      expect(requests[2]?.body).toEqual({ port: 5173, public: false, localhost: true });
      expect(hosted.isProtected).toBe(true);
    }),
  );
  it.effect("requests the separate browser surface instead of relabeling a desktop stream", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: { ok: true, browserUrl: "https://browser.boat.dev/stream?token=secret" } },
      ]);
      const result = yield* client.getDesktopUrl(sandbox.id, { viewMode: "browser" });
      expect(result.viewMode).toBe("browser");
      expect(requests[0]?.path).toContain("/browser");
      expect(result.desktopUrl).toContain("browser.boat.dev");
    }),
  );

  it.effect("opens a desktop URL and awaits confirmed asynchronous deletion", () =>
    Effect.gen(function* () {
      const { client, requests } = setup([
        { body: { ok: true, desktopUrl: "https://desktop.boat.dev/stream?token=secret" } },
        {
          body: {
            ok: true,
            operation: { id: "bdop_123", kind: "sandbox", targetId: sandbox.id, status: "pending" },
          },
          status: 202,
        },
        {
          body: {
            ok: true,
            operation: {
              id: "bdop_123",
              kind: "sandbox",
              targetId: sandbox.id,
              status: "completed",
            },
          },
        },
      ]);
      expect((yield* client.getDesktopUrl(sandbox.id, { theme: "dark" })).desktopUrl).toContain(
        "desktop.boat.dev",
      );
      yield* client.deleteSandbox(sandbox.id);
      expect(requests[1]?.method).toBe("DELETE");
      expect(requests[1]?.headers["x-ascii-confirm-delete"]).toBe(sandbox.id);
      expect(requests[2]?.path).toContain("/deletion-operations/bdop_123");
      const blocked = setup([
        {
          body: {
            ok: true,
            operation: {
              id: "bdop_blocked",
              kind: "sandbox",
              targetId: sandbox.id,
              status: "blocked",
            },
          },
        },
        {
          body: {
            ok: true,
            operation: {
              id: "bdop_blocked",
              kind: "sandbox",
              targetId: sandbox.id,
              status: "blocked",
            },
          },
        },
      ]);
      const result = yield* blocked.client.deleteSandbox(sandbox.id).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.status).toBe(409);
    }),
  );
  it.effect("retains fresh snapshot identity and refuses a different saved artifact", () =>
    Effect.gen(function* () {
      const snapshot = { name: "fresh-work", status: "saving", sourceSandboxId: sandbox.id };
      const { client, requests } = setup([
        { body: { ok: true, snapshot }, status: 202 },
        { body: { ok: true, snapshot: { ...snapshot, status: "ready" } } },
        { body: { ok: true }, status: 204 },
      ]);
      expect(
        (yield* client.captureSnapshot({ sandboxId: sandbox.id, name: snapshot.name })).status,
      ).toBe("saving");
      expect(requests[0]?.body).toEqual({ sandboxId: sandbox.id, name: snapshot.name });
      expect((yield* client.getSnapshot(snapshot.name)).status).toBe("ready");
      yield* client.deleteSnapshot(snapshot.name);
      expect(requests[2]?.method).toBe("DELETE");
      for (const operation of ["capture", "get"] as const) {
        const wrong = setup([{ body: { ok: true, snapshot: { ...snapshot, name: "other" } } }]);
        const result = yield* (
          operation === "capture"
            ? wrong.client.captureSnapshot({ sandboxId: sandbox.id, name: snapshot.name })
            : wrong.client.getSnapshot(snapshot.name)
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );
  it.effect("bounds recording downloads even when the server omits a content length", () =>
    Effect.gen(function* () {
      let empty = false;
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  if (!empty) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.enqueue(new Uint8Array([4, 5, 6]));
                  }
                  controller.close();
                },
              }),
            ),
          ),
        ),
      );
      const client = createBoatApiClient({ apiKey: "boat_test", httpClient, maxArtifactBytes: 4 });
      const result = yield* client.getArtifact(sandbox.id, "demo.mp4").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      empty = true;
      expect((yield* client.getArtifact(sandbox.id, "demo.mp4").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  );
});
