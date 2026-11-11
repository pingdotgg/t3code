import { act, render } from "../../../test/render";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

const suppress = vi.hoisted(() => vi.fn<(enabled: boolean) => Promise<void>>());
vi.mock(import("../../lib/desktopSnapShot"), async (original) => ({
  ...(await original()),
  getDesktopSnapShotBridge: () => ({ setSnapShotShortcutSuppressed: suppress }) as never,
}));

import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const recorded = vi.fn();
const error = vi.fn();

function Recorder(props: { allowModifierPairs?: boolean; shortcutLabel?: string }) {
  const recorder = useSnapShotShortcutRecorder({
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutLabel: props.shortcutLabel,
    allowModifierPairs: props.allowModifierPairs ?? false,
    onRecord: recorded,
    onError: error,
  });
  return recorder.input;
}

function setup() {
  suppress.mockReset().mockResolvedValue(undefined);
  recorded.mockReset();
  error.mockReset();
}
async function renderRecorder(props: Parameters<typeof Recorder>[0] = {}) {
  const screen = await render(<Recorder {...props} />);
  const button = () =>
    screen.container.querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
  // aria-pressed mirrors the hook's recording state, which flips once suppression resolves.
  const expectRecording = (recording: boolean) =>
    expect.element(screen.getByRole("button")).toHaveAttribute("aria-pressed", String(recording));
  return {
    ...screen,
    button,
    expectRecording,
    async start() {
      await userEvent.click(button());
      await expectRecording(true);
    },
  };
}

it("ignores late suppression acknowledgements after cancellation", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const pending = deferred<void>();
  suppress.mockImplementation((enabled) => (enabled ? pending.promise : Promise.resolve()));
  await using screen = await renderRecorder();
  const { button } = screen;
  await userEvent.click(button());
  await act(async () => button().blur());
  await act(async () => pending.resolve());
  await screen.expectRecording(false);
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
});
