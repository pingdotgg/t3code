import "~/index.css";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SubagentTooltipContent } from "./SubagentTooltipContent";

const codex = ProviderInstanceId.make("codex");
// The service tier descriptor CodexProvider builds from a catalog with Fast and Ultrafast.
const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6.2-sol",
      name: "GPT-6.2-Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
            currentValue: "medium",
          },
          {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "priority", label: "Fast", description: "1.5x speed, increased usage" },
              { id: "ultrafast", label: "Ultrafast", description: "Even faster, more expensive" },
            ],
            currentValue: "default",
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

it("names the subagent's Ultrafast speed instead of showing only its icon", async () => {
  await using screen = await render(
    <div className="w-80 bg-popover">
      <SubagentTooltipContent
        title="Review refactor diffs"
        model="gpt-6.2-sol"
        providerInstanceId={codex}
        origin="provider_native"
        modelSelection={createModelSelection(codex, "gpt-6.2-sol", [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "ultrafast" },
        ])}
        provider={provider}
        providers={[provider]}
        status="running"
      />
    </div>,
  );
  await expect.element(screen.getByText(/Ultrafast\s*·\s*high/)).toBeVisible();
});
