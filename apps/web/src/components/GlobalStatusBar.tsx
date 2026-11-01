import { useAtomValue } from "@effect/atom-react";

import { primaryServerProvidersAtom } from "../state/server";
import { CodexUsageStatusBar } from "./chat/CodexUsageStatusBar";

export function GlobalStatusBar() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const codexProviders = providers.filter((provider) => provider.driver === "codex");
  const codex = codexProviders.find((provider) => (provider.usageLimits?.windows.length ?? 0) > 0);
  const configuredCodex = codex ?? codexProviders[0];
  if (!configuredCodex) return null;
  const windows = codex?.usageLimits?.windows ?? [];

  return (
    <footer
      data-app-status-bar
      className="flex h-7 shrink-0 items-center border-t border-border/60 bg-background px-3 text-2xs"
      aria-label="Application status"
    >
      <span className="text-muted-foreground">Codex</span>
      {windows.length > 0 ? (
        <CodexUsageStatusBar windows={windows} />
      ) : (
        <span className="ms-2 text-muted-foreground">Usage limits unavailable</span>
      )}
    </footer>
  );
}
