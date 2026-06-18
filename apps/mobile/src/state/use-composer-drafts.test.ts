import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { type ComposerDraft, removeComposerDraftsForEnvironment } from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

describe("mobile composer drafts", () => {
  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
    });
  });
});
