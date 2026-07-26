import { describe, expect, it } from "vite-plus/test";

import {
  CREATE_PULL_REQUEST_MESSAGE_SUFFIX,
  applyCreatePullRequestSuffix,
} from "./createPullRequestPrompt.ts";

describe("applyCreatePullRequestSuffix", () => {
  it("appends the instruction to a fresh thread's first message", () => {
    const result = applyCreatePullRequestSuffix({
      text: "Add a settings screen",
      autoCreatePullRequest: true,
      threadHasStarted: false,
    });

    expect(result).toBe("Add a settings screen" + CREATE_PULL_REQUEST_MESSAGE_SUFFIX);
  });

  it("leaves the message alone when the toggle is off", () => {
    expect(
      applyCreatePullRequestSuffix({
        text: "Add a settings screen",
        autoCreatePullRequest: false,
        threadHasStarted: false,
      }),
    ).toBe("Add a settings screen");
  });

  it("stops appending once the thread has started", () => {
    expect(
      applyCreatePullRequestSuffix({
        text: "One more thing",
        autoCreatePullRequest: true,
        threadHasStarted: true,
      }),
    ).toBe("One more thing");
  });

  it("never turns an empty draft into a bare instruction", () => {
    expect(
      applyCreatePullRequestSuffix({
        text: "   ",
        autoCreatePullRequest: true,
        threadHasStarted: false,
      }),
    ).toBe("   ");
  });

  it("is idempotent so re-queued messages do not stack copies", () => {
    const once = applyCreatePullRequestSuffix({
      text: "Add a settings screen",
      autoCreatePullRequest: true,
      threadHasStarted: false,
    });
    const twice = applyCreatePullRequestSuffix({
      text: once,
      autoCreatePullRequest: true,
      threadHasStarted: false,
    });

    expect(twice).toBe(once);
  });
});
