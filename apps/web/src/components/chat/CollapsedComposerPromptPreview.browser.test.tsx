import "~/index.css";

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { expect, it } from "vite-plus/test";

import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { render } from "../../../test/render";
import { CollapsedComposerPromptPreview } from "./CollapsedComposerPromptPreview";

function quote(text: string, comment?: string): string {
  return serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
    ...(comment === undefined ? {} : { comment }),
  });
}

it("shows quotes, file mentions, context references and skills as chips", async () => {
  const terminal = formatInlineContextReference({
    kind: "terminal",
    contextId: "terminal_1",
    label: "Terminal 1",
  });
  const prompt = `${quote("Cache the parsed config.")} vs ${quote("Retry on 503.", "Also on 429?")} in [package.json](package.json) per ${terminal} with $review-pr please`;

  await using screen = await render(
    <CollapsedComposerPromptPreview
      prompt={prompt}
      skills={[
        { name: "review-pr", displayName: "Review PR", path: "/skills/review-pr", enabled: true },
      ]}
      theme="light"
    />,
    { router: false },
  );
  const { container } = screen;

  const chips = [...container.querySelectorAll('[data-slot="context-chip"]')];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    "Cache the parsed config.",
    "Also on 429?",
    "package.json",
    "Terminal 1",
    "Review PR",
  ]);
  expect(chips.every((chip) => chip.querySelector("svg") !== null)).toBe(true);
  expect(container.textContent).toBe(
    "Cache the parsed config. vs Also on 429? in package.json per Terminal 1 with Review PR please",
  );
  // The row is one tap target that expands the composer, so chips stay inert.
  expect(container.querySelector("button, a, [tabindex]")).toBeNull();
});

it("leaves unknown skills as the text the user typed", async () => {
  await using screen = await render(
    <CollapsedComposerPromptPreview prompt="run $missing now" skills={[]} theme="dark" />,
    { router: false },
  );
  const { container } = screen;

  expect(container.querySelector('[data-slot="context-chip"]')).toBeNull();
  expect(container.textContent).toBe("run $missing now");
});
