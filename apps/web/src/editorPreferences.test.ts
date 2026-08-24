import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Translate } from "./i18n";
import {
  localizedPreferredEditorErrorMessage,
  PreferredEditorEnvironmentRequiredError,
  PreferredEditorUnavailableError,
} from "./editorPreferences";

const mappedTranslate = ((key, values) =>
  `${key}:${values?.targetPath ?? ""}:${values?.environmentId ?? ""}`) as Translate;

describe("localizedPreferredEditorErrorMessage", () => {
  it("maps a missing environment without translating the target path", () => {
    const error = new PreferredEditorEnvironmentRequiredError({
      targetPath: "/workspace/README.md",
    });

    expect(localizedPreferredEditorErrorMessage(error, mappedTranslate)).toBe(
      "editorPreferences.environmentRequired:/workspace/README.md:",
    );
    expect(error.message).toBe(
      "Cannot open /workspace/README.md because no environment is selected.",
    );
  });

  it("maps an unavailable editor without translating path or environment ID", () => {
    const error = new PreferredEditorUnavailableError({
      environmentId: EnvironmentId.make("env-local"),
      targetPath: "/workspace/src/index.ts",
      availableEditorIds: [],
    });

    expect(localizedPreferredEditorErrorMessage(error, mappedTranslate)).toBe(
      "editorPreferences.editorUnavailable:/workspace/src/index.ts:env-local",
    );
    expect(error.message).toBe(
      "No available editor can open /workspace/src/index.ts in environment env-local.",
    );
  });
});
