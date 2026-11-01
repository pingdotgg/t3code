import {
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { describe } from "vite-plus/test";

import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import * as TailscaleHealth from "./TailscaleHealth.ts";
import { classifyTailscaleHealth, type TailscaleStatusRead } from "./TailscaleHealth.ts";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const running: TailscaleStatus = {
  magicDnsName: "studio.tail1234.ts.net",
  tailnetIpv4Addresses: ["100.64.0.1"],
  httpsServeEnabled: true,
  backendState: "Running",
  version: "1.102.2",
  users: [],
  selfNodeId: "n1",
  selfUserId: "1",
  selfTags: [],
  keyExpiry: iso(NOW + 90 * DAY),
  keyExpired: false,
  health: [],
  magicDnsEnabled: true,
  tailnetName: null,
  certDomains: ["studio.tail1234.ts.net"],
  userspaceNetworking: false,
  peers: [],
  unidentifiedPeers: [],
};

const context = { executable: "tailscale", subcommand: "status", argumentCount: 2 } as const;
const exitError = (stderrDiagnostic?: "not-logged-in" | "permission-denied" | "unknown") =>
  new TailscaleCommandExitError({
    ...context,
    exitCode: 1,
    stderrLength: 40,
    ...(stderrDiagnostic ? { stderrDiagnostic } : {}),
  });

const classify = (read: TailscaleStatusRead) =>
  classifyTailscaleHealth(read, {
    checkedAt: iso(NOW),
    now: NOW,
    platform: "linux",
  });

describe("classifyTailscaleHealth", () => {
  it.each<[string, TailscaleStatusRead, string, ReadonlyArray<string>]>([
    ["healthy", Result.succeed(running), "running", []],
    [
      "CLI not found",
      Result.fail(new TailscaleCommandSpawnError({ ...context, cause: new Error("ENOENT") })),
      "not_installed",
      ["not_installed"],
    ],
    ["daemon not running", Result.fail(exitError("unknown")), "not_running", ["not_running"]],
    [
      "CLI says logged out",
      Result.fail(exitError("not-logged-in")),
      "needs_login",
      ["needs_login"],
    ],
    [
      "socket permission",
      Result.fail(exitError("permission-denied")),
      "unreadable",
      ["unreadable"],
    ],
    [
      "CLI hangs",
      Result.fail(new TailscaleCommandTimeoutError({ ...context, timeoutMs: 3500, cause: null })),
      "unreadable",
      ["unreadable"],
    ],
    [
      "signed out, with health text that repeats it",
      Result.succeed({ ...running, backendState: "NeedsLogin", health: ["You are logged out."] }),
      "needs_login",
      ["needs_login"],
    ],
    [
      "waiting for admin approval",
      Result.succeed({ ...running, backendState: "NeedsMachineAuth" }),
      "needs_machine_approval",
      ["needs_machine_approval"],
    ],
    ["stopped", Result.succeed({ ...running, backendState: "Stopped" }), "stopped", ["stopped"]],
    [
      "expired key",
      Result.succeed({ ...running, backendState: "NeedsLogin", keyExpired: true }),
      "needs_login",
      ["needs_login", "key_expired"],
    ],
    [
      "key past its expiry before the daemon notices",
      Result.succeed({ ...running, keyExpiry: iso(NOW - 1000) }),
      "running",
      ["key_expired"],
    ],
    [
      "key expires within 7 days",
      Result.succeed({ ...running, keyExpiry: iso(NOW + 3 * DAY) }),
      "running",
      ["key_expiring"],
    ],
    ["key expiry turned off", Result.succeed({ ...running, keyExpiry: null }), "running", []],
    [
      "health, HTTPS, MagicDNS, userspace",
      Result.succeed({
        ...running,
        health: ["Tailscale could not connect to the DERP server"],
        httpsServeEnabled: false,
        certDomains: [],
        magicDnsEnabled: false,
        userspaceNetworking: true,
      }),
      "running",
      ["health_warning", "https_off", "magic_dns_off", "userspace_networking"],
    ],
    [
      "an older CLI that reports no capabilities or TUN",
      Result.succeed({
        ...running,
        httpsServeEnabled: null,
        certDomains: [],
        magicDnsEnabled: null,
        userspaceNetworking: null,
      }),
      "running",
      [],
    ],
  ])("%s", (_name, read, state, causes) => {
    const result = classify(read);
    expect(result.state).toBe(state);
    expect(result.issues.map((issue) => issue.cause)).toEqual(causes);
  });
});

describe("TailscaleHealth", () => {
  it.effect("reports nothing and runs no CLI while this machine shows no sign of Tailscale", () =>
    Effect.gen(function* () {
      const health = yield* TailscaleHealth.TailscaleHealth;
      expect(yield* health.check).toBeUndefined();
    }).pipe(
      Effect.provide(
        TailscaleHealth.layer.pipe(
          Layer.provide(
            Layer.succeed(
              TailscaleHost.TailscaleHost,
              TailscaleHost.TailscaleHost.of({
                inUse: Effect.succeed(false),
                status: Effect.die("must not read Tailscale"),
                freshStatus: Effect.die("must not read Tailscale"),
                whois: () => Effect.die("must not read Tailscale"),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
