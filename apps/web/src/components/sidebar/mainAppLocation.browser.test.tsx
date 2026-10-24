import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MainAppLocationTracker, useNavigateToMainApp } from "./mainAppLocation";

function LeaveUtilityPage() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <>
      <MainAppLocationTracker />
      <button type="button" onClick={() => void navigateToMainApp()}>
        Back
      </button>
    </>
  );
}

// regression: #16542
describe("leaving a utility page", () => {
  it("keeps browser history moving between threads", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/env/thread-a" });
    const router = screen.router!;
    const pathname = () => router.state.location.pathname;

    await act(() => router.navigate({ href: "/env/thread-b" }));
    await act(() => router.navigate({ href: "/settings/general" }));
    await screen.getByRole("button", { name: "Back" }).click();
    expect(pathname()).toBe("/env/thread-b");

    await act(() => router.history.back());
    expect(pathname()).toBe("/env/thread-a");

    await act(() => router.history.forward());
    expect(pathname()).toBe("/env/thread-b");
  });

  it("returns to the remembered thread after its history entry is replaced", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/settings" });
    const router = screen.router!;
    const pathname = () => router.state.location.pathname;

    await act(() => router.navigate({ href: "/env/thread-a" }));
    await act(() => router.history.back());
    await act(() => router.navigate({ href: "/usage" }));
    await act(() => router.navigate({ href: "/settings" }));
    await screen.getByRole("button", { name: "Back" }).click();
    expect(pathname()).toBe("/env/thread-a");
  });
});
