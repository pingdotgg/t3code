import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as TailscaleHost from "./TailscaleHost.ts";

const WHOIS_JSON = JSON.stringify({
  Node: { StableID: "nStudio", User: 7, Addresses: ["100.88.1.2/32"], AllowedIPs: [] },
});

const layerTest = (whoisSpawns: { count: number; account?: string }) =>
  TailscaleHost.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
            const isWhois = args[0] === "whois";
            if (isWhois) whoisSpawns.count += 1;
            const stdout = isWhois
              ? WHOIS_JSON
              : JSON.stringify({
                  BackendState: "Running",
                  Self: { ID: whoisSpawns.account ?? "nBox" },
                });
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(new TextEncoder().encode(stdout)),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
        Layer.succeed(HostProcess.Platform, "linux"),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailscale-host-test-" }),
      ),
    ),
  );

it.layer(NodeServices.layer)("TailscaleHost", (it) => {
  it.effect("keeps whois answers for 3 s and allows 10 lookups per address a minute", () => {
    const whoisSpawns = { count: 0 };
    return Effect.gen(function* () {
      const host = yield* TailscaleHost.TailscaleHost;
      const address = "100.88.1.2";

      yield* host.whois(address);
      yield* TestClock.adjust("2999 millis");
      yield* host.whois(address);
      expect(whoisSpawns.count).toBe(1);
      yield* TestClock.adjust("1 millis");
      yield* host.whois(address);
      expect(whoisSpawns.count).toBe(2);

      for (let lookup = 3; lookup <= 10; lookup += 1) {
        yield* TestClock.adjust("3 seconds");
        yield* host.whois(address);
      }
      expect(whoisSpawns.count).toBe(10);

      yield* TestClock.adjust("3 seconds");
      const refused = yield* host.whois(address).pipe(Effect.flip);
      expect(refused._tag).toBe("TailscaleWhoisRateLimitedError");
      expect(whoisSpawns.count).toBe(10);
      // The limit is per address.
      yield* host.whois("100.88.1.3");
      expect(whoisSpawns.count).toBe(11);

      yield* TestClock.adjust("60 seconds");
      expect((yield* host.whois(address)).stableNodeId).toBe("nStudio");
      expect(whoisSpawns.count).toBe(12);
    }).pipe(Effect.provide(layerTest(whoisSpawns)));
  });

  // Another account is another tailnet, where the same address names another device.
  it.effect("never reuses a whois answer from another Tailscale account", () => {
    const whoisSpawns: { count: number; account?: string } = { count: 0, account: "nBox" };
    return Effect.gen(function* () {
      const host = yield* TailscaleHost.TailscaleHost;
      yield* host.status;
      yield* TestClock.adjust("2500 millis");
      yield* host.whois("100.88.1.2");
      whoisSpawns.account = "nBoxAtWork";
      // The status read expires and names the new account; the whois answer has not expired.
      yield* TestClock.adjust("2600 millis");
      yield* host.whois("100.88.1.2");
      expect(whoisSpawns.count).toBe(2);
    }).pipe(Effect.provide(layerTest(whoisSpawns)));
  });
});
