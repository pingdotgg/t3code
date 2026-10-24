import { useAtomValue } from "@effect/atom-react";
import { APP_VERSION } from "~/branding";
import { useNpmReleasePublished } from "~/state/npmRelease";
import { collectUpdateOptions, type UpdateItemKey } from "./updateEverything.logic";
import { updateOptionsSnapshotAtom } from "./updateEverythingOptions";
import { startUpdatePlan } from "./updateEverythingRun";

export function useUpdateEverything(localUpdateVersion: string | null) {
  const snapshot = useAtomValue(updateOptionsSnapshotAtom);
  const npmPublished = useNpmReleasePublished(localUpdateVersion ?? APP_VERSION);
  const { devices, operations } = collectUpdateOptions({
    ...snapshot,
    localVersion: localUpdateVersion,
    npmPublished,
  });
  const count = operations.size;
  return {
    hasUpdates: count > 0,
    summary: "Choose " + count + " update" + (count === 1 ? "" : "s"),
    devices,
    run: (selection: ReadonlySet<UpdateItemKey>, autoResume = true) =>
      startUpdatePlan(selection, localUpdateVersion, npmPublished, autoResume),
  };
}
