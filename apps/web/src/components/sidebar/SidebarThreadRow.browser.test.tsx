import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarSearchResultRow } from "./SidebarThreadRow";

vi.mock("../../portDiscoveryState", () => ({
  useThreadDiscoveredPorts: () => [{ port: 3000 }, { port: 4000 }, { port: 5000 }],
}));

it("announces running ports when navigating a search result with an explicit name", async () => {
  const initial = getClientSettings();
  using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(initial) };
  __setClientSettingsForTests({ ...initial, sidebarShowPorts: true });
  await using screen = await render(
    <ul role="listbox" aria-label="Threads">
      <SidebarSearchResultRow
        thread={makeThreadFixture({ title: "Dev server" })}
        project={null}
        projectDisplayName={null}
        environmentLabel={null}
        environmentMachine="desktop"
        providerEntryByInstanceId={new Map()}
        isSettled={false}
        isHighlighted={false}
        isRouteActive={false}
        resultId="port-result"
        searchMatch={null}
        searchQuery="Dev"
        onHighlight={vi.fn()}
        onSelect={vi.fn()}
        onFileDropThreads={vi.fn()}
      />
    </ul>,
  );

  await expect
    .element(screen.getByRole("option", { name: "Dev server" }))
    .toHaveAccessibleDescription("Running ports: 3000, 4000, 5000");
});
