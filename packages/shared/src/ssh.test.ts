import { describe, expect, it } from "vitest";

import { buildSshArgs, resolveSshDestination } from "./ssh";

describe("resolveSshDestination", () => {
  it("prefers the ssh config host when present", () => {
    expect(
      resolveSshDestination({
        user: "jetson",
        host: "10.110.51.30",
        sshConfigHost: "jat01",
      }),
    ).toBe("jat01");
  });

  it("falls back to user@host when no ssh config host is set", () => {
    expect(
      resolveSshDestination({
        user: "jetson",
        host: "10.110.51.30",
        sshConfigHost: undefined,
      }),
    ).toBe("jetson@10.110.51.30");
  });
});

describe("buildSshArgs", () => {
  it("builds a non-interactive ssh invocation for remote helpers", () => {
    expect(
      buildSshArgs(
        {
          port: 22,
          identityFile: "/home/kbenkhaled/.ssh/id_rsa",
          user: "jetson",
          host: "10.110.51.30",
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
      "/home/kbenkhaled/.ssh/id_rsa",
      "jetson@10.110.51.30",
      "/usr/bin/env sh -lc 'echo hi'",
    ]);
  });

  it("omits identity flags when no identity file is configured", () => {
    expect(
      buildSshArgs({
        port: 2222,
        identityFile: undefined,
        user: "jetson",
        host: "10.110.51.30",
        sshConfigHost: "jat01",
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "jat01",
    ]);
  });
});
