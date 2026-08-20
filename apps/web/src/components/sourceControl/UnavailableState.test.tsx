import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { UnavailableState } from "./UnavailableState";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("UnavailableState", () => {
  it("can explain an unsupported environment without offering a futile retry", () => {
    const text = textOf(
      UnavailableState({
        icon: null,
        title: "Issues unavailable",
        error: "Update this environment's T3 Code server to browse issues.",
      }),
    );

    expect(text).toContain("Issues unavailable");
    expect(text).toContain("Update this environment's T3 Code server");
    expect(text).not.toContain("Retry");
  });

  it("retains the retry for transient load failures", () => {
    expect(
      textOf(
        UnavailableState({
          icon: null,
          title: "Could not load issues",
          error: "GitHub did not answer.",
          onRetry: () => {},
        }),
      ),
    ).toContain("Retry");
  });
});
