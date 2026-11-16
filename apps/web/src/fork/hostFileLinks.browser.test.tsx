import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../test/render";
import ChatMarkdown from "../components/ChatMarkdown";
import { useRightPanelStore } from "../rightPanelStore";

const ORIGIN = vi.hoisted(() => "https://app.example.com");
const environmentId = vi.hoisted(() => "host-files");

// The environment is saved at the address the deploy also serves its files on.
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const entry = {
    target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: `${ORIGIN}/` },
    profile: Option.none(),
    enabled: true,
  };
  return {
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: Atom.make((get) => {
        const catalog = get(actual.environmentCatalog.catalogValueAtom);
        return {
          ...catalog,
          entries: new Map([...catalog.entries, [environmentId as never, entry as never]]),
        };
      }) as never,
    },
  };
});

it("opens a link to a file at the environment's own address as that file, keeping its URL", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make("thread"),
  };
  using openFile = vi.spyOn(useRightPanelStore.getState(), "openFile").mockImplementation(() => {});
  const url = `${ORIGIN}/home/me/notes/report.md#L12`;
  const autolink = `${ORIGIN}/home/me/%E6%97%A5%E5%BF%97.md`;
  const shot = `${ORIGIN}/tmp/shot.png`;
  await using screen = await render(
    <ChatMarkdown
      cwd="/tmp/project"
      threadRef={threadRef}
      text={`[report](${url}) and ${autolink} [![shot](${shot})](${shot})`}
    />,
  );
  const [link, autolinkChip] = screen.container.querySelectorAll("a");
  const navigation = new AbortController();
  using _stopNavigation = { [Symbol.dispose]: () => navigation.abort() };
  document.addEventListener("click", (event) => event.preventDefault(), {
    signal: navigation.signal,
  });

  await act(async () => link!.click());

  expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/home/me/notes/report.md", 12);
  expect(link!.getAttribute("href")).toBe(url);
  expect(autolinkChip!.getAttribute("href")).toBe(autolink);
  expect(screen.container.textContent).not.toContain(ORIGIN);
  expect(screen.getByAltText("shot").element().closest("a")?.getAttribute("href")).toBe(shot);
});
