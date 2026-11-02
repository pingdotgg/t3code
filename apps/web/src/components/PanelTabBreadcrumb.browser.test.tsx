import { useState, type ReactNode } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import {
  PanelTabActions,
  PanelTabSlotsContext,
  usePanelTabActionsHost,
} from "./PanelTabBreadcrumb";

function TabBar({ children }: { children: ReactNode }) {
  const { hasActions, registerActions } = usePanelTabActionsHost();
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  return (
    <>
      {hasActions ? <div ref={setActions} data-testid="actions-notch" /> : null}
      <PanelTabSlotsContext value={{ breadcrumb: null, actions, registerActions }}>
        {children}
      </PanelTabSlotsContext>
    </>
  );
}

function Surface({ actions }: { actions: readonly string[] }) {
  return actions.map((label) => (
    <PanelTabActions key={label}>
      <button type="button">{label}</button>
    </PanelTabActions>
  ));
}

it("draws the actions notch only while a surface provides actions", async () => {
  await using screen = await render(
    <TabBar>
      <Surface actions={[]} />
    </TabBar>,
    { router: false },
  );
  const notch = screen.getByTestId("actions-notch");
  await expect.element(notch).not.toBeInTheDocument();

  await screen.rerender(
    <TabBar>
      <Surface actions={["Wrap", "Refresh"]} />
    </TabBar>,
  );
  await expect.element(notch.getByRole("button", { name: "Wrap" })).toBeVisible();
  await expect.element(notch.getByRole("button", { name: "Refresh" })).toBeVisible();

  await screen.rerender(
    <TabBar>
      <Surface actions={["Refresh"]} />
    </TabBar>,
  );
  await expect.element(notch.getByRole("button", { name: "Refresh" })).toBeVisible();

  await screen.rerender(
    <TabBar>
      <Surface actions={[]} />
    </TabBar>,
  );
  await expect.element(notch).not.toBeInTheDocument();
});
