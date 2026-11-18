import { useGT } from "gt-react";
import {
  blockedAssetUrlState,
  MISSING_FILE_ACCESS_MESSAGE,
} from "@t3tools/client-runtime/state/assets";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { use } from "react";

import type { RightPanelImageSource } from "~/rightPanelStore";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { ImageActionsContext, MediaActions, useMediaActions } from "../media/MediaActions";
import { toastManager } from "../ui/toast";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

export default function ImageFilePreview({
  source,
  threadRef,
}: {
  readonly source: RightPanelImageSource;
  readonly threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const imageActions = use(ImageActionsContext);
  const mediaSource = { kind: "image" as const, ...source };
  const { canReadMedia, assertCanReadMedia } = useMediaActions(mediaSource);
  const fileAccess = useFilesystemReadAccess(source.asset?.environmentId ?? null);
  const blocked = source.file
    ? null
    : blockedAssetUrlState(source.asset?.resource ?? null, fileAccess);
  if (blocked?._tag === "Loading") return <FileSurfaceLoading />;
  if (blocked?._tag === "Failure")
    return <FileSurfaceFailure message={fileAccess.error ?? MISSING_FILE_ACCESS_MESSAGE} />;
  if (!source.file && !source.asset && !source.src)
    return (
      <FileSurfaceFailure
        message={gt("This image is unavailable. Reopen it from the conversation.")}
      />
    );
  return (
    <MediaActions source={mediaSource}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AttachmentFilePreview
          key={source.src ?? "asset"}
          name={source.name}
          mimeType={source.mimeType || source.file?.type || "image/png"}
          sizeBytes={source.file?.size ?? 0}
          {...(source.file ? { file: source.file } : {})}
          {...(source.asset ? { asset: source.asset } : {})}
          src={source.src}
          threadRef={threadRef}
          origin={gt("Image")}
          onEditImage={
            imageActions && canReadMedia
              ? () => {
                  try {
                    assertCanReadMedia();
                    imageActions.assertCurrent();
                    imageActions.edit(mediaSource);
                  } catch (error) {
                    toastManager.add({
                      type: "error",
                      title: gt("Could not edit image"),
                      description:
                        error instanceof Error ? error.message : gt("Try reopening the image."),
                    });
                  }
                }
              : undefined
          }
        />
      </div>
    </MediaActions>
  );
}
