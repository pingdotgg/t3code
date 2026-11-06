import type { ReactNode } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import { StandalonePage, StandalonePageHeader } from "./ui/standalone-page";

/** Edits made on defaults after a failed read are never saved, so the app waits for a good read. */
export function ClientSettingsRecoveryGate({ children }: { readonly children: ReactNode }) {
  const status = useClientSettingsHydrationStatus();
  if (status !== "failed" && status !== "retrying") return children;
  const retrying = status === "retrying";
  return (
    <StandalonePage tone="error">
      <StandalonePageHeader
        title="Could not read settings"
        description="Your saved settings could not be loaded."
      />
      <div className="mt-5 flex">
        <Button
          size="sm"
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
