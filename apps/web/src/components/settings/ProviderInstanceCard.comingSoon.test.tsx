import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";

describe("ProviderInstanceCard coming-soon presentation", () => {
  it("keeps the standard row controls but disables every OpenClaw interaction", () => {
    const driver = ProviderDriverKind.make("openclaw");
    const markup = renderToStaticMarkup(
      <ProviderInstanceCard
        instanceId={ProviderInstanceId.make("openclaw")}
        instance={{ driver, enabled: false }}
        driverOption={getDriverOption(driver)}
        liveProvider={undefined}
        isExpanded={false}
        onExpandedChange={vi.fn()}
        onUpdate={vi.fn()}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={vi.fn()}
        onFavoriteModelsChange={vi.fn()}
        onModelOrderChange={vi.fn()}
        comingSoon
      />,
    );

    expect(markup).toContain("OpenClaw");
    expect(markup).toContain("Soon");
    expect(markup).toContain("OpenClaw agent gateway support is coming soon.");
    expect(markup).toContain('aria-disabled="true"');
    // Base UI mirrors each disabled control onto its hidden form input.
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup).not.toContain("ACP");
    expect(markup).not.toContain("provider-instance-openclaw-display-name");
  });
});
