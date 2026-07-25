import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_VERSION } from "./branding";
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  serverUpdateGuidance,
} from "./versionSkew";

describe("versionSkew", () => {
  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  it("returns a mismatch when the server version differs from the client", () => {
    expect(resolveVersionMismatch("9.9.9")).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: "Version mismatch. Try syncing the client and server to the same T3 Code version.",
    });
  });

  it("reads the server version from config descriptors", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: "9.9.9",
    });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("appends a hint to connection errors when versions differ", () => {
    const mismatch = resolveVersionMismatch("9.9.9");

    expect(appendVersionMismatchHint("Socket closed.", mismatch)).toBe(
      "Socket closed. Hint: Version mismatch. Try syncing the client and server to the same T3 Code version.",
    );
  });

  it("reads desktop-managed update capabilities from config descriptors", () => {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make("environment-desktop"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed",
          },
        },
      }),
    ).toBe("desktop-managed");
    expect(resolveServerSelfUpdateCapability(null)).toBeNull();
  });

  it("matches version-drift guidance to the advertised update path", () => {
    expect(serverUpdateGuidance("respawn", "Remote server")).toBe(
      "Update the Remote server so they stay in sync.",
    );
    expect(serverUpdateGuidance("desktop-managed", "Desktop server")).toBe(
      "The Desktop server is run by the T3 Code desktop app on its machine — update the desktop app there to sync them.",
    );
    expect(serverUpdateGuidance(null, "Local server")).toBe(
      "Relaunch the Local server with the copied command to sync them.",
    );
  });
});
