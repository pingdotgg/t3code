import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkPrompt, withoutPromptLinkParams } from "@t3tools/shared/promptLinks";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { placeLinkedPrompt } from "./linkedPrompt";

const handledLinkKeys = new Set<string>();

export function ThreadLinkPrompt({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const location = useLocation({
    select: (current) => ({
      key: current.state.__TSR_key ?? current.href,
      pathname: current.pathname,
      search: current.searchStr,
    }),
    structuralSharing: true,
  });

  useEffect(() => {
    if (!new URLSearchParams(location.search).has("prompt")) return;
    if (!handledLinkKeys.has(location.key)) {
      handledLinkKeys.add(location.key);
      const parsed = parseThreadLinkPrompt(location.search);
      if (!parsed.ok) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the linked prompt",
            description: parsed.error,
          }),
        );
      } else if (parsed.value !== null) {
        placeLinkedPrompt(threadRef, parsed.value);
      }
    }
    void navigate({
      href: `${location.pathname}${withoutPromptLinkParams(location.search)}`,
      replace: true,
    });
  }, [location, navigate, threadRef]);

  return null;
}
