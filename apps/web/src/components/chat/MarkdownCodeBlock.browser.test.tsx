import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "../../index.css";

import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

const setWordWrap = (wordWrap: boolean) =>
  act(() => persistClientSettingsPatch({ wordWrap }, async () => {}));

it("follows a changed word wrap default while mounted", async () => {
  await ensureClientSettingsHydrated();
  await setWordWrap(false);
  await using screen = await render(
    <MarkdownCodeBlock
      code="a long line"
      language="text"
      fenceTitle={null}
      theme="light"
      isStreaming={false}
    >
      <pre>
        <code>a long line</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );
  const block = () => screen.container.querySelector(".chat-markdown-codeblock");
  expect(block()?.getAttribute("data-wrap")).toBe("false");

  await setWordWrap(true);
  await expect.element(screen.getByRole("button", { name: "Disable line wrap" })).toBeVisible();
  expect(block()?.getAttribute("data-wrap")).toBe("true");
});
