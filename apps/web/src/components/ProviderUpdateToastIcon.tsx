import { DownloadIcon } from "lucide-react";
import type { ProviderDriverKind } from "@t3tools/contracts";

import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";

/**
 * Leading icon for a provider update prompt: the provider's own mark with a
 * download badge in the corner, or a bare download icon when the provider has
 * no mark or the prompt covers several providers.
 */
export function ProviderUpdateToastIcon({ provider }: { provider: ProviderDriverKind | null }) {
  const ProviderIcon = provider === null ? undefined : PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderIcon aria-hidden="true" className="size-4" />
      <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}
