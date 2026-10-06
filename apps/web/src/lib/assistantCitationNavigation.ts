import type { AssistantCitation } from "@t3tools/contracts";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { randomUUID } from "./utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantCitationActivation?: string;
  }
}

const CITATION_HASH_PREFIX = "assistant-citation=";

/** Base64url keeps router hash normalization from decoding quote whitespace or source IDs. */
export function assistantCitationHash(citation: AssistantCitation) {
  return `${CITATION_HASH_PREFIX}${Base64Url.encode(formatAssistantCitationHref(citation))}`;
}

export function assistantCitationFromLocation(href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;
  const hash = href.slice(hashIndex + 1);
  if (!hash.startsWith(CITATION_HASH_PREFIX) || hash.length > 140_000) return null;
  try {
    return parseAssistantCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(CITATION_HASH_PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function assistantCitationNavigation(citation: AssistantCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    resetScroll: false,
    state: { assistantCitationActivation: randomUUID() },
  };
}
