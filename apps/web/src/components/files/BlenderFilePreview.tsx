import { useAtomValue } from "@effect/atom-react";
import {
  isBlenderJobTerminal,
  type AssetResource,
  type BlenderJobOutput,
  type BlenderScene,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { lazy, Suspense, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const ModelViewer = lazy(() => import("./ModelViewer"));

export function BlenderFilePreview({
  thread,
  path,
}: {
  readonly thread: ScopedThreadRef;
  readonly path: string;
}) {
  const gt = useGT();
  const { environmentId, threadId } = thread;
  const workflow = useEnvironmentQuery(
    serverEnvironment.blenderWorkflow({ environmentId, input: { threadId } }),
  );
  const setWorkflow = useAtomCommand(serverEnvironment.blenderSetWorkflow);
  const canSetWorkflow = useAtomValue(
    serverEnvironment.blenderSetWorkflow.permissionAtom(environmentId),
  );
  const startJob = useAtomCommand(serverEnvironment.blenderStartJob);
  const inspect = useAtomCommand(serverEnvironment.blenderInspect);
  const cancelJob = useAtomCommand(serverEnvironment.blenderCancelJob);
  const canStart = useAtomValue(serverEnvironment.blenderStartJob.permissionAtom(environmentId));
  const canInspect = useAtomValue(serverEnvironment.blenderInspect.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.blenderCancelJob.permissionAtom(environmentId));
  const stream = useEnvironmentQuery(
    serverEnvironment.blenderJobs({ environmentId, input: { threadId } }),
  );
  const jobs = stream.data?.filter((job) => job.input === path) ?? [];
  const latest = jobs[0];
  const active = jobs.find((job) => !isBlenderJobTerminal(job));
  const newestPreview = jobs.find((job) => job.result?.preview?.current);
  const newestRender = jobs.find((job) => job.result?.render);
  const previewResource: AssetResource | null = newestPreview?.result?.preview
    ? {
        _tag: "blender-output",
        threadId,
        jobId: newestPreview.id,
        output: "preview",
        revision: newestPreview.result.preview.revision,
      }
    : null;
  const renderResource: AssetResource | null = newestRender
    ? { _tag: "blender-output", threadId, jobId: newestRender.id, output: "render" }
    : null;
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewAsset = useAssetUrlState(environmentId, previewResource, String(previewRefresh));
  const renderAsset = useAssetUrlState(environmentId, renderResource);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  if (previewAsset._tag === "Success" && previewAsset.url !== previewUrl) {
    setPreviewUrl(previewAsset.url);
  }
  const [scene, setScene] = useState<BlenderScene | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(output: BlenderJobOutput) {
    setBusy(true);
    try {
      await startJob({ environmentId, input: { threadId, input: path, outputs: [output] } });
    } finally {
      setBusy(false);
    }
  }

  async function inspectScene() {
    setBusy(true);
    try {
      const result = await inspect({ environmentId, input: { threadId, path } });
      if (AsyncResult.isSuccess(result)) setScene(result.value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canSetWorkflow || !workflow.isSuccess}
          onClick={() => {
            void setWorkflow({
              environmentId,
              input: { threadId, active: workflow.data !== true },
            }).then(workflow.refresh);
          }}
        >
          {workflow.data ? gt("Disable Blender tools") : gt("Enable Blender tools")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canInspect || busy}
          onClick={() => void inspectScene()}
        >
          {gt("Inspect scene")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canStart || busy || active !== undefined}
          onClick={() => void start("preview")}
        >
          {gt("Export preview")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canStart || busy || active !== undefined}
          onClick={() => void start("render")}
        >
          {gt("Render")}
        </Button>
        {active ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canCancel}
            onClick={() => void cancelJob({ environmentId, input: { threadId, jobId: active.id } })}
          >
            {gt("Cancel")}
          </Button>
        ) : null}
        {active ? (
          <span role="status" className="text-sm text-muted-foreground">
            {active.status === "queued" ? gt("Queued") : gt("Running")}
          </span>
        ) : null}
      </div>
      {latest?.failure ||
      stream.error ||
      previewAsset._tag === "Failure" ||
      renderAsset._tag === "Failure" ? (
        <p role="alert" className="p-2 text-sm text-destructive">
          {latest?.failure?.message ?? stream.error ?? gt("Preview unavailable")}
        </p>
      ) : null}
      {scene ? (
        <div className="border-b border-border p-2 text-sm">
          <p>{gt("Scene objects: {count}", { count: scene.objectCount })}</p>
          <ul className="max-h-36 overflow-y-auto">
            {scene.objects
              .filter((object) => object.selected)
              .map((object) => (
                <li key={object.name}>
                  {object.name} ({object.type})
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {previewUrl ? (
        <Suspense>
          <ModelViewer
            src={previewUrl}
            name={path.split(/[\\/]/).at(-1) || path}
            format="glb"
            memoryKey={JSON.stringify([environmentId, threadId, path])}
            viewRequestKey={null}
            onRefreshUrl={() => setPreviewRefresh((revision) => revision + 1)}
            linkPath={path}
            composerDraftTarget={thread}
            toolbarSlots={{ stats: null, actions: null }}
          />
        </Suspense>
      ) : null}
      {renderAsset._tag === "Success" ? (
        <img
          className="m-2 max-h-60 object-contain"
          src={renderAsset.url}
          alt={gt("Blender render")}
        />
      ) : null}
    </div>
  );
}
