import type { Href, useRouter } from "expo-router";
import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SelectedThreadRef } from "../state/remote-runtime-types";

type Router = ReturnType<typeof useRouter>;

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<EnvironmentThreadShell, "environmentId" | "id">;
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

export function buildThreadFilesRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/files`;
  if (!relativePath) {
    return basePath;
  }

  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length === 0) {
    return basePath;
  }

  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const lineParam =
    Number.isFinite(line) && Number(line) > 0 ? `?line=${Math.floor(Number(line))}` : "";
  return `${basePath}/${encodedPath}${lineParam}`;
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

export function buildThreadFilesNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): Href {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);
  const path = relativePath?.split("/").filter((segment) => segment.length > 0) ?? [];

  if (path.length === 0) {
    return {
      pathname: "/threads/[environmentId]/[threadId]/files",
      params: { environmentId, threadId },
    };
  }

  const params: {
    environmentId: string;
    threadId: string;
    path: string[];
    line?: string;
  } = { environmentId, threadId, path };
  if (Number.isFinite(line) && Number(line) > 0) {
    params.line = String(Math.floor(Number(line)));
  }

  return {
    pathname: "/threads/[environmentId]/[threadId]/files/[...path]",
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
