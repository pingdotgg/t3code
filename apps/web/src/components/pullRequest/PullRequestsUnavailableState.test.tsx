import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

vi.mock("~/i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "pullRequest.loadFailed": "Could not load pull requests",
        "pullRequest.retry": "Retry",
      })[key] ?? key,
  }),
}));

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("PullRequestsUnavailableState", () => {
  it("can explain an unsupported environment without offering a futile retry", () => {
    const text = textOf(
      PullRequestsUnavailableState({
        title: "Pull requests unavailable",
        error: "Update this environment's T3 Code server to browse pull requests.",
      }),
    );

    expect(text).toContain("Pull requests unavailable");
    expect(text).toContain("Update this environment's T3 Code server");
    expect(text).not.toContain("Retry");
  });

  it("retains the retry for transient load failures", () => {
    expect(
      textOf(PullRequestsUnavailableState({ error: "GitHub did not answer.", onRetry: () => {} })),
    ).toContain("Retry");
  });
});
