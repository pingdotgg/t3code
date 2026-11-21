import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  PrinterOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PrinterMediaProxy from "./PrinterMediaProxy.ts";
import * as PrinterService from "./PrinterService.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const sampleJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function createMediaProxyFixture(options: {
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly authError?: EnvironmentAuth.ServerAuthCredentialError;
  readonly stale?: boolean;
  readonly unavailable?: boolean;
}) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    PrinterMediaProxy.layer.pipe(
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            options.authError
              ? Effect.fail(options.authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test-user",
                  method: "bearer-access-token",
                  scopes: options.scopes ?? [AuthOrchestrationReadScope],
                }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(PrinterService.PrinterService)({
          fetchMedia: (printerId, kind) =>
            options.unavailable
              ? Effect.fail(
                  new PrinterOperationError({
                    operation: `media.${kind}`,
                    printerId,
                    reason: "Printer offline",
                  }),
                )
              : Effect.succeed({
                  bytes: sampleJpeg,
                  contentType: "image/jpeg",
                  capturedAt: "2026-11-21T01:00:00.000Z",
                  stale: options.stale ?? false,
                  online: !(options.stale ?? false),
                  hash: "deadbeef",
                }),
        }),
      ),
    ),
  );
  disposers.push(dispose);
  return handler;
}

describe("PrinterMediaProxy", () => {
  it("serves authenticated camera frames with no-store caching and freshness headers", async () => {
    const handler = createMediaProxyFixture({ stale: false });
    const response = await handler(
      new Request("http://localhost/api/printer-media/p1s-studio/camera"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-printer-captured-at")).toBe("2026-11-21T01:00:00.000Z");
    expect(response.headers.get("x-printer-frame-stale")).toBe("false");
    expect(response.headers.get("x-printer-online")).toBe("true");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(sampleJpeg);
  });

  it("marks stale camera frames explicitly in response headers", async () => {
    const handler = createMediaProxyFixture({ stale: true });
    const response = await handler(
      new Request("http://localhost/api/printer-media/p1s-studio/camera"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-printer-frame-stale")).toBe("true");
    expect(response.headers.get("x-printer-online")).toBe("false");
  });

  it("rejects unauthorized and insufficient-scope requests", async () => {
    const unauthorizedHandler = createMediaProxyFixture({
      authError: new EnvironmentAuth.ServerAuthInvalidCredentialError({
        diagnostic: "Invalid credential",
      }),
    });
    const unauthorized = await unauthorizedHandler(
      new Request("http://localhost/api/printer-media/p1s-studio/camera"),
    );
    expect(unauthorized.status).toBe(401);

    const missingScopeHandler = createMediaProxyFixture({ scopes: [] });
    const forbidden = await missingScopeHandler(
      new Request("http://localhost/api/printer-media/p1s-studio/camera"),
    );
    expect(forbidden.status).toBe(403);
  });

  it("rejects arbitrary or traversal media paths with 404 and returns 503 when upstream is unavailable", async () => {
    const handler = createMediaProxyFixture({ unavailable: true });
    const badAsset = await handler(
      new Request("http://localhost/api/printer-media/p1s-studio/gcode"),
    );
    expect(badAsset.status).toBe(404);

    const traversal = await handler(
      new Request("http://localhost/api/printer-media/p1s-studio/camera/extra"),
    );
    expect(traversal.status).toBe(404);

    const unavailable = await handler(
      new Request("http://localhost/api/printer-media/p1s-studio/cover"),
    );
    expect(unavailable.status).toBe(503);
  });
});
