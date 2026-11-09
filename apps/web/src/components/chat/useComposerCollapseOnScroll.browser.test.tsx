import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { setPluginComposerCollapseOnScroll } from "../../plugins/pluginRegistry";
import { pluginUiAtom } from "../../plugins/pluginUi";
import { pluginUi } from "../../plugins/pluginUiParts";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useComposerCollapseOnScroll } from "./useComposerCollapseOnScroll";
import { timelineAwayFromEndAtom } from "./useTimelineFollow";

const threadRef = scopeThreadRef(EnvironmentId.make("environment:fold"), ThreadId.make("thread"));
const awayFromEnd = timelineAwayFromEndAtom(scopedThreadKey(threadRef));

function Composer({ wideScreen, canFold = true }: { wideScreen: boolean; canFold?: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [focused, setFocused] = useState(false);
  const fold = useComposerCollapseOnScroll({ wideScreen, threadRef, formRef, canFold, focused });
  return (
    <form ref={formRef} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <div role="textbox" aria-label="Message" contentEditable suppressContentEditableWarning />
      <p>{fold.awayFromEnd ? "Folded" : "Open"}</p>
    </form>
  );
}

describe("useComposerCollapseOnScroll", () => {
  it("folds a focused composer when the timeline leaves its end, on wide screens only", async () => {
    // The composer reads the request through the plugin UI, which the loader publishes.
    appAtomRegistry.set(pluginUiAtom, pluginUi);
    using _ui = { [Symbol.dispose]: () => appAtomRegistry.set(pluginUiAtom, null) };
    setPluginComposerCollapseOnScroll("test-plugin", true);
    using _request = {
      [Symbol.dispose]: () => setPluginComposerCollapseOnScroll("test-plugin", false),
    };
    using _away = { [Symbol.dispose]: () => appAtomRegistry.set(awayFromEnd, false) };
    await using screen = await render(
      <AppAtomRegistryProvider>
        <Composer wideScreen />
      </AppAtomRegistryProvider>,
    );
    const message = page.getByRole("textbox", { name: "Message" });
    await userEvent.click(message);

    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Folded")).toBeVisible();
    expect(document.activeElement).not.toBe(message.element());

    // Focusing it opens it until the reader's next scroll, so a later blur can't fold it.
    await userEvent.click(message);
    await expect.element(page.getByText("Open")).toBeVisible();
    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Folded")).toBeVisible();

    appAtomRegistry.set(awayFromEnd, false);
    await expect.element(page.getByText("Open")).toBeVisible();

    // A composer that cannot fold, such as one holding a multi-line prompt, keeps its caret.
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Composer wideScreen canFold={false} />
      </AppAtomRegistryProvider>,
    );
    await userEvent.click(message);
    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Folded")).toBeVisible();
    expect(document.activeElement).toBe(message.element());
    appAtomRegistry.set(awayFromEnd, false);

    // Phones fold on their own when the composer loses focus.
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Composer wideScreen={false} />
      </AppAtomRegistryProvider>,
    );
    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Open")).toBeVisible();
  });
});
