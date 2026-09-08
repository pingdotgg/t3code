import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { Volume } from "./Volume.ts";

export interface MountVolumeOptions {
  /**
   * Absolute path on the Server the Volume is mounted at
   * (e.g. `/data`).
   */
  path: string;
}

/**
 * Runtime view of a Volume mounted into a {@link Service} (or bound onto
 * a Server): the path and the linux device.
 */
export interface MountedVolume {
  /** Mount path on the Server (same value as {@link MountVolumeOptions.path}). */
  path: string;
  /** Device path (e.g. `/dev/disk/by-id/scsi-0HC_Volume_…`). */
  device: string;
}

const linuxDeviceOf = (volume: Volume): string => {
  const value = (volume as { linuxDevice?: unknown }).linuxDevice;
  return typeof value === "string" ? value : "";
};

const isBindHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Hetzner.Service" ||
    (value as { Type?: string }).Type === "Hetzner.Server");

/**
 * Binding contract accepted by {@link Service} (and optionally Server)
 * for mounted volumes and injected env.
 */
export interface ServiceBinding {
  env?: Record<string, any>;
  volumes?: Array<{
    volumeId: number;
    path: string;
  }>;
}

/**
 * Mount a Hetzner Volume into a {@link Service}.
 *
 * `yield* Hetzner.MountVolume(volume, { path: "/data" })` inside a
 * Service impl registers `{ env, volumes: [{ volumeId, path }] }` on the
 * host. Service reconcile attaches the Volume (no automount) and SSHs
 * `mkdir` + `mount` + fstab at `path`. The same `(volume, server, path)`
 * from two Services is one attach and one mount.
 *
 * ### Mounting volumes
 * **Example:** Share a Volume between two Services
 * ```typescript
 * const volume = yield* Hetzner.Volume("data", {
 *   size: 10,
 *   format: "ext4",
 *   location: "nbg1",
 * });
 * const mount = yield* Hetzner.MountVolume(volume, { path: "/data" });
 * // mount.path === "/data"
 * // mount.device === volume.linuxDevice
 * ```
 *
 * @binding
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Hetzner.MountVolume",
  (volume: Volume, options: MountVolumeOptions) => Effect.Effect<MountedVolume>
> {}

export const MountVolume = Binding.Service<MountVolume>("Hetzner.MountVolume");

export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (volume: Volume, options: MountVolumeOptions) {
      const device = linuxDeviceOf(volume);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindHost(host)) {
          yield* host.bind`Allow(${host}, Hetzner.MountVolume(${volume}))`({
            volumes: [{ volumeId: volume.id, path: options.path }],
          });
        }
      }
      return { path: options.path, device };
    }),
  ),
);
