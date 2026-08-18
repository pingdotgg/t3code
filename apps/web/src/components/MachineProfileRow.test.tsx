import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MachineProfileRow } from "./MachineProfileRow";

describe("MachineProfileRow", () => {
  it("renders the machine path and draft execution details", () => {
    const markup = renderToStaticMarkup(
      <MachineProfileRow
        environment={{
          label: "Mini PC",
          isPrimary: false,
          workspaceRoot: "C:/Users/lucas/Projects/t3code",
          connection: "connected",
          profile: {
            branchLabel: "feature/remote",
            workspaceLabel: "C:/Users/lucas/Projects/t3code/.t3/worktrees/remote",
            providerLabel: "codex",
            modelLabel: "gpt-5.4",
            executionLabel: "Full access · Build",
            startFromOrigin: true,
          },
        }}
      />,
    );

    expect(markup).toContain("Mini PC");
    expect(markup).toContain("C:/Users/lucas/Projects/t3code");
    expect(markup).toContain("feature/remote");
    expect(markup).toContain("gpt-5.4");
    expect(markup).toContain("Full access");
    expect(markup).toContain('aria-label="C:/Users/lucas/Projects/t3code"');
  });

  it("marks a disconnected machine as unavailable", () => {
    const markup = renderToStaticMarkup(
      <MachineProfileRow
        environment={{
          label: "Laptop",
          isPrimary: true,
          workspaceRoot: "C:/repo",
          connection: "unavailable",
          profile: {
            branchLabel: "Current checkout",
            workspaceLabel: "Current checkout",
            providerLabel: "Project default",
            modelLabel: "Project default",
            executionLabel: "Project defaults",
            startFromOrigin: false,
          },
        }}
      />,
    );

    expect(markup).toContain("Unavailable");
  });
});
