import { EnvironmentId, type OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { V2LifecycleRow } from "./V2LifecycleRow";

const renderCreated = (title: string, resourceSummary: boolean) =>
  render(
    <V2LifecycleRow
      environmentId={EnvironmentId.make("env")}
      item={
        {
          type: "thread_created",
          title,
          targetThreadId: ThreadId.make("child"),
        } as unknown as OrchestrationV2TurnItem
      }
      resourceSummary={resourceSummary}
      runs={[]}
      onOpenThread={() => {}}
    />,
  );

it.each([true, false])(
  "reads a Hebrew created-thread title right to left (summary card: %s)",
  async (resourceSummary) => {
    await using screen = await renderCreated("סיכום פגישה: Roadmap לרבעון הבא", resourceSummary);
    await expect
      .element(screen.getByText(/סיכום פגישה/))
      .toHaveStyle({ direction: "rtl", textAlign: "left" });
    await expect.element(screen.getByRole("button")).toHaveStyle({ direction: "ltr" });
  },
);

it("leaves an English created-thread title left to right", async () => {
  await using screen = await renderCreated("Weekly roadmap review", true);
  await expect.element(screen.getByText("Weekly roadmap review")).toHaveStyle({ direction: "ltr" });
});
