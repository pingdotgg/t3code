import * as railway from "@distilled.cloud/railway";
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

/** Poll `volumeInstance({id})` until Railway reports the instance gone. */
export const waitUntilVolumeGone = (volumeInstanceId: string) =>
  railway
    .volumeInstance(
      { id: volumeInstanceId },
      { deletedAt: true, isPendingDeletion: true, state: true },
    )
    .pipe(
      Effect.map((instance) =>
        isGoneInstance(instance) ? ("gone" as const) : ("found" as const),
      ),
      railway.catchTags(["RailwayNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );
