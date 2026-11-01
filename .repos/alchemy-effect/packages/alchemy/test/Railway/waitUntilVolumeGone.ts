import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const isGoneInstance = (instance: {
  deletedAt: string | null;
  isPendingDeletion: boolean;
  state: string | null;
}) =>
  instance.deletedAt != null ||
  instance.isPendingDeletion ||
  instance.state === "DELETED" ||
  instance.state === "DELETING";

const readVolumeInstance = Query.fn((id: string) => {
  const instance = Railway.volumeInstance({ id });
  return {
    deletedAt: instance.deletedAt,
    isPendingDeletion: instance.isPendingDeletion,
    state: instance.state,
  };
});

/** Poll `volumeInstance({id})` until Railway reports the instance gone. */
export const waitUntilVolumeGone = (volumeInstanceId: string) =>
  readVolumeInstance(volumeInstanceId).pipe(
    Effect.map((instance) =>
      isGoneInstance(instance) ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
