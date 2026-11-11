import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  active: true,
  currentThread: "thread-a",
  currentEnvironment: "environment",
  fullscreenTarget: null as { threadId: string; environmentId: string } | null,
  stop: vi.fn(),
}));
const RouteName = createContext("Thread");
const target = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
vi.mock("@react-navigation/native", () => ({
  useRoute: () => ({ name: useContext(RouteName) }),
  useNavigationState: (
    select: (state: {
      routes: Array<{ name: string; params: { threadId: string; environmentId: string } }>;
    }) => unknown,
  ) =>
    select({
      routes: [
        {
          name: "Thread",
          params: { threadId: fixture.currentThread, environmentId: fixture.currentEnvironment },
        },
        ...(fixture.fullscreenTarget === null
          ? []
          : [{ name: "ThreadInspectorFullscreen", params: fixture.fullscreenTarget }]),
      ],
    }),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./voiceModePresentation", () => ({ resolveVoiceModeNotice: () => null }));
vi.mock("./voiceMode", () => ({
  voiceMode: {
    isActiveFor: (value: { threadId: string }) => fixture.active && value.threadId === "thread-a",
    stop: () => {
      fixture.active = false;
      fixture.stop();
    },
    subscribe: () => () => {},
    getState: () => ({ phase: "active", target }),
  },
}));
import { useVoiceModeThreadLifecycle } from "./useVoiceMode";
function Lifecycle() {
  useVoiceModeThreadLifecycle(target);
  return null;
}
let root: Root;
beforeEach(() => {
  fixture.active = true;
  fixture.currentThread = "thread-a";
  fixture.currentEnvironment = "environment";
  fixture.fullscreenTarget = null;
  fixture.stop.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));
const render = (overlay: boolean, overlayRoute = "ThreadFiles") =>
  act(() =>
    root.render(
      <>
        <RouteName value="Thread">
          <Lifecycle />
        </RouteName>
        {overlay ? (
          <RouteName value={overlayRoute}>
            <Lifecycle />
          </RouteName>
        ) : null}
      </>,
    ),
  );
it("keeps voice running when Files closes and stops when the owning Thread leaves", () => {
  render(true);
  render(false);
  expect(fixture.stop).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});
it.each(["thread", "environment", "fullscreen thread", "fullscreen environment"])(
  "stops the previous thread when navigation selects a different %s",
  (changed) => {
    render(false);
    if (changed === "thread") fixture.currentThread = "thread-b";
    else if (changed === "environment") fixture.currentEnvironment = "another-environment";
    else
      fixture.fullscreenTarget = {
        threadId: changed === "fullscreen thread" ? "thread-b" : "thread-a",
        environmentId: changed === "fullscreen environment" ? "another-environment" : "environment",
      };
    render(false);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  },
);

it("stops voice when its fullscreen thread closes over the still-mounted thread", () => {
  render(true, "ThreadInspectorFullscreen");
  render(false, "ThreadInspectorFullscreen");
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});
