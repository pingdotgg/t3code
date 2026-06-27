import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  desktopLocalBackendId,
  desktopLocalConnectionId,
  isDesktopLocalConnectionTarget,
} from "./desktopLocal";

describe("desktop local connection identity", () => {
  it("preserves the desktop backend instance id", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(desktopLocalBackendId(target)).toBe("wsl:Ubuntu");
  });

  it("does not classify the primary environment as desktop-local", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-primary"),
      httpBaseUrl: "http://127.0.0.1:3773",
      label: "This device",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(false);
    expect(desktopLocalBackendId(target)).toBeNull();
  });
});
