import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import type { ComposerDraft } from "./use-composer-drafts";
import { resolveThreadComposerModelSelection } from "./thread-composer-model";

const original: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const phone: ModelSelection = { ...original, model: "gpt-5.6-sol" };
const draft: ComposerDraft = {
  text: "unsent phone message",
  attachments: [],
  modelSelection: phone,
  modelSelectionBase: original,
};

describe("thread composer model synchronization", () => {
  it("keeps a new phone selection until the shared model changes", () => {
    expect(resolveThreadComposerModelSelection(draft, { ...original })).toEqual(phone);
    expect(resolveThreadComposerModelSelection({ ...draft, text: "" }, original)).toEqual(phone);
  });

  it.each([
    { ...original, model: "gpt-5.6-astra" },
    { ...original, options: [{ id: "reasoningEffort", value: "high" }] },
    { ...original, instanceId: ProviderInstanceId.make("codex-personal") },
  ])("follows a PC change to model, options, or provider instance: %j", (pc) => {
    expect(resolveThreadComposerModelSelection(draft, pc)).toEqual(pc);
    expect(resolveThreadComposerModelSelection({ ...draft, text: "" }, pc)).toEqual(pc);
  });

  it("follows the shared model after the phone's selection is confirmed", () => {
    expect(resolveThreadComposerModelSelection(draft, phone)).toEqual(phone);
    const pc = { ...original, model: "gpt-5.6-astra" };
    expect(resolveThreadComposerModelSelection(draft, pc)).toEqual(pc);
  });

  it("ignores a last-sent selection retained by older mobile builds", () => {
    const legacy = { text: "", attachments: [], modelSelection: phone };
    expect(resolveThreadComposerModelSelection(legacy, original)).toEqual(original);
  });

  it("preserves explicit models on recovered messages and legacy unsent drafts", () => {
    expect(
      resolveThreadComposerModelSelection({ ...draft, modelSelectionBase: undefined }, original),
    ).toEqual(phone);
  });

  it("uses the thread model when no local selection exists", () => {
    expect(resolveThreadComposerModelSelection(undefined, original)).toEqual(original);
    expect(resolveThreadComposerModelSelection(undefined, null)).toBeNull();
  });
});
