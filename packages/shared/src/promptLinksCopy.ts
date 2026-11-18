import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  type LinkedPrompt,
  type NewThreadLink,
  parseNewThreadLink as parseNewThreadLinkWith,
  parseThreadLinkPrompt as parseThreadLinkPromptWith,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  type PromptLinkError,
  type PromptLinkResult,
} from "./promptLinks.ts";
import { appName } from "./appName.ts";

function promptLinkErrorMessage(error: PromptLinkError, resolve: MFunctionType): string {
  switch (error) {
    case "prompt-too-long":
      return resolve(
        msg("This prompt is longer than {maxLength} characters, so {appName} did not open it.", {
          appName: appName(),
          maxLength: PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US"),
        }),
      );
    case "prompt-only-hidden":
      return resolve(
        msg(
          "This prompt had only hidden characters, so it may be malicious. {appName} did not open it.",
          { appName: appName() },
        ),
      );
    case "unreadable-pull-request":
      return resolve(
        msg("This link names a pull request {appName} cannot read.", { appName: appName() }),
      );
    case "missing-prompt":
      return resolve(msg("This link has no prompt."));
    case "unreadable-repository":
      return resolve(
        msg("This link names a repository {appName} cannot read.", { appName: appName() }),
      );
  }
}

/** @public */
export function parseNewThreadLink(
  search: string,
  resolve: MFunctionType = mFallback,
): PromptLinkResult<NewThreadLink> {
  return parseNewThreadLinkWith(search, (error) => promptLinkErrorMessage(error, resolve));
}

/** @public */
export function parseThreadLinkPrompt(
  search: string,
  resolve: MFunctionType = mFallback,
): PromptLinkResult<LinkedPrompt | null> {
  return parseThreadLinkPromptWith(search, (error) => promptLinkErrorMessage(error, resolve));
}
