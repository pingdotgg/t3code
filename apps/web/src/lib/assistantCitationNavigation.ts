import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pipe } from "effect/Function";
import type { AssistantCitation, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { readThreadShell } from "~/state/entities";
import { openSideChatTab } from "./sideChatPane";
import { randomUUID } from "./utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantCitationActivation?: string;
  }
}

const CITATION_HASH_PREFIX = "assistant-citation=";

/** Base64url keeps router hash normalization from decoding quote whitespace or source IDs. */
function assistantCitationHash(citation: AssistantCitation) {
  return `${CITATION_HASH_PREFIX}${Base64Url.encode(formatAssistantCitationHref(citation))}`;
}

export function assistantCitationFromLocation(href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;
  const hash = href.slice(hashIndex + 1);
  if (!hash.startsWith(CITATION_HASH_PREFIX) || hash.length > 140_000) return null;
  try {
    return pipe(
      hash.slice(CITATION_HASH_PREFIX.length),
      Base64Url.decodeString,
      Result.getOrThrow,
      parseAssistantCitationHref,
    );
  } catch {
    return null;
  }
}

/** Return paths drop the quote hash so going back does not reveal its source again. */
export function withoutAssistantCitationHash(href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1 || !href.startsWith(CITATION_HASH_PREFIX, hashIndex + 1)) return href;
  return href.slice(0, hashIndex);
}

/** A side chat has no route of its own, so its quotes open on its parent thread. */
export function assistantCitationRoute(
  citation: AssistantCitation,
  sourceThread: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
) {
  const parentThreadId = sourceThread?.lineage.sideChat
    ? sourceThread.lineage.parentThreadId
    : null;
  return {
    to: "/$environmentId/$threadId" as const,
    params: {
      environmentId: citation.environmentId,
      threadId: parentThreadId ?? citation.threadId,
    },
    hash: assistantCitationHash(citation),
    resetScroll: false,
  };
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function assistantCitationNavigation(citation: AssistantCitation) {
  const sourceThread = readThreadShell(scopeThreadRef(citation.environmentId, citation.threadId));
  const route = assistantCitationRoute(citation, sourceThread);
  openSideChatTab(scopeThreadRef(route.params.environmentId, route.params.threadId), sourceThread);
  return { ...route, state: { assistantCitationActivation: randomUUID() } };
}
