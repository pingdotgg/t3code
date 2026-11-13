// @effect-diagnostics nodeBuiltinImport:off -- the SDK's synchronous spawn callback must record ownership before releasing the child.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const ProcessIdentity = Schema.Struct({
  pid: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })),
  startTime: Schema.String,
});
const OwnershipRecord = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.String,
  hostname: Schema.String,
  stateDir: Schema.String,
  owner: ProcessIdentity,
  processes: Schema.Array(Schema.Struct({ ...ProcessIdentity.fields, pgid: Schema.Int })),
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(OwnershipRecord));

// A concurrent exit can remove the record. Incomplete/unknown records never authorize a signal.
const readRecord = (recordPath: string) => {
  try {
    return decodeRecord(NodeFS.readFileSync(recordPath, "utf8"));
  } catch {
    return undefined;
  }
};

export const ProviderProcesses = Context.Reference<{
  readonly register?: (pid: number) => () => void;
  readonly hasOtherLiveOwner: boolean;
}>("t3/process/ProviderProcesses", { defaultValue: () => ({ hasOtherLiveOwner: false }) });

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return { hasOtherLiveOwner: false };
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = NodePath.join(stateDir, "provider-processes");
  const hostname = NodeOS.hostname();
  const boot = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const controller = AcpSessionRuntime.makePosixProcessTreeController(platform);
  const identity = (pid: number) => {
    const observed = controller.identity(pid);
    if (observed === undefined || AcpSessionRuntime.posixProcessIsZombie(observed))
      return undefined;
    return { ...observed, startTime: `${boot}:${observed.startTime}` };
  };
  const matches = (expected: typeof ProcessIdentity.Type) =>
    identity(expected.pid)?.startTime === expected.startTime;
  const kill = (survivor: typeof ProcessIdentity.Type) => {
    try {
      controller.signalProcess(survivor.pid, "SIGKILL");
    } catch {}
  };
  const owner = identity(process.pid);
  if (owner === undefined) return yield* Effect.die(new Error("Cannot identify provider owner"));
  NodeFS.mkdirSync(directory, { recursive: true });

  const writeRecord = (processes: (typeof OwnershipRecord.Type)["processes"]) => {
    const instanceId = NodeCrypto.randomUUID();
    const recordPath = NodePath.join(directory, `${instanceId}.json`);
    const pendingPath = `${recordPath}.pending`;
    NodeFS.writeFileSync(
      pendingPath,
      JSON.stringify({
        version: 1,
        instanceId,
        hostname,
        stateDir,
        owner: { pid: owner.pid, startTime: owner.startTime },
        processes,
      } satisfies typeof OwnershipRecord.Type),
    );
    NodeFS.renameSync(pendingPath, recordPath);
    return () => NodeFS.rmSync(recordPath, { force: true });
  };
  // Publish the server identity even before its first provider. Another server
  // using this home must not stop the shared systemd slice while we are alive.
  const forgetOwner = writeRecord([]);
  yield* Effect.addFinalizer(() => Effect.sync(forgetOwner));
  let hasOtherLiveOwner = false;

  // Only immutable per-launch records are shared between server instances. A
  // live owner's records belong to that server, even when it uses this home.
  for (const file of NodeFS.readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const recordPath = NodePath.join(directory, file);
    const record = readRecord(recordPath);
    if (record === undefined) continue;
    if (record.hostname !== hostname || record.stateDir !== stateDir) continue;
    if (matches(record.owner)) {
      if (record.owner.pid !== process.pid) hasOtherLiveOwner = true;
      continue;
    }
    let survived = false;
    for (const survivor of record.processes) {
      if (survivor.pid === process.pid || !matches(survivor)) continue;
      // Never infer ownership from argv, executable names, or group membership.
      // As in the ACP controller, starttime blocks reuse between observations.
      // Node has no pidfd_send_signal, so the final read-to-signal race remains.
      kill(survivor);
      for (let attempt = 0; matches(survivor) && !survived; attempt++) {
        survived = attempt === 100;
        if (!survived) yield* Effect.sleep("10 millis");
      }
    }
    // Like a failed slice stop, an unkillable CLI must not keep the server down;
    // its record stays so the next start retries.
    if (survived) {
      yield* Effect.logWarning("Could not stop a provider left by a previous server", { file });
      continue;
    }
    NodeFS.rmSync(recordPath, { force: true });
  }

  return {
    hasOtherLiveOwner,
    register: (pid: number) => {
      const provider = identity(pid);
      if (provider === undefined || provider.ppid !== process.pid) {
        throw new Error("Cannot identify spawned provider");
      }
      // A rename keeps startup from seeing a partial write. The child is gated
      // until this returns, so an abrupt death cannot leave an unrecorded CLI.
      return writeRecord([{ pid, startTime: provider.startTime, pgid: provider.pgid }]);
    },
  };
});

export const layer = Layer.effect(ProviderProcesses, make);
