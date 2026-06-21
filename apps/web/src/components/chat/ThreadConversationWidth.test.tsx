import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@effect/vitest";

import {
  ThreadConversationWidthContainer,
  ThreadConversationWidthForm,
} from "./ThreadConversationWidth";

describe("ThreadConversationWidth", () => {
  it("does not apply a default max width to timeline content", () => {
    const markup = renderToStaticMarkup(<ThreadConversationWidthContainer />);

    expect(markup).toContain("t3-thread-conversation-width");
    expect(markup).toContain("max-w-none");
    expect(markup).not.toContain("max-w-3xl");
  });

  it("does not apply a default max width to composer content", () => {
    const markup = renderToStaticMarkup(<ThreadConversationWidthForm variant="composer" />);

    expect(markup).toContain("t3-thread-conversation-width");
    expect(markup).toContain("max-w-none");
    expect(markup).not.toContain("max-w-208");
  });
});
