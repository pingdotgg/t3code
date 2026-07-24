import { ServerIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RemoteEnvironmentIndicator } from "./RemoteEnvironmentIndicator";

describe("RemoteEnvironmentIndicator", () => {
  it("renders the environment name next to an accessible remote icon", () => {
    const markup = renderToStaticMarkup(
      <RemoteEnvironmentIndicator icon={ServerIcon} label="ryzen-shine" iconClassName="size-3.5" />,
    );

    expect(markup).toContain('aria-label="Remote environment: ryzen-shine"');
    expect(markup).toContain("thread-remote-environment-label");
    expect(markup).toContain(">ryzen-shine</span>");
  });
});
