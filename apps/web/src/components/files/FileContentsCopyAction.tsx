import { PROJECT_READ_FULL_FILE_MAX_BYTES, type EnvironmentId } from "@t3tools/contracts";
import { Check, Copy } from "lucide";
import { useEffect, useRef, useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { FileSurfaceAction } from "./fileSurfaceChrome";
import { getOptimisticProjectFileQueryData, readFullProjectFile } from "./projectFilesQueryState";

export function FileContentsCopyAction(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly truncated: boolean;
  readonly byteLength: number;
}) {
  const getCurrentFile = () =>
    getOptimisticProjectFileQueryData(props.environmentId, props.cwd, props.relativePath) ?? props;
  const currentFile = getCurrentFile();
  const tooLarge =
    currentFile.truncated && currentFile.byteLength > PROJECT_READ_FULL_FILE_MAX_BYTES;
  const [isReading, setIsReading] = useState(false);
  const pendingRead = useRef<AbortController | null>(null);
  useEffect(() => () => pendingRead.current?.abort(), []);

  const reportError = (error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not copy entire file",
        description: error instanceof Error ? error.message : "The file could not be copied.",
      }),
    );
  };
  const finishRead = (controller: AbortController | undefined) => {
    if (!controller || pendingRead.current !== controller) return;
    pendingRead.current = null;
    if (!controller.signal.aborted) setIsReading(false);
  };
  const { copyToClipboard, copyTextWhenReady, isCopied } = useCopyToClipboard<
    AbortController | undefined
  >({
    target: props.relativePath,
    onCopy: finishRead,
    onError: (error, controller) => {
      finishRead(controller);
      if (!controller?.signal.aborted) reportError(error);
    },
  });

  const copyEntireFile = () => {
    if (pendingRead.current) return;
    const file = getCurrentFile();
    if (file.truncated && file.byteLength > PROJECT_READ_FULL_FILE_MAX_BYTES) return;
    if (!file.truncated) {
      copyToClipboard(file.contents, undefined);
      return;
    }

    const controller = new AbortController();
    pendingRead.current = controller;
    setIsReading(true);
    const contents = readFullProjectFile(
      props.environmentId,
      props.cwd,
      props.relativePath,
      controller.signal,
    );
    copyTextWhenReady(contents, controller);
  };

  return (
    <FileSurfaceAction
      label={isReading ? "Reading file…" : isCopied ? "Copied" : "Copy entire file"}
      {...(tooLarge ? { disabledReason: "Files larger than 16 MB cannot be copied." } : {})}
      disabled={
        tooLarge || isReading || (!currentFile.truncated && currentFile.contents.length === 0)
      }
      onPress={copyEntireFile}
    >
      <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
    </FileSurfaceAction>
  );
}
