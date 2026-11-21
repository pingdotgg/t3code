import { startTransition, useLayoutEffect, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useMicrophoneRefresh } from "./browserMicrophones";

it("drops a microphone scan resolved during the commit that removes its view", async () => {
  const scan = Promise.withResolvers<MediaDeviceInfo[]>();
  const started = Promise.withResolvers<void>();
  const onResult = vi.fn();
  using _enumerate = vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockImplementation(() => {
    started.resolve();
    return scan.promise;
  });

  function MicrophoneView() {
    useMicrophoneRefresh({ enabled: true, onResult });
    return null;
  }

  function Replacement() {
    useLayoutEffect(() => {
      scan.resolve([]);
    }, []);
    return <p>Microphone view closed</p>;
  }

  function App() {
    const [open, setOpen] = useState(true);
    return open ? (
      <>
        <button type="button" onClick={() => startTransition(() => setOpen(false))}>
          Close microphone view
        </button>
        <MicrophoneView />
      </>
    ) : (
      <Replacement />
    );
  }

  // A plain root keeps the replacement commit independent of the router.
  await using screen = await render(<App />, { router: false });
  await started.promise;
  // act would flush passive cleanup before the scan can complete.
  screen
    .getByRole("button", { name: "Close microphone view" })
    .element()
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.element(screen.getByText("Microphone view closed")).toBeVisible();
  expect(onResult).not.toHaveBeenCalled();
});
