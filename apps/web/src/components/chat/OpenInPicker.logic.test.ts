import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileManagerActionForPath, shouldShowOpenInPicker } from "./OpenInPicker.logic";

describe("shouldShowOpenInPicker", () => {
  it("shows both local environments when the primary has a separate WSL home", () => {
    const primaryEnvironmentId = EnvironmentId.make("wsl");
    const hostEnvironmentId = EnvironmentId.make("host");
    for (const [activeThreadEnvironmentId, visible] of [
      [primaryEnvironmentId, true],
      [hostEnvironmentId, true],
      [EnvironmentId.make("other"), false],
    ] as const) {
      expect(
        shouldShowOpenInPicker({
          activeProjectName: "Project",
          activeThreadEnvironmentId,
          primaryEnvironmentId,
          hostEnvironmentId,
          remoteOpenMode: "local-exec",
        }),
      ).toBe(visible);
    }
  });
});

describe("fileManagerActionForPath", () => {
  it("opens only folders and shows a file once its read settled on a server that can", () => {
    for (const [isFolder, isSettled, canReveal, action] of [
      [true, false, false, "open"],
      [false, false, true, "unavailable"],
      [false, true, false, "unavailable"],
      [false, true, true, "reveal"],
    ] as const) {
      expect(fileManagerActionForPath({ isFolder, isSettled, canReveal })).toBe(action);
    }
  });
});
