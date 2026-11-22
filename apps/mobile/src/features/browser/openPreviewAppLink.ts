import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { appLinkUrl } from "@t3tools/shared/appLinks";
import { parseThreadAppLink } from "@t3tools/shared/threadLinks";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

/**
 * A link the server's browser could not open: a `t3-thread:` link opens its thread here, and any
 * other app link asks first, as the page chose it.
 */
export function openPreviewAppLink(input: {
  readonly url: string;
  /** Where the browser runs; a v1 thread link names no environment of its own. */
  readonly environmentId: EnvironmentId;
  readonly openThread: (ref: ScopedThreadRef) => void;
}) {
  const threadLink = parseThreadAppLink(input.url);
  if (threadLink !== null) {
    input.openThread({
      environmentId: threadLink.environmentId ?? input.environmentId,
      threadId: threadLink.threadId,
    });
    return;
  }
  const url = appLinkUrl(input.url);
  if (url === null) return;
  Dialog.alert(
    m(msg("Open this {protocol} link?"), { protocol: new URL(url).protocol.slice(0, -1) }),
    m(msg("A page in the browser wants to open another application:\n\n{url}"), { url }),
    [
      { text: m(msg("Cancel")), style: "cancel" },
      {
        text: m(msg("Open", { $context: "button, opens a link in another app" })),
        onPress: () => void tryOpenExternalUrl(url),
      },
    ],
  );
}
