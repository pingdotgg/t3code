import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { useComposerMenuItems } from "./useComposerMenuItems";

function SlashMenu(props: {
  folderMoveAvailable: boolean;
  folderMoveDisabledReason?: string;
  folderMoveInNoProject?: boolean;
  items: RefObject<ComposerCommandItem[] | null>;
  folderQuery?: string;
  emptyState?: RefObject<string | null>;
}) {
  const { items, emptyState } = useComposerMenuItems({
    composerTrigger:
      props.folderQuery === undefined
        ? { kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 1 }
        : { kind: "folder", query: props.folderQuery, rangeStart: 4, rangeEnd: 4 },
    environmentId: EnvironmentId.make("env-1"),
    linkedEnvironments: new Map(),
    gitCwd: null,
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    modelMentions: { instanceEntries: [], modelOptionsByInstance: new Map() },
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    folderMoveAvailable: props.folderMoveAvailable,
    folderMoveDisabledReason: props.folderMoveDisabledReason ?? null,
    folderMoveCurrentFolder: null,
    folderMoveInNoProject: props.folderMoveInNoProject === true,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("claudeAgent"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [{ name: "cd" }, { name: "review" }],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
  });
  useImperativeHandle(props.items, () => items);
  useImperativeHandle(props.emptyState, () => emptyState);
  return null;
}

it.each([
  [undefined, "No other project. Type a path to move to a folder."],
  ["This thread is still working. Try again when the turn ends.", undefined],
])("the /cd pane with no project says what to do, or why it is blocked", async (reason, text) => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const emptyState: RefObject<string | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu
        folderMoveAvailable
        folderQuery=""
        {...(reason === undefined ? {} : { folderMoveDisabledReason: reason })}
        items={shown}
        emptyState={emptyState}
      />
    </AppAtomRegistryProvider>,
  );
  // No project is offered while nothing blocks the move, and nothing is offered while it is blocked.
  expect(shown.current?.map((item) => item.label)).toEqual(
    reason === undefined ? ["No project"] : [],
  );
  expect(emptyState.current).toBe(text ?? reason);
});

it("the /cd pane says when a typed name matches no project", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const emptyState: RefObject<string | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderQuery="harn" items={shown} emptyState={emptyState} />
    </AppAtomRegistryProvider>,
  );
  expect(shown.current).toEqual([]);
  expect(emptyState.current).toBe('No project matches "harn". Type a path to move to a folder.');
});

it.each([
  [false, ["/model", "/review"]],
  [true, ["/model", "/cd", "/no", "/review"]],
])("with folder moves %s, the slash menu offers %j", async (folderMoveAvailable, labels) => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable={folderMoveAvailable} items={shown} />
    </AppAtomRegistryProvider>,
  );
  expect(shown.current?.map((item) => item.label)).toEqual(labels);
  // A row description has no period, like the rows around it.
  expect(shown.current?.find((item) => item.label === "/no")?.description).toBe(
    folderMoveAvailable ? "Move to No project in a new scratch folder" : undefined,
  );
});

it("in a No project thread, /no says the thread is already there and /cd stays usable", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderMoveInNoProject items={shown} />
    </AppAtomRegistryProvider>,
  );
  const moves = shown.current?.filter((item) => item.label === "/cd" || item.label === "/no");
  // The row has no final period; the toast for choosing it gets the full sentence.
  expect(moves).toEqual([
    expect.objectContaining({ description: "Move this thread to another folder" }),
    expect.objectContaining({
      description: "This thread is already in No project",
      blockReason: "This thread is already in No project.",
    }),
  ]);
  expect(moves?.[0]).not.toHaveProperty("blockReason");
});

it("shows why a move is blocked on /cd and /no, and a click on either still reports it", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const reason =
    "Press Esc, then pick the project in the heading above the composer before the first message.";
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderMoveDisabledReason={reason} items={shown} />
    </AppAtomRegistryProvider>,
  );
  const moves = shown.current?.filter((item) => item.label === "/cd" || item.label === "/no");
  const row = { description: reason.slice(0, -1), blockReason: reason };
  expect(moves).toMatchObject([row, row]);

  // The row looks blocked but keeps pointer events, so a click reaches the composer like Enter.
  const onSelect = vi.fn();
  // router: false because the menu reads no route.
  await using menu = await render(
    <ComposerCommandMenu
      listId="commands"
      items={moves ?? []}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={onSelect}
    />,
    { router: false },
  );
  const blocked = menu.getByRole("option", { name: /\/no/ });
  await expect.element(blocked).toHaveAttribute("aria-disabled", "true");
  // Forced: the driver refuses to click an aria-disabled option, and a user's click still lands.
  await blocked.click({ force: true });
  expect(onSelect).toHaveBeenCalledWith(moves?.[1]);
});
