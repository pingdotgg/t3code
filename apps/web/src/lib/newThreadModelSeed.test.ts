import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveNewThreadDraftModelSeed,
  shouldHonorProjectDefaultModel,
} from "./newThreadModelSeed";

const CLAUDE_DEFAULT: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};
const CURSOR_CARRY: ModelSelection = {
  instanceId: ProviderInstanceId.make("cursor"),
  model: "gpt-5.4",
};

describe("resolveNewThreadDraftModelSeed", () => {
  it("uses the project default and skips sticky when one is set", () => {
    expect(
      resolveNewThreadDraftModelSeed({
        projectDefaultModelSelection: CLAUDE_DEFAULT,
        carryModelSelection: CURSOR_CARRY,
      }),
    ).toEqual({
      applySticky: false,
      modelSelection: CLAUDE_DEFAULT,
    });
  });

  it("uses the project default even when nothing is carried", () => {
    expect(
      resolveNewThreadDraftModelSeed({
        projectDefaultModelSelection: CLAUDE_DEFAULT,
        carryModelSelection: null,
      }),
    ).toEqual({
      applySticky: false,
      modelSelection: CLAUDE_DEFAULT,
    });
  });

  it("keeps sticky and carry when the project has no default", () => {
    expect(
      resolveNewThreadDraftModelSeed({
        projectDefaultModelSelection: null,
        carryModelSelection: CURSOR_CARRY,
      }),
    ).toEqual({
      applySticky: true,
      modelSelection: CURSOR_CARRY,
    });
  });

  it("treats a missing project default the same as null", () => {
    expect(
      resolveNewThreadDraftModelSeed({
        projectDefaultModelSelection: undefined,
        carryModelSelection: null,
      }),
    ).toEqual({
      applySticky: true,
      modelSelection: null,
    });
  });
});

describe("shouldHonorProjectDefaultModel", () => {
  it("uses the project pin on an unsent draft that has no explicit picker choice", () => {
    expect(
      shouldHonorProjectDefaultModel({
        isLocalDraftThread: true,
        modelSelectionExplicit: undefined,
        projectDefaultModelSelection: CLAUDE_DEFAULT,
      }),
    ).toBe(true);
  });

  it("keeps an explicit picker choice on the draft", () => {
    expect(
      shouldHonorProjectDefaultModel({
        isLocalDraftThread: true,
        modelSelectionExplicit: true,
        projectDefaultModelSelection: CLAUDE_DEFAULT,
      }),
    ).toBe(false);
  });

  it("does not override a started server thread", () => {
    expect(
      shouldHonorProjectDefaultModel({
        isLocalDraftThread: false,
        modelSelectionExplicit: undefined,
        projectDefaultModelSelection: CLAUDE_DEFAULT,
      }),
    ).toBe(false);
  });
});
