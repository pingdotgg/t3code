import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";

import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

it.each([
  { lineEnd: 7, label: "ターミナル 2 7 行目" },
  { lineEnd: 9, label: "ターミナル 2 7–9 行目" },
])("shows the exact Japanese line label $label", async ({ lineEnd, label }) => {
  initializeI18n(() => {});
  const translations = await getTranslationsSnapshot("ja");
  await using screen = await render(
    <GTProvider locale="ja" translations={translations}>
      <TerminalContextInlineChip
        terminalLabel="ターミナル 2"
        lineStart={7}
        lineEnd={lineEnd}
        text="terminal output"
        detailsMode="popover"
      />
    </GTProvider>,
  );

  await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
});
