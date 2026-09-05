import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_TEXT_GENERATION_MODEL, ProviderInstanceId } from "@t3tools/contracts";

import { formatThreadForHandover, makeHandoverModelSelection } from "./ThreadHandover.ts";

describe("thread handover", () => {
  it("pins handover generation to Luna with high reasoning", () => {
    expect(makeHandoverModelSelection(ProviderInstanceId.make("codex"))).toEqual({
      instanceId: "codex",
      model: DEFAULT_TEXT_GENERATION_MODEL,
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(makeHandoverModelSelection(ProviderInstanceId.make("codex-renamed"))).toMatchObject({
      instanceId: "codex-renamed",
      model: DEFAULT_TEXT_GENERATION_MODEL,
    });
  });

  it("formats thread metadata and both sides of the conversation", () => {
    const contents = formatThreadForHandover({
      title: "Continue the migration",
      branch: "feature/migrate",
      worktreePath: "/tmp/migrate",
      messages: [
        { role: "system", text: "System instructions must stay private." },
        { role: "user", text: "Move the worker." },
        { role: "assistant", text: "The worker moved and tests passed." },
      ],
    } as unknown as Parameters<typeof formatThreadForHandover>[0]);

    expect(contents).toContain("Title: Continue the migration");
    expect(contents).toContain("Branch: feature/migrate");
    expect(contents).toContain("## User\n\nMove the worker.");
    expect(contents).toContain("## Assistant\n\nThe worker moved and tests passed.");
    expect(contents).not.toContain("System instructions must stay private.");
  });
});
