import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

interface Spawns {
  count: number;
  /** Status reads so far; each names the account `n<reads>`. */
  statusReads?: number;
  /** Holds the first status read until it completes, and says when it started. */
  firstStatus?: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

const layerTest = (whoisSpawns: Spawns) =>
  TailscaleHost.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            whoisSpawns.count += 1;
            const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
            const isStatus = args[0] === "status";
            const read = isStatus
              ? (whoisSpawns.statusReads = (whoisSpawns.statusReads ?? 0) + 1)
              : 0;
            const gate = isStatus && read === 1 ? whoisSpawns.firstStatus : undefined;
            const stdout = isStatus
              ? JSON.stringify({ BackendState: "Running", Self: { ID: `n${read}` } })
              : WHOIS_JSON;
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode:
                  gate === undefined
                    ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                    : Deferred.succeed(gate.started, undefined).pipe(
                        Effect.andThen(Deferred.await(gate.release)),
                        Effect.as(ChildProcessSpawner.ExitCode(0)),
                      ),
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
  it.effect("a fresh status read never joins a kept read already running", () => {
    const spawns: Spawns = {
      count: 0,
      firstStatus: { started: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() },
    };
    return Effect.gen(function* () {
      const host = yield* TailscaleHost.TailscaleHost;
      const kept = yield* host.status.pipe(Effect.forkChild);
      yield* Deferred.await(spawns.firstStatus!.started);
      // The kept read began before, say, an account switch; the fresh one must not share it.
      expect((yield* host.freshStatus).selfNodeId).toBe("n2");
      yield* Deferred.succeed(spawns.firstStatus!.release, undefined);
      expect((yield* Fiber.join(kept)).selfNodeId).toBe("n1");
    }).pipe(Effect.provide(layerTest(spawns)));
  });

  it.effect("asks Tailscale on every whois and allows 10 lookups per address a minute", () => {
    const whoisSpawns = { count: 0 };
    return Effect.gen(function* () {
      const host = yield* TailscaleHost.TailscaleHost;
      const address = "100.88.1.2";

      for (let lookup = 1; lookup <= 10; lookup += 1) {
        yield* host.whois(address);
      }
      expect(whoisSpawns.count).toBe(10);

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
});
