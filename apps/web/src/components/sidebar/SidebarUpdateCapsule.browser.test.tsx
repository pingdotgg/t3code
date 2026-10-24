import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { updatePlanStore } from "./updateEverythingPlanStore";
import { UpdateEverythingCoordinator, useUpdateEverythingRun } from "./updateEverythingRun";

function Capsule() {
  const run = useUpdateEverythingRun();
  return run && <SidebarUpdateCapsule run={run} local={null} icon={null} />;
}

it("dismisses a completed plan whose retry keeps stale skipped tools skipped", async () => {
  const store = await updatePlanStore();
  await store.discard();
  await store.create({
    schemaVersion: 1,
    id: "stale",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "complete",
    pausedReason: null,
    items: [
      {
        key: "provider:remote:codex",
        kind: "provider",
        environmentId: EnvironmentId.make("remote"),
        label: "Studio",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        driver: null,
        instanceId: null,
        continueThreads: false,
        status: "skipped",
        claimId: null,
        message: "Codex changed before update",
      },
    ],
  });
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UpdateEverythingCoordinator />
      <Capsule />
    </RegistryContext.Provider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Some updates need attention" }));
  await expect.element(page.getByRole("button", { name: "Retry" }).last()).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Dismiss" }));

  await expect.element(screen.getByText("Some updates need attention")).not.toBeInTheDocument();
  expect(await store.read()).toBeNull();
});
