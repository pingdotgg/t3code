import { describe, expect, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("resolveOpenCodeServerPassword", () => {
  it("uses the settings password when local settings and environment differ", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});
