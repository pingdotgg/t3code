import { NodeId, PlanId, ThreadId } from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";

import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import { ThreadDetailsTasks } from "./ThreadDetailsTasks";

it("describes a pending step as not started in Chinese", async () => {
  initializeI18n(() => {});
  const translations = await getTranslationsSnapshot("zh");
  try {
    await using screen = await render(
      <GTProvider locale="zh" translations={translations}>
        <ThreadDetailsTasks
          compact={false}
          plan={{
            kind: "todo_list",
            id: PlanId.make("task-plan"),
            threadId: ThreadId.make("task-thread"),
            runId: null,
            nodeId: NodeId.make("task-node"),
            status: "active",
            steps: [{ id: "step", text: "检查测试", status: "pending" }],
          }}
        />
      </GTProvider>,
    );

    await expect.element(screen.getByRole("listitem")).toHaveTextContent("未开始: 检查测试");
  } finally {
    initializeI18n(() => {});
  }
});
