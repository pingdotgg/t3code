import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../test/render";

function Crash(): never {
  throw new Error("crashed while rendering");
}

it("fails the render when the component throws inside the test router", async () => {
  await expect(render(<Crash />)).rejects.toThrow("crashed while rendering");
  expect(document.body.childElementCount).toBe(0);
});

function RoutedProbe({ onUnmount }: { onUnmount: () => void }) {
  useEffect(() => onUnmount, [onUnmount]);
  return <Link to="/">home</Link>;
}

it("unmounts, removes the container and detaches the router on dispose", async () => {
  const onUnmount = vi.fn();
  let mounted: Screen;
  {
    await using screen = await render(<RoutedProbe onUnmount={onUnmount} />, { router: "/start" });
    mounted = screen;
    await expect.element(screen.getByRole("link", { name: "home" })).toBeVisible();
    expect(screen.router?.state.location.pathname).toBe("/start");
    expect(screen.router?.history.subscribers.size).toBeGreaterThan(0);
  }
  const { container, router } = mounted;

  expect(onUnmount).toHaveBeenCalledOnce();
  expect(container.isConnected).toBe(false);
  expect(container.childElementCount).toBe(0);
  expect(router?.history.subscribers.size).toBe(0);
});

it("keeps the act environment off outside the helper", async () => {
  await using screen = await render(<p>idle</p>, { router: false });
  expect(screen.router).toBeUndefined();
  expect(globalThis.IS_REACT_ACT_ENVIRONMENT).not.toBe(true);
});

it("restores exactly the stubbed global", () => {
  {
    using _stub = stubGlobal("t3TestGlobal", 1);
    expect(Reflect.get(globalThis, "t3TestGlobal")).toBe(1);
  }
  expect("t3TestGlobal" in globalThis).toBe(false);
});
