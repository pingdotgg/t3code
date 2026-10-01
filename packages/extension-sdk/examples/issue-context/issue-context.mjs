import { readContextSnapshots } from "@t3tools/extension-sdk/context";

/**
 * Static public-API fixture. This does not fetch or claim current issue data.
 * @template Renderer
 * @returns {import("@t3tools/extension-sdk/host").Extension<Renderer>}
 */
export function createIssueContextExample() {
  return {
    manifest: {
      id: "example.issue-context",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [],
      composerContexts: [
        {
          id: "example.issue-context/select",
          title: "Issue snapshot (fixture)",
          clients: ["web", "desktop"],
        },
      ],
      messageDecorations: [
        {
          id: "example.issue-context/card",
          title: "Issue snapshot card",
          clients: ["web", "desktop"],
        },
      ],
    },
    surfaces: [],
    composerContexts: [
      {
        id: "example.issue-context/select",
        select: () => ({
          title: "Issue snapshot (fixture)",
          text: "Fixture issue: preserve explicitly selected context through submission, retry, and extension removal.",
          sourceUrl: "https://example.com/issues/context-fixture",
        }),
      },
    ],
    messageDecorations: [
      {
        id: "example.issue-context/card",
        decorate: (message) => {
          const captured = readContextSnapshots(message.text).find(
            (item) => item.snapshot.contributionId === "example.issue-context/select",
          );
          return captured
            ? {
                title: captured.snapshot.title,
                text: captured.snapshot.text,
                ...(captured.snapshot.sourceUrl ? { sourceUrl: captured.snapshot.sourceUrl } : {}),
              }
            : null;
        },
      },
    ],
  };
}
