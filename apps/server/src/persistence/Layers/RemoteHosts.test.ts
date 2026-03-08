import { RemoteHostId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { RemoteHostRepositoryLive } from "./RemoteHosts.ts";
import { RemoteHostRepository } from "../Services/RemoteHosts.ts";

const asRemoteHostId = (value: string): RemoteHostId => RemoteHostId.makeUnsafe(value);

const layer = it.layer(RemoteHostRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("RemoteHostRepository", (it) => {
  it.effect("round-trips hosts without optional SSH fields", () =>
    Effect.gen(function* () {
      const repository = yield* RemoteHostRepository;
      const hostId = asRemoteHostId("remote-host-1");

      yield* repository.upsert({
        id: hostId,
        label: "Jetson",
        host: "10.110.51.30",
        port: 22,
        user: "jetson",
        helperCommand: "t3 remote-agent --stdio",
        helperVersion: null,
        lastConnectionAttemptAt: null,
        lastConnectionSucceededAt: null,
        lastConnectionFailedAt: null,
        lastConnectionStatus: "unknown",
        lastConnectionError: null,
      });

      const host = yield* repository.getById({ remoteHostId: hostId });
      const hosts = yield* repository.listAll();

      assert.equal(Option.isSome(host), true);
      if (Option.isNone(host)) {
        throw new Error("Expected remote host to exist after upsert.");
      }

      assert.deepStrictEqual(host.value, {
        id: hostId,
        label: "Jetson",
        host: "10.110.51.30",
        port: 22,
        user: "jetson",
        identityFile: undefined,
        sshConfigHost: undefined,
        helperCommand: "t3 remote-agent --stdio",
        helperVersion: null,
        lastConnectionAttemptAt: null,
        lastConnectionSucceededAt: null,
        lastConnectionFailedAt: null,
        lastConnectionStatus: "unknown",
        lastConnectionError: null,
      });
      assert.deepStrictEqual(hosts, [host.value]);
    }),
  );

  it.effect("round-trips hosts with optional SSH fields", () =>
    Effect.gen(function* () {
      const repository = yield* RemoteHostRepository;
      const hostId = asRemoteHostId("remote-host-2");

      yield* repository.upsert({
        id: hostId,
        label: "Jetson Keyed",
        host: "10.110.51.30",
        port: 22,
        user: "jetson",
        identityFile: "/home/kbenkhaled/.ssh/id_rsa",
        sshConfigHost: "jat01",
        helperCommand:
          "/usr/bin/env BUN_INSTALL=/home/jetson/.bun PATH=/home/jetson/.bun/bin:/usr/local/bin:/usr/bin:/bin sh -lc 'cd ~/t3code/apps/server && node dist/index.mjs remote-agent --stdio'",
        helperVersion: null,
        lastConnectionAttemptAt: null,
        lastConnectionSucceededAt: null,
        lastConnectionFailedAt: null,
        lastConnectionStatus: "unknown",
        lastConnectionError: null,
      });

      const host = yield* repository.getById({ remoteHostId: hostId });

      assert.equal(Option.isSome(host), true);
      if (Option.isNone(host)) {
        throw new Error("Expected remote host with optional SSH fields to exist after upsert.");
      }

      assert.deepStrictEqual(host.value, {
        id: hostId,
        label: "Jetson Keyed",
        host: "10.110.51.30",
        port: 22,
        user: "jetson",
        identityFile: "/home/kbenkhaled/.ssh/id_rsa",
        sshConfigHost: "jat01",
        helperCommand:
          "/usr/bin/env BUN_INSTALL=/home/jetson/.bun PATH=/home/jetson/.bun/bin:/usr/local/bin:/usr/bin:/bin sh -lc 'cd ~/t3code/apps/server && node dist/index.mjs remote-agent --stdio'",
        helperVersion: null,
        lastConnectionAttemptAt: null,
        lastConnectionSucceededAt: null,
        lastConnectionFailedAt: null,
        lastConnectionStatus: "unknown",
        lastConnectionError: null,
      });
    }),
  );
});
