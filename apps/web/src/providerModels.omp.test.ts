import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OmpIcon } from "./components/Icons";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  PROVIDER_ICON_BY_PROVIDER,
} from "./components/chat/providerIconUtils";
import { getDefaultServerModel } from "./providerModels";

const OMP = ProviderDriverKind.make("omp");

describe("Oh My Pi provider model presentation", () => {
  it("lists OMP as an independent available provider", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)).toContain(OMP);
    expect(PROVIDER_ICON_BY_PROVIDER[OMP]).toBe(OmpIcon);
  });

  it("uses the first model discovered by the OMP RPC snapshot", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("omp"),
      driver: OMP,
      enabled: true,
      models: [
        {
          slug: "openai-codex/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    } as unknown as ServerProvider;

    expect(getDefaultServerModel([provider], OMP)).toBe("openai-codex/gpt-5.6-sol");
  });
});
