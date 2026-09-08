import { useEffect, useRef, useState } from "react";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";

type FindHistoryPage = Omit<CitationHistoryPage, "onLoadEarlier"> & {
  readonly onLoadEarlier: () => boolean;
};

/** Search needs every history page, but leaves row mounting to the virtual list. */
export function useThreadFindHistory(
  requestKey: string | null,
  page: FindHistoryPage | null,
): "loading" | "incomplete" | null {
  const requested = useRef<{ key: string; cursors: Set<string>; loading: boolean } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  if (requestKey === null && failedKey !== null) setFailedKey(null);

  useEffect(() => {
    if (requestKey === null) {
      requested.current = null;
      return;
    }
    if (requested.current?.key !== requestKey) {
      requested.current = { key: requestKey, cursors: new Set(), loading: false };
    }
    const wasLoading = requested.current.loading;
    requested.current.loading = page?.loading ?? false;
    if (!page || page.loading || failedKey === requestKey) return;

    const cursor = page.cursor ?? "first";
    // StrictMode replay is not a failed request. Only a completed fetch that
    // leaves the cursor unchanged needs a manual retry.
    if (requested.current.cursors.has(cursor)) {
      if (wasLoading) setFailedKey(requestKey);
      return;
    }
    requested.current.cursors.add(cursor);
    if (!page.onLoadEarlier()) setFailedKey(requestKey);
  }, [failedKey, page, requestKey]);

  if (requestKey === null || page === null) return null;
  return failedKey === requestKey ? "incomplete" : "loading";
}
