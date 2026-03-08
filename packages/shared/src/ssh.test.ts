import { describe, expect, it } from "vitest";

import { buildSshArgs, resolveSshDestination } from "./ssh";

describe("resolveSshDestination", () => {
  it("prefers the ssh config host when present", () => {
    expect(
      resolveSshDestination({
        user: "devuser",
        host: "198.51.100.24",
        sshConfigHost: "review-host",
      }),
    ).toBe("review-host");
  });

  it("falls back to user@host when no ssh config host is set", () => {
    expect(
      resolveSshDestination({
        user: "devuser",
        host: "198.51.100.24",
        sshConfigHost: undefined,
      }),
    ).toBe("devuser@198.51.100.24");
  });
});

describe("buildSshArgs", () => {
  it("builds a non-interactive ssh invocation for remote helpers", () => {
    expect(
      buildSshArgs(
        {
          port: 22,
          identityFile: "/home/example/.ssh/test_key",
          user: "devuser",
          host: "198.51.100.24",
          sshConfigHost: undefined,
        },
        "/usr/bin/env sh -lc 'echo hi'",
      ),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      "/home/example/.ssh/test_key",
      "devuser@198.51.100.24",
      "/usr/bin/env sh -lc 'echo hi'",
    ]);
  });

  it("omits identity flags when no identity file is configured", () => {
    expect(
      buildSshArgs({
        port: 2222,
        identityFile: undefined,
        user: "devuser",
        host: "198.51.100.24",
        sshConfigHost: "review-host",
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "review-host",
    ]);
  });
});
