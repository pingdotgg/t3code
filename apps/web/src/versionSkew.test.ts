import { EnvironmentId, type ServerInstallation } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.34" }));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  manualServerUpdate,
  resolveVersionMismatch,
} from "./versionSkew";

const MISMATCH_HINT =
  "Version mismatch. Try syncing the client and server to the same T3 Code version.";

describe("versionSkew", () => {
  const command = (installation?: ServerInstallation) =>
    manualServerUpdate("0.0.45", "vm", installation).command;
  const userUnit = { name: "t3.service", scope: "user" } as const;

  it("updates only the proven npm prefix and safely quotes its path", () => {
    expect(command({ kind: "npm-global", prefix: "/opt/node" })).toBe(
      "npm install --global --prefix '/opt/node' t3@0.0.45",
    );
    expect(command({ kind: "npm-global", prefix: "/opt/maria's node" })).toBe(
      "npm install --global --prefix '/opt/maria'\\''s node' t3@0.0.45",
    );
  });

  it("relaunches with the subcommand the server runs", () => {
    expect(command()).toBe("npx t3@0.0.45");
    expect(manualServerUpdate("0.0.45", "vm").description).toContain("same subcommand and options");
    expect(command({ kind: "unknown", subcommand: "serve" })).toBe("npx t3@0.0.45 serve");
    expect(command({ kind: "bunx", subcommand: "serve" })).toBe("bunx t3@0.0.45 serve");
  });

  it("goes through the systemd unit that would restart the old version", () => {
    expect(command({ kind: "npx", subcommand: "serve", systemdUnit: userUnit })).toBe(
      "systemctl --user daemon-reload && systemctl --user restart 't3.service'",
    );
    expect(command({ kind: "npm-global", prefix: "/opt/node", systemdUnit: userUnit })).toBe(
      "npm install --global --prefix '/opt/node' t3@0.0.45 && systemctl --user restart 't3.service'",
    );
    expect(
      manualServerUpdate("0.0.45", "vm", {
        kind: "npx",
        systemdUnit: { name: "t3.service", scope: "system" },
      }),
    ).toMatchObject({
      command: "sudo systemctl daemon-reload && sudo systemctl restart 't3.service'",
      description: expect.stringContaining("ExecStart"),
    });
  });

  it("restarts the existing unit without replacing its launch configuration", () => {
    expect(
      command({
        kind: "npx",
        systemdUnit: { name: "t3@my\\x2dinstance.service", scope: "user" },
      }),
    ).toBe(
      "systemctl --user daemon-reload && systemctl --user restart 't3@my\\x2dinstance.service'",
    );
  });
  it("tells users to preserve launch options when editing a service", () => {
    const update = manualServerUpdate("0.0.45", "vm", { kind: "npx", systemdUnit: userUnit });
    expect(update.label).toBe("Copy restart command");
    expect(update.description).toContain("ExecStart");
    expect(update.description).toContain("keep its existing subcommand and options");
    expect(update.description).toContain("t3@0.0.45");
  });

  it("updates a standalone service's executable instead of an npm spec", () => {
    const update = manualServerUpdate("0.0.45", "vm", { kind: "unknown", systemdUnit: userUnit });
    expect(update.description).toContain("update the executable");
    expect(update.description).toContain("0.0.45");
    expect(update.description).not.toContain("t3@");
    expect(update.command).toBe(
      "systemctl --user daemon-reload && systemctl --user restart 't3.service'",
    );
  });

  beforeEach(() => {
    branding.APP_VERSION = "0.0.34";
  });

  it("dismisses only the current failed attempt without clearing its retry state", () => {
    const failure = {
      status: "failed",
      stage: "downloading",
      fromVersion: "0.0.33",
      targetVersion: "0.0.34",
      message: "Download failed.",
    } as const satisfies ServerUpdateState;
    const retryFailure = { ...failure };
    const otherEnvironmentFailure = { ...failure };

    dismissServerUpdateFailure(failure);

    expect(isServerUpdateFailureDismissed(failure)).toBe(true);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe("Download failed.");
    expect(isServerUpdateFailureDismissed(retryFailure)).toBe(false);
    expect(isServerUpdateFailureDismissed(otherEnvironmentFailure)).toBe(false);
  });

  it("returns a mismatch when the server is behind the client", () => {
    expect(resolveVersionMismatch("0.0.33")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "0.0.33",
      hint: MISMATCH_HINT,
    });
  });

  it("does not warn when the server is ahead of the client", () => {
    expect(resolveVersionMismatch("0.0.35")).toBeNull();
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when a nightly and a stable build share a core version", () => {
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34")).toBeNull();
  });

  it.each(["0.0.34-nightly.20260823.1124", "0.0.34-nightly.20260824.1124"])(
    "warns when nightly server %s is behind a nightly client on the same release",
    (serverVersion) => {
      branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

      expect(resolveVersionMismatch(serverVersion)).toEqual({
        clientVersion: "0.0.34-nightly.20260824.1125",
        serverVersion,
        hint: MISMATCH_HINT,
      });
    },
  );

  // regression: #7579 versions were compared as strings, not semver
  it("treats a nightly server built past the client as ahead, not skew", () => {
    expect(resolveVersionMismatch("0.0.35-nightly.20260818.1124")).toBeNull();
  });

  it("still warns when a nightly client outruns the server by a release", () => {
    branding.APP_VERSION = "0.0.35-nightly.20260818.1124";

    expect(resolveVersionMismatch("0.0.34")).toEqual({
      clientVersion: "0.0.35-nightly.20260818.1124",
      serverVersion: "0.0.34",
      hint: MISMATCH_HINT,
    });
  });

  it("falls back to string inequality when a version is not semver", () => {
    expect(resolveVersionMismatch("dev")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "dev",
      hint: MISMATCH_HINT,
    });

    branding.APP_VERSION = "dev";
    expect(resolveVersionMismatch("dev")).toBeNull();
    expect(resolveVersionMismatch("0.0.34")).toMatchObject({ serverVersion: "0.0.34" });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

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
});
