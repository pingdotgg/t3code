import { useState } from "react";

import { readModelViewerPageParams } from "../../modelViewerPage";
import ModelViewer from "./ModelViewer";
import { MODEL_VIEWER_MAX_BYTES, readModelBytes } from "./modelViewerData";

declare global {
  interface Window {
    /** Present when the page runs inside the mobile app's WebView. */
    readonly ReactNativeWebView?: { readonly postMessage: (message: string) => void };
  }
}

/** Tells the mobile app the file cannot be shown in 3D, so it can fall back to the image. */
function reportToApp(reason: string) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "unavailable", reason }));
}

/** Reads the page's fragment once, applying the app's appearance before the first paint. */
function initialParams() {
  // Gestures belong to the viewer; the page itself must never scroll or bounce.
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  const params = readModelViewerPageParams(window.location);
  if (!params) reportToApp(INVALID_LINK);
  else if (params.appearance) {
    document.documentElement.classList.toggle("dark", params.appearance === "dark");
  }
  return params;
}

const INVALID_LINK = "This link does not name a 3D file.";

/** Full-screen 3D view of one file for the mobile app's WebView. */
export default function ModelViewerPage() {
  const [params] = useState(initialParams);
  const [problem, setProblem] = useState<string | null>(null);
  // Stable, so reporting does not recreate the viewer's WebGL context.
  const [onUnavailable] = useState(() => (reason: string) => {
    setProblem(reason);
    reportToApp(reason);
  });

  if (!params || problem !== null) {
    return (
      <main className="fixed inset-0 flex items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
        {problem ?? INVALID_LINK}
      </main>
    );
  }
  return (
    <main className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <ModelViewer
        name={params.name}
        format={params.format}
        loadBytes={async (signal) =>
          readModelBytes(
            await fetch(params.src, { signal, credentials: "omit" }),
            MODEL_VIEWER_MAX_BYTES,
            signal,
          )
        }
        onUnavailable={onUnavailable}
      />
    </main>
  );
}
