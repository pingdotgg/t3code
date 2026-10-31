import { EnvironmentId, ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

function commandItem(id: string, description: string): ComposerCommandItem {
  return {
    id,
    type: "slash-command",
    command: "model",
    label: `/${id}`,
    description,
  };
}

function skillItem(
  id: string,
  description: string,
  skill: Partial<ServerProviderSkill> = {},
): ComposerCommandItem {
  return {
    id,
    type: "skill",
    provider: ProviderDriverKind.make("claudeAgent"),
    skill: { name: id, path: `/skills/${id}/SKILL.md`, enabled: true, description, ...skill },
    label: `/skill:${id}`,
    description,
  };
}

function menu(item: ComposerCommandItem, detailItem: ComposerCommandItem | null) {
  return (
    <ComposerCommandMenu
      listId="suggestions"
      environmentId={EnvironmentId.make("environment-1")}
      items={[item]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind={item.type === "skill" ? "skill" : "slash-command"}
      activeItemId={item.id}
      detailItem={detailItem}
      onHighlightedItemChange={() => {}}
      onShowDetail={() => {}}
      onCloseDetail={() => {}}
      onSelect={() => {}}
    />
  );
}

function container(width: string) {
  const element = document.createElement("div");
  element.style.width = width;
  return element;
}

function detailButton(root: HTMLElement, item: ComposerCommandItem) {
  return root.querySelector(`[aria-label^="Show details for ${item.label}"]`);
}

describe("ComposerCommandMenu detail button", () => {
  it("appears on a command only when its description is cut off", async () => {
    const short = commandItem("short", "Fits");
    await using shortScreen = await render(menu(short, null), { container: container("360px") });
    expect(detailButton(shortScreen.container, short)).toBeNull();

    const long = commandItem("long", "A description that keeps going ".repeat(10));
    await using longScreen = await render(menu(long, null), { container: container("360px") });
    expect(detailButton(longScreen.container, long)).not.toBeNull();
  });

  it("appears on the active command once a narrower menu cuts its description off", async () => {
    const item = commandItem("narrowed", "A description that fits on one line only in a wide menu");
    await using screen = await render(menu(item, null), { container: container("1600px") });
    expect(detailButton(screen.container, item)).toBeNull();

    screen.container.style.width = "260px";
    await vi.waitFor(() => expect(detailButton(screen.container, item)).not.toBeNull());
  });

  it("appears on every skill, even when its description fits", async () => {
    const item = skillItem("tidy", "Fits");
    await using screen = await render(menu(item, null), { container: container("360px") });
    expect(detailButton(screen.container, item)).not.toBeNull();
  });
});

describe("ComposerCommandMenu detail panel", () => {
  it("shows a skill's full description rather than its short one", async () => {
    const item = skillItem("release", "Short summary", {
      shortDescription: "Short summary",
      description: "The full description with every detail",
    });
    await using screen = await render(menu(item, item), { container: container("360px") });
    expect(screen.container.textContent).toContain("The full description with every detail");
    expect(screen.container.textContent).not.toContain("Short summary");
  });
});
