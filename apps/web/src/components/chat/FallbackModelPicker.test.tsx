import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { FallbackModelPicker } from "./FallbackModelPicker";

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

describe("FallbackModelPicker", () => {
  const codexInstance = ProviderInstanceId.make("codex");
  const entry = providerEntry("codex", "codex");
  const modelOptions = new Map([[codexInstance, [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]]]);

  it("renders Fallback: Off when disabled", () => {
    const markup = renderToStaticMarkup(
      <FallbackModelPicker
        fallbackSelection={null}
        activeInstanceId={codexInstance}
        activeModel="gpt-6.1-sol"
        instanceEntries={[entry]}
        modelOptionsByInstance={modelOptions}
        onFallbackSelect={() => {}}
      />,
    );
    expect(markup).toContain("Fallback: Off");
  });

  it("renders Fallback: Auto when auto mode is selected", () => {
    const markup = renderToStaticMarkup(
      <FallbackModelPicker
        fallbackSelection={{ mode: "auto" }}
        activeInstanceId={codexInstance}
        activeModel="gpt-6.1-sol"
        instanceEntries={[entry]}
        modelOptionsByInstance={modelOptions}
        onFallbackSelect={() => {}}
      />,
    );
    expect(markup).toContain("Fallback: Auto");
  });

  it("renders Fallback: <ModelName> when specific model is selected", () => {
    const markup = renderToStaticMarkup(
      <FallbackModelPicker
        fallbackSelection={{
          mode: "specific",
          modelSelection: { instanceId: codexInstance, model: "gpt-6.1-sol" },
        }}
        activeInstanceId={codexInstance}
        activeModel="gpt-6.1-sol"
        instanceEntries={[entry]}
        modelOptionsByInstance={modelOptions}
        onFallbackSelect={() => {}}
      />,
    );
    expect(markup).toContain("Fallback: GPT-6.1-Sol");
  });
});
