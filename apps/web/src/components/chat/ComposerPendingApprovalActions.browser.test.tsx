import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

function renderActions(
  onRespond: () => Promise<undefined>,
  options?: ReadonlyArray<ProviderApprovalOption>,
) {
  return render(
    <ComposerPendingApprovalActions
      requestId={RuntimeRequestId.make("approval-1")}
      canRespond
      isResponding={false}
      options={options}
      onRespondToApproval={onRespond}
    />,
  );
}

const rowLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim())
    .filter(Boolean);

async function openMore(container: HTMLElement) {
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="More approval options"]')!.click(),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions in the row and sends a secondary decision from the menu", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(onRespond);
    expect(rowLabels(screen.container)).toEqual(["Decline", "Approve"]);

    const items = await openMore(screen.container);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Cancel",
      "Always allow this session",
    ]);
    await act(async () => items[1]!.click());
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "acceptForSession");
  });

  it("keeps provider labels, including secondary ones, where the user can find them", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(onRespond, [
      { decision: "decline", label: "Deny" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Allow once" },
    ]);
    expect(rowLabels(screen.container)).toEqual(["Deny", "Allow once"]);
    expect((await openMore(screen.container)).map((item) => item.textContent?.trim())).toEqual([
      "Always allow Safari",
    ]);

    await act(async () =>
      [...screen.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Allow once")!
        .click(),
    );
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "accept");
  });
});
