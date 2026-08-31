import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { InteractionManager, View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { usePreparedConnection } from "../../state/session";
import {
  downloadHandoffFile,
  launchExternalViewer,
  pruneStaleHandoffFiles,
} from "./external-open-handoff";
import { basename } from "./filePath";
import { requestWorkspaceFileAssetUrl } from "./workspaceFileAssetUrl";
import {
  createExternalOpenController,
  type ExternalOpenStatus,
} from "./workspace-file-external-open";

/** The unsupported-preview surface: T3 does not render this file itself, it
    downloads the exact file and hands it to an installed Android app. Mount
    with a `key` on the file path so state resets per file. */
export function WorkspaceFileExternalOpen(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly mimeType: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}) {
  const [status, setStatus] = useState<ExternalOpenStatus>({ _tag: "idle" });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "None" ? null : preparedConnection.value.httpBaseUrl;
  const fileName = basename(props.relativePath);

  // Stale files from a previous session; deferred off the screen transition.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(pruneStaleHandoffFiles);
    return () => task.cancel();
  }, []);

  // The controller holds cross-press state (in-flight guards, abort handle),
  // so the effect owns its lifecycle: setup creates it, cleanup disposes it —
  // unmount aborts the download and keeps a late resolution from launching a
  // viewer, and StrictMode's dev-only cleanup/setup cycle re-arms cleanly.
  const controllerRef = useRef<ReturnType<typeof createExternalOpenController> | null>(null);
  useEffect(() => {
    const controller = createExternalOpenController({
      fileName,
      mimeType: props.mimeType,
      downloadHandoffFile,
      launchViewer: launchExternalViewer,
      onStatusChange: setStatus,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [fileName, props.mimeType]);

  const open = () =>
    void controllerRef.current?.open(async () => {
      if (httpBaseUrl === null) {
        throw new Error("Not connected to the environment.");
      }
      return await requestWorkspaceFileAssetUrl({
        cwd: props.cwd,
        environmentId: props.environmentId,
        httpBaseUrl,
        relativePath: props.relativePath,
        threadId: props.threadId,
      });
    });

  const isPreparing = status._tag === "preparing";
  const detail =
    status._tag === "no-handler"
      ? `No installed app can open ${fileName.slice(fileName.lastIndexOf(".")).toLowerCase()} files.`
      : status._tag === "error"
        ? (status.detail ?? "The file could not be prepared.")
        : "Download the file and open it in a compatible app on this device.";

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        variant="plain"
        title="T3 Code can't preview this file."
        detail={detail}
        actionBusy={isPreparing}
        actionLabel={
          isPreparing
            ? "Preparing file…"
            : status._tag === "error"
              ? "Retry"
              : "Open in another app"
        }
        onAction={open}
      />
    </View>
  );
}
