import type { Href, Router } from "expo-router";
import type { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SelectedThreadRef } from "../state/remote-runtime-types";

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<EnvironmentScopedThreadShell, "environmentId" | "id">;
type PlainThreadRouteInput =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
    }
  | {
      environmentId: EnvironmentId;
      id: ThreadId;
    };

export function buildThreadRoutePath(input: ThreadRouteInput | PlainThreadRouteInput): string {
  const environmentId = input.environmentId;
  const threadId = "threadId" in input ? input.threadId : input.id;

  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function buildThreadReviewRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
): string {
  return `${buildThreadRoutePath(input)}/review`;
}

export function buildThreadTerminalRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/terminal`;
  if (!terminalId) {
    return basePath;
  }

  return `${basePath}?terminalId=${encodeURIComponent(terminalId)}`;
}

/**
 * Prefer this over {@link buildThreadTerminalRoutePath} with `router.push(string)` — Expo Router
 * often does not merge query strings into `useLocalSearchParams`, which breaks terminal bootstrap
 * (`requestedTerminalId` stays null while the UI assumes `default`).
 */
export function buildThreadTerminalNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): Href {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);

  const params: { environmentId: string; threadId: string; terminalId?: string } = {
    environmentId,
    threadId,
  };

  if (terminalId != null && terminalId !== "") {
    params.terminalId = terminalId;
  }

  return {
    pathname: "/threads/[environmentId]/[threadId]/terminal",
    params,
  };
}

export function dismissRoute(router: Router) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
