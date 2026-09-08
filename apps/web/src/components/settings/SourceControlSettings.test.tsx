import type { GitButlerDiscoveryItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { renderText, setupReactTestRenderer } from "~/test/reactRenderer";

import { GitButlerDiscoveryRow } from "./GitButlerDiscoveryRow";

setupReactTestRenderer();

function item(
  status: GitButlerDiscoveryItem["status"],
  version: string | null = null,
): GitButlerDiscoveryItem {
  return {
    label: "GitButler",
    executable: "but",
    status,
    version: version === null ? Option.none() : Option.some(version),
    minimumVersion: "0.22.3",
    installHint: "Install GitButler on this server.",
    detail:
      status === "incompatible"
        ? Option.some("GitButler 0.22.3 or newer is required.")
        : status === "error"
          ? Option.some("The GitButler version check failed.")
          : Option.none(),
  };
}

describe("GitButler discovery settings", () => {
  it.each([
    ["available", "0.22.3", "Available on this server"],
    ["missing", null, "Not installed"],
    ["incompatible", "0.21.9", "Update required"],
    ["error", null, "Check failed"],
  ] as const)("renders the %s state", (status, version, expected) => {
    const text = renderText(<GitButlerDiscoveryRow item={item(status, version)} />);

    expect(text).toContain(expected);
  });
});
