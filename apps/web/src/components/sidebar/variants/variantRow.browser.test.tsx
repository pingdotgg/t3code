import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../../test/render";
import type { SidebarProviderEntry } from "../SidebarThreadRow";
import { RowProviderMark } from "./variantRow";

const entry = (instanceId: string, displayName: string) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    models: [],
  }) as unknown as SidebarProviderEntry;

const personal = entry("codex", "Codex");
const work = entry("codex_work", "Codex Work");

it("tells two instances of one provider apart on the mark", async () => {
  await using screen = await render(
    <RowProviderMark
      entry={work}
      entries={
        new Map([
          ["codex", personal],
          ["codex_work", work],
        ])
      }
      className="size-2"
    />,
  );
  await expect.element(screen.getByText("CW")).toBeInTheDocument();
});

it("adds nothing when the provider has one instance", async () => {
  await using screen = await render(
    <RowProviderMark
      entry={personal}
      entries={new Map([["codex", personal]])}
      className="size-2"
    />,
  );
  expect(screen.container.textContent).toBe("");
});
