import { useAtomValue } from "@effect/atom-react";
import {
  BlenderRequestError,
  EnvironmentAuthorizationError,
  isBlenderJobTerminal,
  type AssetResource,
  type BlenderJob,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { lazy, Suspense, useEffect, useEffectEvent, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceFailure } from "./fileSurfaceChrome";
import { modelViewRequestKey } from "./modelAnnotations";

const ModelViewer = lazy(() => import("./ModelViewer"));
const isBlenderRequestError = Schema.is(BlenderRequestError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The newest answer to opening the scene; a failed reopen keeps the job shown before it. */
interface Opened {
  /** Orders answers by when they were asked, so a late one never replaces a newer one. */
  readonly request: number;
  readonly job: BlenderJob | undefined;
  readonly error: unknown;
}
let openRequestId = 0;
const nextOpenRequestId = () => ++openRequestId;

/**
 * A thread's `.blend` in the 3D viewer. Opening it asks the environment for the scene's preview
 * export, which also offers the Blender tools to the thread's agent; agent edits of the scene
 * stream in as new preview revisions.
 */
export function BlenderFilePreview({
  thread,
  path,
  workspaceRoot,
  enabled,
  workspaceMutationId,
}: {
  readonly thread: ScopedThreadRef;
  readonly path: string;
  readonly workspaceRoot: string;
  /** The environment's Blender setting, or null while its config loads. */
  readonly enabled: boolean | null;
  readonly workspaceMutationId: string | null;
}) {
  const gt = useGT();
  const { environmentId, threadId } = thread;
  const canOpen = useAtomValue(serverEnvironment.blenderOpenScene.permissionAtom(environmentId));
  const openScene = useAtomCommand(serverEnvironment.blenderOpenScene, { reportFailure: false });
  const [opened, setOpened] = useState<Opened>({ request: 0, job: undefined, error: undefined });
  const active = enabled === true && canOpen;

  const open = async (retry: boolean) => {
    const request = nextOpenRequestId();
    const result = await openScene({
      environmentId,
      input: { threadId, path, ...(retry ? { retry } : {}) },
    }).catch((error: unknown) => AsyncResult.failure(Cause.die(error)));
    setOpened((previous) =>
      request < previous.request
        ? previous
        : AsyncResult.isSuccess(result)
          ? { request, job: result.value, error: undefined }
          : { request, job: previous.job, error: Cause.squash(result.cause) },
    );
  };
  const openAutomatically = useEffectEvent(() => void open(false));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment for this file version's preview on open and after each workspace change
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- state changes only when the request answers
    if (active) openAutomatically();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each workspace change may be a new version of the scene
  }, [active, environmentId, threadId, path, workspaceMutationId]);

  // Previews already published stay viewable to clients that may not start an export.
  const stream = useEnvironmentQuery(
    enabled === true ? serverEnvironment.blenderJobs({ environmentId, input: { threadId } }) : null,
  );
  const openedJob = opened.job;
  // The server's canonical path once it answers; aliases of the file match from then on.
  const sceneInput = openedJob?.input ?? path;
  const windows = isWindowsAbsolutePath(workspaceRoot);
  const normalize = (input: string) =>
    windows ? input.replaceAll("\\", "/").toLowerCase() : input;
  const sceneJobs =
    stream.data?.filter(
      (job) => job.input !== undefined && normalize(job.input) === normalize(sceneInput),
    ) ?? [];
  const liveJob = sceneJobs.find((job) => job.id === openedJob?.id) ?? openedJob;
  // Another open of a newer version replaced this export; follow the scene's newest job.
  const tracked = liveJob?.cancelledBy === "replaced" ? (sceneJobs[0] ?? liveJob) : liveJob;
  const currentPreview = sceneJobs.find((job) => job.result?.preview?.current);
  const updating = sceneJobs.some(
    (job) => job.outputs.includes("preview") && !isBlenderJobTerminal(job),
  );
  const previewResource: AssetResource | null = currentPreview?.result?.preview
    ? {
        _tag: "blender-output",
        threadId,
        jobId: currentPreview.id,
        output: "preview",
        revision: currentPreview.result.preview.revision,
      }
    : null;
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewAsset = useAssetUrlState(environmentId, previewResource, String(previewRefresh));
  // The last loaded revision stays on screen while the next one exports and loads.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  if (previewAsset._tag === "Success" && previewAsset.url !== previewUrl) {
    setPreviewUrl(previewAsset.url);
  } else if (currentPreview === undefined && stream.isSuccess && previewUrl !== null) {
    setPreviewUrl(null);
  }
  const [statsSlot, setStatsSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);

  const failure =
    enabled === null
      ? null
      : !enabled
        ? gt("Blender is off on this environment. Turn it on in Settings, Integrations.")
        : opened.error !== undefined
          ? openErrorText(opened.error, gt)
          : tracked?.status === "failed"
            ? (tracked.failure?.message ?? gt("Blender could not export this scene."))
            : tracked?.status === "cancelled"
              ? gt("The export stopped before it finished.")
              : previewAsset._tag === "Failure"
                ? gt("Preview unavailable")
                : stream.error
                  ? stream.error
                  : !canOpen && stream.isSuccess && currentPreview === undefined
                    ? gt(
                        "Previewing .blend files needs permission to run Blender on this environment.",
                      )
                    : null;
  const retry =
    active && failure !== null
      ? () => {
          void open(true);
        }
      : undefined;
  const name = path.split(/[\\/]/).at(-1) || path;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {name}
          </span>
          {previewUrl ? (
            <span ref={setStatsSlot} className="ml-2 min-w-0 truncate text-muted-foreground" />
          ) : null}
          {active && updating ? (
            <span role="status" className="ml-2 shrink-0 text-muted-foreground">
              {previewUrl ? gt("Updating preview") : gt("Exporting preview")}
            </span>
          ) : null}
        </div>
        {previewUrl ? (
          <div ref={setActionsSlot} className="flex shrink-0 items-center gap-1" />
        ) : null}
      </div>
      {previewUrl ? (
        <>
          {failure ? (
            <p
              role="alert"
              className="border-b border-border px-3 py-1.5 text-2xs text-destructive"
            >
              {failure}{" "}
              {retry ? (
                <button type="button" className="text-foreground underline" onClick={retry}>
                  {gt("Try again")}
                </button>
              ) : null}
            </p>
          ) : null}
          <Suspense>
            <ModelViewer
              src={previewUrl}
              name={name}
              format="glb"
              memoryKey={JSON.stringify([environmentId, threadId, path])}
              viewRequestKey={modelViewRequestKey(thread, path)}
              onRefreshUrl={() => setPreviewRefresh((revision) => revision + 1)}
              linkPath={path}
              composerDraftTarget={thread}
              toolbarSlots={{ stats: statsSlot, actions: actionsSlot }}
            />
          </Suspense>
        </>
      ) : failure ? (
        <FileSurfaceFailure message={failure} {...(retry ? { onRetry: retry } : {})} />
      ) : (
        <p role="status" className="p-6 text-xs text-muted-foreground">
          {active ? gt("Exporting preview") : gt("Loading…")}
        </p>
      )}
    </div>
  );
}

function openErrorText(error: unknown, gt: ReturnType<typeof useGT>): string {
  if (isAuthorizationError(error)) {
    return gt("Previewing .blend files needs permission to run Blender on this environment.");
  }
  if (!isBlenderRequestError(error)) return gt("The environment request failed.");
  switch (error.reason) {
    case "disabled":
      return gt("Blender is off on this environment. Turn it on in Settings, Integrations.");
    case "unavailable":
      return gt(
        "Blender is missing or unsupported on this environment. Check Settings, Integrations.",
      );
    case "file-not-found":
      return gt("This file no longer exists.");
    case "path-not-allowed":
      return gt("Only .blend files in this thread's workspace can be previewed.");
    case "thread-not-found":
      return gt("This thread is no longer available.");
    case "too-many-jobs":
      return gt("Too many Blender jobs are running. Try again when one finishes.");
    default:
      return error.message;
  }
}
