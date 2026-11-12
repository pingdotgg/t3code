import type { ReactNode } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { RefreshIcon } from "./ui/refresh-icon";
import { StandalonePage } from "./ui/standalone-page";

/**
 * Edits made on defaults after a failed read are never saved, so the app waits for a good read.
 * Until the first read finishes it keeps the boot splash, so no frame paints on defaults.
 */
export function ClientSettingsRecoveryGate({ children }: { readonly children: ReactNode }) {
  const status = useClientSettingsHydrationStatus();
  if (status === "pending") return <BootSplash />;
  if (status !== "failed" && status !== "retrying") return children;
  const retrying = status === "retrying";
  return (
    <StandalonePage size="bare">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Couldn't load your settings</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="standard"
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => void ensureClientSettingsHydrated().catch(() => undefined)}
          >
            <RefreshIcon refreshing={retrying} />
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </EmptyContent>
      </Empty>
    </StandalonePage>
  );
}

/** The splash from index.html, which the first React commit replaces. */
function BootSplash() {
  return (
    <div id="boot-shell">
      <div id="boot-shell-card" aria-label="T3 Code splash screen">
        <img id="boot-shell-logo" src="/apple-touch-icon.png" alt="T3 Code" />
      </div>
    </div>
  );
}
