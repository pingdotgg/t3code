import { ServerIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  RemoteEnvironmentIndicator,
  shouldShowRemoteEnvironmentIndicator,
} from "./RemoteEnvironmentIndicator";

describe("RemoteEnvironmentIndicator", () => {
  it("renders the environment name next to an accessible remote icon", () => {
    const markup = renderToStaticMarkup(
      <RemoteEnvironmentIndicator icon={ServerIcon} label="ryzen-shine" iconClassName="size-3.5" />,
    );

    expect(markup).toContain('aria-label="Remote environment: ryzen-shine"');
    expect(markup).toContain("thread-remote-environment-label");
    expect(markup).toContain(">ryzen-shine</span>");
    expect(markup.indexOf(">ryzen-shine</span>")).toBeLessThan(markup.indexOf("<svg"));
  });

  it("only identifies non-local secondary environments as remote", () => {
    expect(
      shouldShowRemoteEnvironmentIndicator({
        currentEnvironmentId: "primary",
        threadEnvironmentId: "remote",
        isDesktopLocal: false,
      }),
    ).toBe(true);
    expect(
      shouldShowRemoteEnvironmentIndicator({
        currentEnvironmentId: "primary",
        threadEnvironmentId: "wsl",
        isDesktopLocal: true,
      }),
    ).toBe(false);
    expect(
      shouldShowRemoteEnvironmentIndicator({
        currentEnvironmentId: "primary",
        threadEnvironmentId: "primary",
        isDesktopLocal: false,
      }),
    ).toBe(false);
  });
});
