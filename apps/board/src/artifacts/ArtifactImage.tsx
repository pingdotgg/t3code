import { useArtifactImageUrl } from "../state/artifacts";
import type { Artifact } from "../store/artifacts";
import { useArtifacts } from "./ArtifactsContext";
import { Notice } from "./Notice";

/** An image through a signed media URL, which loads without the app's credentials. */
export function ArtifactImage({ artifact }: { artifact: Artifact }) {
  const { environmentId, mediaThreadId } = useArtifacts();
  const url = useArtifactImageUrl(environmentId, mediaThreadId, artifact.absolutePath);
  if (url._tag === "Loading") return <Notice>Loading the image</Notice>;
  if (url._tag === "Failure") {
    return <Notice tone="text-red-300">The engine could not serve this image.</Notice>;
  }
  return (
    <div className="grid min-h-0 flex-1 scrollbar-gutter-both place-items-center overflow-auto bg-bg p-4">
      <img
        data-testid="viewer-image"
        src={url.url}
        alt={artifact.name}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
