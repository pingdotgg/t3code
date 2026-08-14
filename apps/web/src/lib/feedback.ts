import type { LocalApi } from "@t3tools/contracts";
import { buildFeedbackIssueUrl } from "@t3tools/shared/feedback";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { ensureLocalApi } from "../localApi";

interface FeedbackBrowserMetadata {
  readonly platform: string;
  readonly userAgent: string;
}

export function buildWebFeedbackIssueUrl(input: {
  readonly appVersion: string;
  readonly isDesktop: boolean;
  readonly navigator: FeedbackBrowserMetadata;
}): string {
  return buildFeedbackIssueUrl({
    appVersion: input.appVersion,
    surface: input.isDesktop ? "T3 Code Desktop" : "T3 Code Web",
    platform: [input.navigator.platform, input.navigator.userAgent]
      .map((detail) => detail.trim())
      .filter(Boolean)
      .join("; "),
  });
}

export function openFeedbackIssueForm(
  shell: Pick<LocalApi["shell"], "openExternal"> = ensureLocalApi().shell,
): Promise<void> {
  const url = buildWebFeedbackIssueUrl({
    appVersion: APP_VERSION,
    isDesktop: isElectron,
    navigator,
  });
  return shell.openExternal(url);
}
