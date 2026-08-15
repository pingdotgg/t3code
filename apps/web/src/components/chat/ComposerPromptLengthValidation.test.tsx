import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";

describe("ComposerPromptLengthValidation", () => {
  it("renders oversized prompt feedback as an actionable composer alert", () => {
    const message = getComposerPromptLengthValidationMessage(
      "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
    );

    const markup = renderToStaticMarkup(<ComposerPromptLengthValidation message={message} />);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-chat-composer-validation="prompt-length"');
    expect(markup).toContain(
      "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.",
    );
    expect(markup).not.toContain("ProviderValidationError");
  });
});
