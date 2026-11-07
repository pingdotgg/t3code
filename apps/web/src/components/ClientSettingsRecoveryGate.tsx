import type { ReactNode } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { RefreshIcon } from "./ui/refresh-icon";
import { StandalonePage } from "./ui/standalone-page";

/** Edits made on defaults after a failed read are never saved, so the app waits for a good read. */
export function ClientSettingsRecoveryGate({ children }: { readonly children: ReactNode }) {
  const status = useClientSettingsHydrationStatus();
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
