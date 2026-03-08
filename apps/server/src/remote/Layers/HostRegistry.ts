import type { RemoteHostRecord } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { RemoteHostRepository } from "../../persistence/Services/RemoteHosts.ts";
import {
  RemoteHostRegistry,
  type RemoteHostRegistryShape,
} from "../Services/HostRegistry.ts";

interface RemoteHostSignatureInput {
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string | null | undefined;
  readonly sshConfigHost: string | null | undefined;
  readonly helperCommand: string;
}

const hostSignature = (host: RemoteHostSignatureInput) =>
  JSON.stringify([
    host.label,
    host.host,
    host.port,
    host.user,
    host.identityFile ?? null,
    host.sshConfigHost ?? null,
    host.helperCommand,
  ]);

const hostSignatureFromRecord = (host: RemoteHostRecord) =>
  hostSignature({
    label: host.label,
    host: host.host,
    port: host.port,
    user: host.user,
    identityFile: host.identityFile,
    sshConfigHost: host.sshConfigHost,
    helperCommand: host.helperCommand,
  });

const dedupeRemoteHosts = (hosts: ReadonlyArray<RemoteHostRecord>): ReadonlyArray<RemoteHostRecord> => {
  const seen = new Set<string>();
  const deduped: RemoteHostRecord[] = [];
  for (const host of hosts) {
    const signature = hostSignatureFromRecord(host);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(host);
  }
  return deduped;
};

const findMatchingHost = (
  hosts: ReadonlyArray<RemoteHostRecord>,
  candidate: RemoteHostSignatureInput,
) => hosts.find((host) => hostSignatureFromRecord(host) === hostSignature(candidate));

const makeRemoteHostRegistry = Effect.gen(function* () {
  const repository = yield* RemoteHostRepository;

  const list: RemoteHostRegistryShape["list"] = () =>
    repository.listAll().pipe(Effect.map(dedupeRemoteHosts));

  const getById: RemoteHostRegistryShape["getById"] = (remoteHostId) =>
    repository.getById({ remoteHostId });

  const upsert: RemoteHostRegistryShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const allHosts = yield* repository.listAll();
      const existingById = allHosts.find((host) => host.id === input.id);
      const previous =
        existingById ??
        findMatchingHost(allHosts, {
          label: input.label,
          host: input.host,
          port: input.port,
          user: input.user,
          identityFile: input.identityFile,
          sshConfigHost: input.sshConfigHost,
          helperCommand: input.helperCommand ?? "t3 remote-agent --stdio",
        });
      const row = {
        id: previous?.id ?? input.id,
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
    remove: (remoteHostId) =>
      Effect.gen(function* () {
        const existing = yield* repository.getById({ remoteHostId });
        const host = Option.getOrUndefined(existing);
        if (!host) {
          return;
        }
        const allHosts = yield* repository.listAll();
        const matchingHosts = allHosts.filter(
          (candidate) => hostSignatureFromRecord(candidate) === hostSignatureFromRecord(host),
        );
        yield* Effect.forEach(
          matchingHosts,
          (candidate) => repository.deleteById({ remoteHostId: candidate.id }),
          { concurrency: "unbounded", discard: true },
        );
      }),
    updateConnectionState,
  } satisfies RemoteHostRegistryShape;
});

export const RemoteHostRegistryLive = Layer.effect(RemoteHostRegistry, makeRemoteHostRegistry);
