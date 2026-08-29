import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { ComposerServerUpdateStatus } from "./ComposerServerUpdateStatus";

describe("ComposerServerUpdateStatus", () => {
  it.each([
    ["downloading", "Downloading…"],
    ["installing", "Downloading…"],
    ["resuming", "Restarting…"],
  ] as const)("announces the %s phase inside its parent banner", (stage, label) => {
    const markup = renderToStaticMarkup(
      <ComposerBanner.Root>
        <ComposerBanner.Row>
          <ComposerBanner.Content>
            <ComposerServerUpdateStatus
              state={{ status: "running", stage, fromVersion: "0.0.35", targetVersion: "0.0.36" }}
            />
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain(label);
    expect(markup).toContain("Updating server");
    expect(markup).not.toContain("0.0.35");
    expect(markup.match(/data-composer-banner-surface=/g)).toHaveLength(1);
  });

  it("keeps a failure and its full reason in the same row as Retry", () => {
    const message = "Download failed. The server is still running the previous version.";
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          {
            id: "failure",
            variant: "error",
            icon: null,
            title: (
              <ComposerServerUpdateStatus
                serverLabel="review server"
                state={{
                  status: "failed",
                  stage: "downloading",
                  fromVersion: "0.0.35",
                  targetVersion: "0.0.36",
                  message,
                }}
              />
            ),
            actions: <button type="button">Retry</button>,
          },
        ]}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(message);
    expect(markup).toContain("Could not update review server");
    expect(markup).toContain('data-composer-server-update-status="failed"');
    expect(markup.match(/data-composer-banner-row=/g)).toHaveLength(1);
    expect(markup).not.toContain("composer-banner-children");
    expect(markup).not.toContain("Downloading…");
  });
});
