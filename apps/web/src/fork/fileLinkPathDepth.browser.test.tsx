import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../test/render";
import ChatMarkdown from "../components/ChatMarkdown";
import { collectThreadFindRanges } from "../components/chat/threadFindHighlights";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";

const TEXT = [
  "See [glossary](docs/review-pipeline/glossary.md#L12), [web](src/web/index.ts), [server](src/server/index.ts) and [readme](README.md).",
  "The review is done.",
].join("\n\n");

it("shows the chosen folders before file names, outside thread find", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };
  await using screen = await render(
    <div data-timeline-row-id="row" data-thread-find-text="true">
      <ChatMarkdown cwd="/home/me/project" text={TEXT} />
    </div>,
  );
  const chipTexts = () =>
    [...screen.container.querySelectorAll(".chat-markdown-file-link")].map(
      (chip) => chip.textContent,
    );
  const before = ["glossary.md · L12", "index.ts · src/web", "index.ts · src/server", "README.md"];
  expect(chipTexts()).toEqual(before);
  expect(screen.container.querySelector("[data-thread-find-decoration]")).toBeNull();

  await act(() => persistClientSettingsPatch({ fileLinkPathDepth: 2 }, async () => {}));

  expect(chipTexts()).toEqual(["review-pipeline/glossary.md · L12", ...before.slice(1)]);
  await expect
    .element(
      screen.getByRole("button", { name: "File options for review-pipeline/glossary.md · L12" }),
    )
    .toBeVisible();
  const reviews = collectThreadFindRanges(screen.container, "review");
  expect(reviews).toHaveLength(1);
  expect(
    reviews[0]!.range.startContainer.parentElement?.closest(".chat-markdown-file-link"),
  ).toBeNull();
  expect(collectThreadFindRanges(screen.container, "glossary glossary.md")).toHaveLength(1);
});
