import { describe, expect, it } from "vite-plus/test";

import { sessionPermissionsUnavailableMessage } from "./authScopeOptions.ts";

describe("sessionPermissionsUnavailableMessage", () => {
  it("asks to connect when the environment is disconnected", () => {
    expect(
      sessionPermissionsUnavailableMessage({ connected: false, failed: true, rejected: true }),
    ).toContain("Connect to this environment");
  });

  it("reports rejection before failure since retrying will not help", () => {
    expect(
      sessionPermissionsUnavailableMessage({ connected: true, failed: true, rejected: true }),
    ).toContain("did not accept your session");
  });

  it("reports a retrying failure while connected", () => {
    expect(
      sessionPermissionsUnavailableMessage({ connected: true, failed: true, rejected: false }),
    ).toContain("Retrying automatically");
  });

  it("shows a pending message when the check has not failed", () => {
    expect(
      sessionPermissionsUnavailableMessage({ connected: true, failed: false, rejected: false }),
    ).toContain("Checking permissions");
  });
});
