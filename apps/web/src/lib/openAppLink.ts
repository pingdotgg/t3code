import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadAppLink } from "@t3tools/shared/threadLinks";
import { useNavigate } from "@tanstack/react-router";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";

/**
 * A `t3-thread:` link opens its thread here, like a thread link in chat. Any other app link goes to
 * the OS, which the desktop app confirms with the user first.
 */
export async function openAppLink(input: {
  readonly url: string;
  /** Where the link was shown; a v1 thread link names no environment of its own. */
  readonly environmentId: EnvironmentId | null;
  readonly openThread: (ref: ScopedThreadRef) => Promise<void>;
}): Promise<void> {
  const threadLink = parseThreadAppLink(input.url);
  if (threadLink !== null) {
    const environmentId = threadLink.environmentId ?? input.environmentId;
    if (environmentId === null) throw new Error(m(msg("Unable to open link.")));
    await input.openThread({ environmentId, threadId: threadLink.threadId });
    return;
  }
  const api = readLocalApi();
  if (!api) throw new Error(m(msg("Link opening is unavailable.")));
  await api.shell.openAppLink(input.url);
}

/** `openAppLink` for links shown in `environmentId`, opening threads in this window. */
export function useOpenAppLink(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  return (url: string) =>
    openAppLink({
      url,
      environmentId,
      openThread: (ref) =>
        navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ref.environmentId, threadId: ref.threadId },
        }),
    });
}
