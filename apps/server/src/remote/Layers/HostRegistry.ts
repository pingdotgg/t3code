import { Effect, Layer, Option } from "effect";

import { RemoteHostRepository } from "../../persistence/Services/RemoteHosts.ts";
import {
  RemoteHostRegistry,
  type RemoteHostRegistryShape,
} from "../Services/HostRegistry.ts";

const makeRemoteHostRegistry = Effect.gen(function* () {
  const repository = yield* RemoteHostRepository;

  const list: RemoteHostRegistryShape["list"] = () => repository.listAll();

  const getById: RemoteHostRegistryShape["getById"] = (remoteHostId) =>
    repository.getById({ remoteHostId });

  const upsert: RemoteHostRegistryShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ remoteHostId: input.id });
      const previous = Option.getOrUndefined(existing);
      const row = {
        id: input.id,
        label: input.label,
        host: input.host,
        port: input.port,
        user: input.user,
        identityFile: input.identityFile,
        sshConfigHost: input.sshConfigHost,
        helperCommand: input.helperCommand ?? "t3 remote-agent --stdio",
        helperVersion: previous?.helperVersion ?? null,
        lastConnectionAttemptAt: previous?.lastConnectionAttemptAt ?? null,
        lastConnectionSucceededAt: previous?.lastConnectionSucceededAt ?? null,
        lastConnectionFailedAt: previous?.lastConnectionFailedAt ?? null,
        lastConnectionStatus: previous?.lastConnectionStatus ?? "unknown",
        lastConnectionError: previous?.lastConnectionError ?? null,
      } as const;
      yield* repository.upsert(row);
      return row;
    });

  const updateConnectionState: RemoteHostRegistryShape["updateConnectionState"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ remoteHostId: input.remoteHostId });
      const row = Option.getOrUndefined(existing);
      if (!row) {
        return yield* Effect.die(
          new Error(`Remote host '${input.remoteHostId}' not found for status update.`),
        );
      }
      const next = {
        ...row,
        helperVersion: input.helperVersion ?? row.helperVersion,
        lastConnectionAttemptAt: input.checkedAt,
        lastConnectionSucceededAt: input.ok ? input.checkedAt : row.lastConnectionSucceededAt,
        lastConnectionFailedAt: input.ok ? row.lastConnectionFailedAt : input.checkedAt,
        lastConnectionStatus: input.ok ? "ok" : "error",
        lastConnectionError: input.ok ? null : (input.message ?? row.lastConnectionError),
      } as const;
      yield* repository.upsert(next);
      return next;
    });

  return {
    list,
    getById,
    upsert,
    remove: (remoteHostId) => repository.deleteById({ remoteHostId }),
    updateConnectionState,
  } satisfies RemoteHostRegistryShape;
});

export const RemoteHostRegistryLive = Layer.effect(RemoteHostRegistry, makeRemoteHostRegistry);
