import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { deriveProviderInstanceEntries } from "../../providerInstances";

function snapshot(input: {
  driver: ProviderDriverKind;
  instanceId: string;
  installed?: boolean;
  status?: ServerProvider["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    enabled: true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

/** The shape the server publishes while a driver's very first probe runs. */
const pendingOpenCode2 = snapshot({
  driver: ProviderDriverKind.make("opencode2"),
  instanceId: "opencode2",
  installed: false,
  status: "warning",
});

function render(providers: ReadonlyArray<ServerProvider>): string {
  return renderToStaticMarkup(
    <ModelPickerSidebar
      selectedInstanceId="favorites"
      onSelectInstance={() => {}}
      instanceEntries={deriveProviderInstanceEntries(providers)}
    />,
  );
}

function railButton(markup: string, instanceId: string): string {
  const markerIndex = markup.indexOf(`data-model-picker-provider="${instanceId}"`);
  if (markerIndex === -1) return "";
  const markerTagStart = markup.lastIndexOf("<", markerIndex);
  const markerTagEnd = markup.indexOf(">", markerIndex);
  const markerTag = markup.slice(markerTagStart, markerTagEnd + 1);
  if (markerTag.startsWith("<button")) return markerTag;
  const buttonStart = markup.indexOf("<button", markerTagEnd);
  const buttonEnd = markup.indexOf(">", buttonStart);
  return buttonStart === -1 || buttonEnd === -1 ? "" : markup.slice(buttonStart, buttonEnd + 1);
}

describe("ModelPickerSidebar first open", () => {
  it("keeps a pending OpenCode 2 rail entry at full opacity instead of dimming it", () => {
    const markup = render([pendingOpenCode2]);
    const button = railButton(markup, "opencode2");

    expect(markup).toContain('data-provider-icon="opencode2"');
    expect(button).not.toContain("opacity-50");
  });

  it("still refuses selection while that probe is pending, so the scope cannot go empty", () => {
    const button = railButton(render([pendingOpenCode2]), "opencode2");

    expect(button).toContain("disabled=");
    expect(button).toContain("cursor-not-allowed");
    expect(button).toContain("Checking availability");
  });

  it("names the provider and pending state in the accessible label", () => {
    const button = railButton(render([pendingOpenCode2]), "opencode2");

    expect(button).toContain("OpenCode 2");
    expect(button).toContain("Checking availability");
  });

  it("gives another driver with the same snapshot shape the normal unavailable treatment", () => {
    const button = railButton(
      render([
        snapshot({
          driver: ProviderDriverKind.make("opencode"),
          instanceId: "opencode",
          installed: false,
          status: "warning",
        }),
      ]),
      "opencode",
    );

    expect(button).toContain("opacity-50");
    expect(button).toContain("disabled=");
    expect(button).not.toContain("Checking availability");
  });

  it("still dims a settled OpenCode 2 failure", () => {
    const button = railButton(
      render([
        snapshot({
          driver: ProviderDriverKind.make("opencode2"),
          instanceId: "opencode2",
          status: "error",
        }),
      ]),
      "opencode2",
    );

    expect(button).toContain("opacity-50");
    expect(button).toContain("disabled=");
  });

  it("keeps both OpenCode generations as separate rail entries", () => {
    const markup = render([
      snapshot({ driver: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
      snapshot({ driver: ProviderDriverKind.make("opencode2"), instanceId: "opencode2" }),
    ]);

    expect(markup).toContain('data-model-picker-provider="opencode"');
    expect(markup).toContain('data-model-picker-provider="opencode2"');
    expect(markup).toContain('data-provider-icon="opencode"');
    expect(markup).toContain('data-provider-icon="opencode2"');
    expect(markup).not.toContain("data-provider-kind-badge");
  });
});
