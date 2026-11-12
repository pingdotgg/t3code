import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pipe } from "effect/Function";
import type {
  AssistantCitation,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { useEffect } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
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

type SourceThread = Pick<OrchestrationV2ThreadShell, "lineage"> | null;

function sideChatParentId(sourceThread: SourceThread) {
  return sourceThread?.lineage.sideChat ? sourceThread.lineage.parentThreadId : null;
}

/** Side chat quotes open on their parent thread, where the side chat is a tab. */
export function assistantCitationRoute(citation: AssistantCitation, sourceThread: SourceThread) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: {
      environmentId: citation.environmentId,
      threadId: sideChatParentId(sourceThread) ?? citation.threadId,
    },
    hash: assistantCitationHash(citation),
    resetScroll: false,
  };
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function assistantCitationNavigation(
  citation: AssistantCitation,
  sourceThread: SourceThread,
) {
  return {
    ...assistantCitationRoute(citation, sourceThread),
    state: { assistantCitationActivation: randomUUID() },
  };
}

/**
 * Reveals the location's side chat quote in its tab on `parentThreadId`, moving off the side
 * chat's own route. Links, reloads and late-loading shells all land here, not only clicks.
 */
export function revealSideChatCitation(
  router: Pick<AnyRouter, "navigate" | "state">,
  routeThreadRef: ScopedThreadRef,
  sideChatThreadId: ThreadId,
  parentThreadId: ThreadId,
  activation: string,
) {
  const { location } = router.state;
  const citation = assistantCitationFromLocation(location.href);
  if (
    citation === null ||
    citation.threadId !== sideChatThreadId ||
    citation.environmentId !== routeThreadRef.environmentId ||
    (routeThreadRef.threadId !== parentThreadId && routeThreadRef.threadId !== citation.threadId)
  ) {
    return;
  }
  useRightPanelStore
    .getState()
    .openSideChat(scopeThreadRef(citation.environmentId, parentThreadId), citation.threadId);
  if (routeThreadRef.threadId === parentThreadId) return;
  return router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: citation.environmentId, threadId: parentThreadId },
    hash: true,
    state: (state) => ({ ...state, assistantCitationActivation: activation }),
    replace: true,
    resetScroll: false,
  });
}

export function useSideChatCitationReveal(
  routeThreadRef: ScopedThreadRef | null,
  citation: AssistantCitation | null,
  activation: string,
) {
  const router = useRouter();
  const sourceRef =
    routeThreadRef && citation?.environmentId === routeThreadRef.environmentId
      ? scopeThreadRef(citation.environmentId, citation.threadId)
      : null;
  const parentThreadId = sideChatParentId(useQuietThreadShell(sourceRef));
  const environmentId = routeThreadRef?.environmentId;
  const threadId = routeThreadRef?.threadId;
  const sideChatThreadId = sourceRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a side chat quote's router location and parent right panel once per activation, including after its shell loads
  useEffect(() => {
    if (
      environmentId === undefined ||
      threadId === undefined ||
      sideChatThreadId === undefined ||
      parentThreadId === null
    ) {
      return;
    }
    void revealSideChatCitation(
      router,
      scopeThreadRef(environmentId, threadId),
      sideChatThreadId,
      parentThreadId,
      activation,
    );
  }, [router, environmentId, threadId, sideChatThreadId, parentThreadId, activation]);
}
