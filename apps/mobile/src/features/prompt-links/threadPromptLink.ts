import * as Dialog from "../../components/ui/Dialog";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkPrompt, type LinkedPrompt } from "@t3tools/shared/promptLinks";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { findStackRoute } from "../../lib/appLinking";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, environmentThreads } from "../../state/threads";
import { applyLinkedPromptToThreadDraft } from "./prompt-link-actions";
import {
  promptLinkNotice,
  promptLinkSearchFromParams,
  stepPendingPromptLink,
} from "./prompt-link-model";

const THREAD_LINK_KEYS = ["prompt"];

type PendingThreadLink = { readonly ref: ScopedThreadRef; readonly prompt: LinkedPrompt };

function firstString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

let pendingLink: PendingThreadLink | null = null;
let stopWaitingForShell: (() => void) | null = null;
let stopWaitingForDetail: (() => void) | null = null;

/**
 * `threads/<environment>/<thread>?prompt=…` fills that thread's composer draft. The param is
 * dropped as the link arrives, so the thread screen never sees it and a later visit cannot apply
 * it again. The draft is written only once the thread's screen shows a thread that exists: a
 * screen for an unknown thread replaces itself with a new-thread draft, which drops the link.
 */
export function takeThreadPromptLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!state) return state;
  const index = state.routes.findIndex((route) => route.name === "Thread");
  const route = state.routes[index];
  const params = route?.params as Readonly<Record<string, unknown>> | undefined;
  const search = promptLinkSearchFromParams(params, THREAD_LINK_KEYS);
  if (!route || !params || search === null) return state;
  // A newer link replaces a waiting one even when it turns out to be invalid.
  dropPendingLink();
  const { prompt: _prompt, ...rest } = params;
  const routes = state.routes.slice();
  routes[index] = { ...route, params: rest };
  const nextState = { ...state, routes };

  const environmentId = firstString(params.environmentId);
  const threadId = firstString(params.threadId);
  if (environmentId === null || threadId === null) return nextState;
  const parsed = parseThreadLinkPrompt(search);
  if (!parsed.ok) {
    Dialog.alert("Could not open link", parsed.error);
    return nextState;
  }
  if (parsed.value !== null) {
    pendingLink = {
      ref: { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) },
      prompt: parsed.value,
    };
  }
  return nextState;
}

/** Wired to the navigation container's state changes. */
export function resolvePendingThreadPromptLink(state: NavigationState | undefined): void {
  if (pendingLink === null) return;
  const { ref } = pendingLink;
  // A subagent thread the environment's list leaves out gets a shell once the screen mounts its
  // family. An archived thread never does; the screen shows it from its detail.
  const shellAtom = environmentThreadShells.threadShellAtom(ref);
  const detailAtom = environmentThreads.stateAtom(ref.environmentId, ref.threadId);
  // Read detail only while the screen holds it: opening it here for an unknown thread would keep
  // retrying with no screen to close it.
  const screenHoldsDetail = appAtomRegistry.getNodes().has(detailAtom);
  const step = stepPendingPromptLink(pendingLink, {
    screenOnStack:
      findStackRoute(
        state,
        "Thread",
        (params) =>
          firstString(params?.environmentId) === ref.environmentId &&
          firstString(params?.threadId) === ref.threadId,
      ) !== undefined,
    ready:
      appAtomRegistry.get(shellAtom) !== null ||
      (screenHoldsDetail && detailLoaded(appAtomRegistry.get(detailAtom))),
  });
  if (step.pending === null) dropPendingLink();
  if (step.resolve !== null) {
    const { prompt } = step.resolve;
    void applyLinkedPromptToThreadDraft(
      scopedThreadKey(ref.environmentId, ref.threadId),
      prompt,
      promptLinkNotice({ hiddenCharacters: prompt.hiddenCharacters }),
    );
  } else if (step.pending !== null) {
    stopWaitingForShell ??= appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (shell !== null) resolvePendingThreadPromptLink(rootNavigationRef.getRootState());
    });
    if (screenHoldsDetail) {
      stopWaitingForDetail ??= appAtomRegistry.subscribe(detailAtom, (detail) => {
        if (detailLoaded(detail)) resolvePendingThreadPromptLink(rootNavigationRef.getRootState());
      });
    }
  }
}

function detailLoaded(
  result: AsyncResult.AsyncResult<{ readonly data: Option.Option<unknown> }, unknown>,
): boolean {
  return Option.isSome(Option.flatMap(AsyncResult.value(result), (state) => state.data));
}

function dropPendingLink(): void {
  pendingLink = null;
  stopWaitingForShell?.();
  stopWaitingForShell = null;
  stopWaitingForDetail?.();
  stopWaitingForDetail = null;
}
