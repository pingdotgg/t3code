import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildWslNodeEnvPreamble,
  DesktopWslDistroListError,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatWslShellTransportFailureReason,
  parseDistroIpCandidates,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseToolchainReport,
  pickDistroIp,
  probeWslDistros,
  windowsIpv4Interfaces,
} from "./DesktopWslEnvironment.ts";

const encoder = new TextEncoder();

const makeDistroListSpawner = (result: { readonly stdout?: string; readonly exitCode?: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          result.exitCode === undefined
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(result.exitCode === undefined),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

describe("probeWslDistros", () => {
  it.effect("preserves a successful empty distro list", () =>
    Effect.gen(function* () {
      const distros = yield* probeWslDistros;
      expect(distros).toEqual([]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ stdout: "", exitCode: 0 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command exits unsuccessfully", () =>
    Effect.gen(function* () {
      const error = yield* probeWslDistros.pipe(Effect.flip);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("exited with code 1");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ exitCode: 1 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command times out", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeDistroListSpawner({})),
    );
    return Effect.gen(function* () {
      const fiber = yield* probeWslDistros.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(8));
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("timed out");
    }).pipe(Effect.provide(layer));
  });
});

describe("parseDistroIpCandidates", () => {
  it("orders the route src ahead of the hostname -I list and dedupes", () => {
    const stdout = [
      "route:1.1.1.1 via 172.27.0.1 dev eth0 src 172.27.5.44 uid 1000",
      "all:172.17.0.1 172.27.5.44",
    ].join("\n");
    expect(parseDistroIpCandidates(stdout)).toEqual(["172.27.5.44", "172.17.0.1"]);
  });

  it("collects only hostname -I addresses when there is no default route", () => {
    expect(parseDistroIpCandidates("route:\nall:172.27.5.44 fe80::1")).toEqual(["172.27.5.44"]);
  });

  it("skips a route line without a valid IPv4 src token", () => {
    const stdout = ["route:1.1.1.1 dev eth0 src fdcc::2 metric 256", "all:172.27.5.44"].join("\n");
    expect(parseDistroIpCandidates(stdout)).toEqual(["172.27.5.44"]);
  });

  it("accepts CRLF output", () => {
    expect(parseDistroIpCandidates("route:\r\nall:172.27.5.44\r\n")).toEqual(["172.27.5.44"]);
  });

  it("rejects tokens with out-of-range octets", () => {
    const stdout = [
      "route:1.1.1.1 via 10.0.0.1 dev eth0 src 300.1.2.3 uid 1000",
      "all:999.1.1.1 172.27.5.44 172.27.5.256",
    ].join("\n");
    expect(parseDistroIpCandidates(stdout)).toEqual(["172.27.5.44"]);
  });

  it("returns no candidates when neither probe produced an IPv4 address", () => {
    expect(parseDistroIpCandidates("route:\nall:")).toEqual([]);
    expect(parseDistroIpCandidates("")).toEqual([]);
  });
});

describe("pickDistroIp", () => {
  const wslVEthernet = {
    name: "vEthernet (WSL (Hyper-V firewall))",
    address: "172.27.0.1",
    netmask: "255.255.240.0",
  };
  const wifi = { name: "Wi-Fi", address: "192.168.1.219", netmask: "255.255.255.0" };

  it("picks the eth0 address in the WSL vEthernet subnet over Docker bridges (#5211)", () => {
    // Docker bridge networks sort first in `hostname -I` but are internal to
    // the distro; only eth0 shares a subnet with a Windows interface.
    expect(pickDistroIp(["172.17.0.1", "172.19.0.1", "172.27.5.44"], [wslVEthernet, wifi])).toBe(
      "172.27.5.44",
    );
  });

  it("skips a VPN tunnel src that owns the Internet route inside the distro", () => {
    // A full-tunnel VPN inside WSL makes `ip route get 1.1.1.1` report the
    // tunnel address, which Windows cannot reach; eth0 must still win.
    expect(pickDistroIp(["10.8.0.5", "172.17.0.1", "172.27.5.44"], [wslVEthernet, wifi])).toBe(
      "172.27.5.44",
    );
  });

  it("picks the mirrored-mode address that equals a Windows interface IP", () => {
    expect(pickDistroIp(["192.168.1.219"], [wifi])).toBe("192.168.1.219");
  });

  it("picks the mirrored host address even when Docker bridges sort first (#5211)", () => {
    // The exact `hostname -I` ordering from the issue under mirrored
    // networking: three Docker bridge addresses ahead of the mirrored IP.
    expect(pickDistroIp(["172.22.0.1", "172.19.0.1", "172.17.0.1", "192.168.1.219"], [wifi])).toBe(
      "192.168.1.219",
    );
  });

  it("prefers the WSL subnet match over a Docker bridge that equals another Windows adapter", () => {
    // Docker's default bridge (172.17.0.1) can coincide with a Hyper-V
    // adapter address on Windows; that equality must not pose as mirrored
    // mode while eth0 sits inside the real WSL adapter's subnet.
    const defaultSwitch = {
      name: "vEthernet (Default Switch)",
      address: "172.17.0.1",
      netmask: "255.255.240.0",
    };
    expect(pickDistroIp(["172.17.0.1", "172.27.5.44"], [defaultSwitch, wslVEthernet])).toBe(
      "172.27.5.44",
    );
  });

  it("outranks a Windows VPN whose address space overlaps an in-distro tunnel", () => {
    // A corporate VPN adapter on Windows can share 10.x/172.x space with an
    // in-distro tunnel or Docker bridge; the WSL adapter match must win even
    // though the tunnel src is the first candidate.
    const corporateVpn = { name: "Ethernet 3", address: "10.8.44.7", netmask: "255.255.0.0" };
    expect(
      pickDistroIp(["10.8.0.5", "172.17.0.1", "172.27.5.44"], [corporateVpn, wslVEthernet]),
    ).toBe("172.27.5.44");
  });

  it("still accepts a subnet match on a custom-named switch when no WSL adapter matches", () => {
    const customSwitch = {
      name: "vEthernet (Custom)",
      address: "192.168.100.1",
      netmask: "255.255.255.0",
    };
    expect(pickDistroIp(["192.168.100.44"], [customSwitch])).toBe("192.168.100.44");
  });

  it("returns a lone unmatched candidate but never guesses between several", () => {
    expect(pickDistroIp(["172.27.5.44"], [])).toBe("172.27.5.44");
    expect(pickDistroIp(["10.8.0.5", "172.17.0.1"], [wifi])).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(pickDistroIp([], [wslVEthernet])).toBeNull();
  });
});

describe("windowsIpv4Interfaces", () => {
  it("flattens IPv4 entries across adapters, accepting string and numeric family", () => {
    expect(
      windowsIpv4Interfaces({
        "vEthernet (WSL)": [
          { address: "172.27.0.1", family: "IPv4", internal: false, netmask: "255.255.240.0" },
          { address: "fe80::1", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::" },
        ],
        "Wi-Fi": [{ address: "192.168.1.219", family: 4, internal: false }],
        Disconnected: undefined,
      }),
    ).toEqual([
      { name: "vEthernet (WSL)", address: "172.27.0.1", netmask: "255.255.240.0" },
      { name: "Wi-Fi", address: "192.168.1.219", netmask: undefined },
    ]);
  });
});

describe("formatNodePtyProbeFailureReason", () => {
  it("identifies a packaged build that omitted the Linux node-pty prebuild", () => {
    const reason = formatNodePtyProbeFailureReason(4);

    expect(reason).toContain("packaged Linux node-pty binary was not included");
    expect(reason).toContain("--wsl-prebuild");
  });

  it("leaves other node-pty load failures to the compatibility diagnostic", () => {
    expect(formatNodePtyProbeFailureReason(1)).toBeNull();
  });
});

describe("formatWslShellTransportFailureReason", () => {
  it("distinguishes timeouts and spawn failures from normal shell exit codes", () => {
    expect(formatWslShellTransportFailureReason("timeout")).toContain("timed out");
    expect(formatWslShellTransportFailureReason("spawn")).toContain("could not start wsl.exe");
    expect(formatWslShellTransportFailureReason("process")).toContain("lost communication");
    expect(formatWslShellTransportFailureReason(null)).toBeNull();
  });
});

describe("buildWslNodeEnvPreamble", () => {
  it("passes the required Node engine range into the shared resolver", () => {
    const preamble = buildWslNodeEnvPreamble("^22.16 || ^23.11 || >=24.10");

    expect(preamble).toContain("T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'");
    expect(preamble.indexOf("T3_NODE_ENGINE_RANGE=")).toBeLessThan(
      preamble.lastIndexOf("ensure_remote_node_path || true"),
    );
  });

  it("keeps the shared resolver permissive when no Node engine range is provided", () => {
    expect(buildWslNodeEnvPreamble()).toContain("T3_NODE_ENGINE_RANGE=''");
  });
});

describe("parseToolchainReport", () => {
  it("returns no missing tools and no node version on empty output", () => {
    expect(parseToolchainReport("")).toEqual({ missingTools: [], nodeVersion: null });
  });

  it("collects all missing: lines", () => {
    const stdout = ["missing:make", "missing:g++", "nodeVersion:24.10.0"].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["make", "g++"],
      nodeVersion: "24.10.0",
    });
  });

  it("ignores blank lines and trims whitespace", () => {
    const stdout = ["  missing:python3  ", "", "  nodeVersion:v22.16.0  "].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["python3"],
      nodeVersion: "v22.16.0",
    });
  });

  it("returns null node version when value after prefix is empty", () => {
    expect(parseToolchainReport("nodeVersion:")).toEqual({
      missingTools: [],
      nodeVersion: null,
    });
  });
});

describe("parseNodePath", () => {
  it("extracts the absolute node path from a nodePath: line", () => {
    const stdout = "nodePath:/home/josh/.nvm/versions/node/v22.16.0/bin/node";
    expect(parseNodePath(stdout)).toBe("/home/josh/.nvm/versions/node/v22.16.0/bin/node");
  });

  it("returns null when node was not found (empty value after prefix)", () => {
    expect(parseNodePath("nodePath:")).toBeNull();
  });

  it("returns null when there is no nodePath line at all", () => {
    expect(parseNodePath("missing:node\nnodeVersion:")).toBeNull();
  });

  it("ignores surrounding noise and trims whitespace", () => {
    const stdout = ["some preamble noise", "  nodePath:/usr/bin/node  ", "trailing"].join("\n");
    expect(parseNodePath(stdout)).toBe("/usr/bin/node");
  });
});

describe("parseNodeVersion", () => {
  it("extracts the node version from a nodeVersion: line", () => {
    expect(parseNodeVersion("nodeVersion:24.10.0")).toBe("24.10.0");
  });

  it("returns null when the version value is empty", () => {
    expect(parseNodeVersion("nodeVersion:")).toBeNull();
  });

  it("returns null when there is no nodeVersion line at all", () => {
    expect(parseNodeVersion("nodePath:/usr/bin/node\nresolvedPath:/usr/bin")).toBeNull();
  });

  it("ignores surrounding noise and trims whitespace", () => {
    const stdout = [
      "some preamble noise",
      "  nodeVersion:22.16.0  ",
      "nodePath:/usr/bin/node",
    ].join("\n");
    expect(parseNodeVersion(stdout)).toBe("22.16.0");
  });
});

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });

  it("returns null when the resolved PATH is absent or empty", () => {
    expect(parseResolvedPath("nodePath:/usr/bin/node\n")).toBeNull();
    expect(parseResolvedPath("resolvedPath:\n")).toBeNull();
  });
});

