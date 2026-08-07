import { describe, expect, it, vi } from "vite-plus/test";

import {
  maskedRenderServiceUrl,
  normalizeRenderServiceUrl,
  RenderBootstrapRequestError,
  requestRenderPairing,
} from "./renderBootstrap";

describe("normalizeRenderServiceUrl", () => {
  it("accepts a bare Render hostname and keeps only its origin", () => {
    expect(normalizeRenderServiceUrl("demo.onrender.com/path")).toBe("https://demo.onrender.com");
  });

  it("rejects Render dashboard URLs", () => {
    expect(() => normalizeRenderServiceUrl("https://dashboard.render.com/web/srv-123")).toThrow(
      "not the Render dashboard URL",
    );
  });

  it("masks long service hostnames", () => {
    expect(maskedRenderServiceUrl("https://t3code-cloud-demo-eg5i.onrender.com")).toBe(
      "t3code-cloud-…i.onrender.com",
    );
  });
});

describe("requestRenderPairing", () => {
  it("claims a one-time pairing credential from the service URL", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ pairingCode: "pairing-code", label: "Render cloud environment" }),
    );

    await expect(
      requestRenderPairing({
        serviceUrl: "demo.onrender.com",
        fetcher,
      }),
    ).resolves.toEqual({
      host: "https://demo.onrender.com",
      pairingCode: "pairing-code",
      label: "Render cloud environment",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
      "https://demo.onrender.com/.well-known/t3/render/pair",
    );
  });

  it("explains when the service is still running an older deployment", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ message: "missing" }, { status: 404 }),
    );

    const failure = await requestRenderPairing({
      serviceUrl: "https://demo.onrender.com",
      fetcher,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RenderBootstrapRequestError);
    expect((failure as Error).message).toContain("Deploy the latest version");
  });
});
