import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetServerAuthBootstrapForTests } from "../../environments/primary";
import { PairingRouteSurface } from "./PairingRouteSurface";

describe("PairingRouteSurface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, document.title, "/");
    __resetServerAuthBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("auto-pairs from /pair and removes the one-time credential from browser history", async () => {
    window.history.replaceState({}, document.title, "/pair#token=browser-pairing-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-08-02T00:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const onAuthenticated = vi.fn();

    await render(
      <PairingRouteSurface
        auth={{
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    await expect
      .element(page.getByRole("heading", { name: "Pair with this environment" }))
      .toBeVisible();
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/bootstrap`,
      expect.objectContaining({
        body: JSON.stringify({ credential: "browser-pairing-secret" }),
        credentials: "include",
        method: "POST",
      }),
    );
    expect(window.location.pathname).toBe("/pair");
    expect(window.location.hash).toBe("");
  });
});