describe("formatMissingToolsReason", () => {
  it("returns null when everything is present and node is in range", () => {
    expect(
      formatMissingToolsReason({ missingTools: [], nodeVersion: "24.10.0" }, "^24.10"),
    ).toBeNull();
  });

  it("returns null when range is not specified and tools are present", () => {
    expect(formatMissingToolsReason({ missingTools: [], nodeVersion: "18.0.0" }, null)).toBeNull();
  });

  it("flags missing node first", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["node", "make"], nodeVersion: null },
      "^24.10",
    );
    expect(reason).toContain("node");
    expect(reason).toContain("^24.10");
    expect(reason).toContain("make");
    expect(reason).toContain("nvm");
  });

  it("flags an out-of-range node version with the actual version surfaced", () => {
    const reason = formatMissingToolsReason(
      { missingTools: [], nodeVersion: "20.0.0" },
      "^24.10 || ^22.16",
    );
    expect(reason).toContain("node 20.0.0");
    expect(reason).toContain("requires ^24.10 || ^22.16");
  });

  it("flags missing build tools without node when node is fine", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["g++", "python3"], nodeVersion: "24.10.0" },
      "^24.10",
    );
    expect(reason).toContain("g++");
    expect(reason).toContain("python3");
    expect(reason).toContain("build-essential");
    expect(reason).not.toContain("nvm");
  });
});
