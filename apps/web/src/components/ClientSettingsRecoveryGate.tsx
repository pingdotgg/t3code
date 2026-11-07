import { OctagonAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import { StandalonePage, StandalonePageIcon } from "./ui/standalone-page";

/** Edits made on defaults after a failed read are never saved, so the app waits for a good read. */
export function ClientSettingsRecoveryGate({ children }: { readonly children: ReactNode }) {
  const status = useClientSettingsHydrationStatus();
  if (status !== "failed" && status !== "retrying") return children;
  const retrying = status === "retrying";
  return (
    <StandalonePage size="card">
      <div className="flex items-center gap-3">
        <StandalonePageIcon tone="error">
          <OctagonAlertIcon />
        </StandalonePageIcon>
        <h1 className="min-w-0 flex-1 text-label text-strong-foreground">
          Couldn't load your settings
        </h1>
        <Button
          size="standard"
          variant="secondary"
          disabled={retrying}
          onClick={() => void ensureClientSettingsHydrated().catch(() => undefined)}
        >
          <RefreshIcon refreshing={retrying} />
          Retry
        </Button>
      </div>
    </StandalonePage>
  );
}
