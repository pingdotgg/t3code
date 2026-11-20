import { Notice } from "../artifacts/Notice";
import { useMediaFileUrl } from "../state/artifacts";
import { absolutePathOf, type FileTarget, nameOf } from "./target";

export function ImageBody({ target }: { target: FileTarget }) {
  const url = useMediaFileUrl(target.environmentId, target.mediaThreadId, absolutePathOf(target));
  if (url._tag === "Loading") return <Notice>Loading the image</Notice>;
  if (url._tag === "Failure") {
    return <Notice tone="text-red-300">The engine could not serve this image.</Notice>;
  }
  return (
    <div className="grid min-h-0 flex-1 scrollbar-gutter-both place-items-center overflow-auto bg-bg p-4">
      <img
        data-testid="viewer-image"
        src={url.url}
        alt={nameOf(target.path)}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
