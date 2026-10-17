import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import {
  parseThreadLinkPrompt,
  threadLinkMessageId,
  withoutPromptLinkParams,
} from "@t3tools/shared/promptLinks";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { randomUUID } from "~/lib/utils";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { placeLinkedPrompt } from "./linkedPrompt";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The message a thread link opened at. See ThreadLinkParams. */
    linkedMessage?: { readonly messageId: string; readonly activation: string };
  }
}

export interface LinkedMessageRequest {
  readonly messageId: MessageId;
  /** Changes with every link that opens, so the same link reveals its message again. */
  readonly key: string;
}

const handledLinkKeys = new Set<string>();

export function ThreadLinkParams({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
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
    const params = new URLSearchParams(location.search);
    if (!params.has("prompt") && !params.has("message")) return;
    if (params.has("prompt") && !handledLinkKeys.has(location.key)) {
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
    const messageId = threadLinkMessageId(location.search);
    void navigate({
      href: `${location.pathname}${withoutPromptLinkParams(location.search)}`,
      replace: true,
      ...(messageId === null
        ? {}
        : { state: { linkedMessage: { messageId, activation: randomUUID() } } }),
    });
  }, [location, navigate, threadRef]);

  return null;
}
