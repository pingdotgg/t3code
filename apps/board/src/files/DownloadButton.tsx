import { Download } from "lucide-react";
import { useState } from "react";

import { useMediaFileUrl } from "../state/artifacts";
import { Tooltip } from "../ui/Tooltip";
import { actionClass, saveBlob } from "./fileActions";
import { absolutePathOf, type FileTarget, nameOf } from "./target";

/** Saves the file's text, or fetches the engine's attachment URL for a file that has none to hand. */
export function DownloadButton({ target, text }: { target: FileTarget; text: string | null }) {
  const [failure, setFailure] = useState<string | null>(null);
  const url = useMediaFileUrl(
    target.environmentId,
    target.mediaThreadId,
    text === null ? absolutePathOf(target) : null,
    true,
  );
  const name = nameOf(target.path);
  const save = async () => {
    setFailure(null);
    if (text !== null) {
      saveBlob(new Blob([text], { type: "text/plain" }), name);
      return;
    }
    if (url._tag !== "Success") {
      setFailure("The engine could not serve this file.");
      return;
    }
    try {
      const response = await fetch(url.url);
      if (!response.ok) throw new Error(`The engine answered ${response.status}.`);
      saveBlob(await response.blob(), name);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Tooltip text={failure ?? "Download"} side="bottom" align="end">
      <button
        type="button"
        aria-label="Download"
        onClick={() => void save()}
        className={`${actionClass} ${failure === null ? "" : "text-red-300"}`}
      >
        <Download className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}
