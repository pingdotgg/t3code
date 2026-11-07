import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { childInputNowItem } from "./ThreadActivityBanners";

it("opens a delegated child's approval on the environment it runs on", async () => {
  const remoteEnvironmentId = EnvironmentId.make("remote-environment");
  const childId = ThreadId.make("remote-helper");
  // The item reads only these fields.
  const child = {
    id: childId,
    environmentId: remoteEnvironmentId,
    title: "Reference test on remote",
    hasPendingApprovals: true,
    lineage: { sideChat: false },
  } as EnvironmentThreadShell;
  const onOpenThread = vi.fn();
  const item = childInputNowItem({
    childThreadInputs: [child],
    parentAwaitingUser: false,
    onOpenThread,
  });

  await using screen = await render(<>{item?.actions}</>);
  await screen.getByRole("button", { name: "Open approval" }).click();

  expect(onOpenThread).toHaveBeenCalledWith(childId, remoteEnvironmentId);
});
