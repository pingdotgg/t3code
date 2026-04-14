import type { Router } from "expo-router";

import type { SelectedThreadRef } from "../state/remote-runtime-types";
import { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<EnvironmentScopedThreadShell, "environmentId" | "id">;
type PlainThreadRouteInput =
  | {
      environmentId: string;
      threadId: string;
    }
  | {
      environmentId: string;
      id: string;
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

export function dismissRoute(router: Router) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
