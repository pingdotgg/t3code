import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import type { DaytonaVolume } from "./volume.service";
import { makeVolumeService } from "./volume.layer";

function createFakeVolume(name: string): DaytonaVolume {
  return Object.assign(Object.create(null), {
    id: `vol_${name}`,
    name,
    organizationId: "org_123",
    state: "ready",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    lastUsedAt: null,
    errorReason: null,
    __brand: "Volume",
  });
}

function createVolumeClient(options?: {
  readonly getError?: unknown;
  readonly listError?: unknown;
  readonly deleteError?: unknown;
  readonly getSequence?: ReadonlyArray<DaytonaVolume>;
}) {
  const deleteCalls: string[] = [];
  const getCalls: Array<{
    readonly name: string;
    readonly create: boolean | undefined;
  }> = [];

  return {
    deleteCalls,
    getCalls,
    client: {
      volume: {
        list: async () => {
          if (options?.listError) {
            throw options.listError;
          }

          return [createFakeVolume("alpha"), createFakeVolume("beta")];
        },
        get: async (name: string, create?: boolean) => {
          getCalls.push({ name, create });

          if (options?.getError) {
            throw options.getError;
          }

          const next = options?.getSequence?.[getCalls.length - 1];
          if (next) {
            return next;
          }

          const last = options?.getSequence?.[options.getSequence.length - 1];
          if (last) {
            return last;
          }

          return createFakeVolume(name);
        },
        delete: async (volume: DaytonaVolume) => {
          deleteCalls.push(volume.name);

          if (options?.deleteError) {
            throw options.deleteError;
          }
        },
      },
    },
  };
}

describe("makeVolumeService", () => {
  test("lists and ensures volumes", async () => {
    const { client, getCalls } = createVolumeClient();
    const service = makeVolumeService({ client });

    await expect(Effect.runPromise(service.listVolumes())).resolves.toHaveLength(2);
    await expect(Effect.runPromise(service.ensureVolume("shared-cache"))).resolves.toMatchObject({
      name: "shared-cache",
    });

    expect(getCalls).toContainEqual({
      name: "shared-cache",
      create: true,
    });
  });

  test("waits for a newly created volume to become ready", async () => {
    const { client, getCalls } = createVolumeClient({
      getSequence: [
        {
          ...createFakeVolume("shared-cache"),
          state: "pending_create",
        },
        {
          ...createFakeVolume("shared-cache"),
          state: "ready",
        },
      ],
    });
    const service = makeVolumeService({
      client,
      readyPollAttempts: 3,
      readyPollIntervalMs: 0,
    });

    await expect(Effect.runPromise(service.ensureVolume("shared-cache"))).resolves.toMatchObject({
      name: "shared-cache",
      state: "ready",
    });

    expect(getCalls).toEqual([
      {
        name: "shared-cache",
        create: true,
      },
      {
        name: "shared-cache",
        create: undefined,
      },
    ]);
  });

  test("deletes a volume after resolving it by name", async () => {
    const { client, deleteCalls, getCalls } = createVolumeClient();
    const service = makeVolumeService({ client });

    await Effect.runPromise(service.deleteVolume("shared-cache"));

    expect(getCalls).toContainEqual({
      name: "shared-cache",
      create: undefined,
    });
    expect(deleteCalls).toEqual(["shared-cache"]);
  });

  test("maps list and lookup failures to typed errors", async () => {
    const listService = makeVolumeService({
      client: createVolumeClient({
        listError: new Error("boom"),
      }).client,
    });

    await expect(Effect.runPromise(listService.listVolumes())).rejects.toMatchObject({
      _tag: "VolumeListError",
    });

    const lookupService = makeVolumeService({
      client: createVolumeClient({
        getError: new Error("missing"),
      }).client,
    });

    await expect(Effect.runPromise(lookupService.getVolume("missing"))).rejects.toMatchObject({
      _tag: "VolumeLookupError",
      volumeName: "missing",
    });
  });

  test("fails when a volume never becomes ready", async () => {
    const service = makeVolumeService({
      client: createVolumeClient({
        getSequence: [
          {
            ...createFakeVolume("stuck-volume"),
            state: "pending_create",
          },
          {
            ...createFakeVolume("stuck-volume"),
            state: "pending_create",
          },
          {
            ...createFakeVolume("stuck-volume"),
            state: "pending_create",
          },
        ],
      }).client,
      readyPollAttempts: 3,
      readyPollIntervalMs: 0,
    });

    await expect(Effect.runPromise(service.ensureVolume("stuck-volume"))).rejects.toMatchObject({
      _tag: "VolumeNotReadyError",
      volumeName: "stuck-volume",
      currentState: "pending_create",
    });
  });
});
