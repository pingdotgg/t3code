import { Notice } from "../artifacts/Notice";
import { useMediaFileUrl } from "../state/artifacts";
import { PdfPages } from "./PdfPages";
import { absolutePathOf, type FileTarget } from "./target";

export function PdfBody({ target }: { target: FileTarget }) {
  const url = useMediaFileUrl(target.environmentId, target.mediaThreadId, absolutePathOf(target));
  if (url._tag === "Loading") return <Notice>Loading the PDF</Notice>;
  if (url._tag === "Failure") {
    return <Notice tone="text-red-300">The engine could not serve this PDF.</Notice>;
  }
  return <PdfPages url={url.url} />;
}
