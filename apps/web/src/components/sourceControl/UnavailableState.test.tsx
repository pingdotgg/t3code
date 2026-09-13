import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
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

  it("retains the retry and GitHub fallback together", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState
        error="GitHub did not answer."
        onRetry={() => {}}
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/42"
      />,
    );

    expect(html).toContain("Retry");
    expect(html).toContain("Open on GitHub");
    expect(html).toContain('href="https://github.com/pingdotgg/t3code/pull/42"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("can offer the browser without offering a retry", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState
        error="This server cannot read the pull request."
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/9"
      />,
    );

    expect(html).toContain("Open on GitHub");
    expect(html).not.toContain("Retry");
  });

  it("can offer a retry without offering GitHub", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="The host did not answer." onRetry={() => {}} />,
    );

    expect(html).toContain("Retry");
    expect(html).not.toContain("Open on GitHub");
  });

  it("renders no action content without a retry or browser target", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="This project has no known remote." />,
    );

    expect(html).not.toContain('data-slot="empty-content"');
    expect(html).not.toContain("href=");
  });
});
