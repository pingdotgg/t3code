import type { PreviewBrowserEngine } from "@t3tools/contracts";
import { AppWindow } from "lucide-react";

import { BROWSER_ENGINE_LABELS } from "~/browser/browserEngines";

interface Props {
  engine: PreviewBrowserEngine;
  url: string;
  loading: boolean;
}

/** Body of a tab whose page renders in a Playwright window on the server host. */
export function EngineWindowNotice({ engine, url, loading }: Props) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <AppWindow className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">
          {loading ? "Loading in" : "Open in"} a {BROWSER_ENGINE_LABELS[engine]} window
        </p>
        <p className="text-xs text-muted-foreground">
          The page renders in a separate window on the machine that runs the server. Use the address
          bar and refresh here. Closing that window closes this tab.
        </p>
        {url ? <p className="break-all text-xs text-muted-foreground">{url}</p> : null}
      </div>
    </div>
  );
}
