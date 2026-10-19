import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

let root: Root;
let container: HTMLDivElement;
const onRespond = vi.fn(async () => undefined);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onRespond.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(options?: ReadonlyArray<ProviderApprovalOption>) {
  await act(async () =>
    root.render(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-1")}
        canRespond
        isResponding={false}
        options={options}
        onRespondToApproval={onRespond}
      />,
    ),
  );
}

const rowLabels = () =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim())
    .filter(Boolean);

async function openMore() {
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="More approval options"]')!.click(),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions in the row and sends a secondary decision from the menu", async () => {
    await render();
    expect(rowLabels()).toEqual(["Decline", "Approve"]);

    const items = await openMore();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Cancel",
      "Always allow this session",
    ]);
    await act(async () => items[1]!.click());
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "acceptForSession");
  });

  it("keeps provider labels, including secondary ones, where the user can find them", async () => {
    await render([
      { decision: "decline", label: "Deny" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Allow once" },
    ]);
    expect(rowLabels()).toEqual(["Deny", "Allow once"]);
    expect((await openMore()).map((item) => item.textContent?.trim())).toEqual([
      "Always allow Safari",
    ]);

    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Allow once")!
        .click(),
    );
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "accept");
  });
});
