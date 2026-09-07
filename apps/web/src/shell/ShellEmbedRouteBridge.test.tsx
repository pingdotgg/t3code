import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ShellEmbedRouteBridge } from "./ShellEmbedRouteBridge";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  navigate.mockClear();
});

describe("retained shell embed navigation", () => {
  it.each(["terminal", "rightPanel"] as const)(
    "follows %s thread publications without a document reload",
    async (surface) => {
      const first = {
        environmentId: EnvironmentId.make("env-a"),
        threadId: ThreadId.make("thread-a"),
      };
      const second = {
        environmentId: EnvironmentId.make("env-b"),
        threadId: ThreadId.make("thread-b"),
      };
      let publish!: (state: Record<string, unknown>) => void;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("window", {
        addEventListener: () => {},
        removeEventListener: () => {},
        t3Shell: {
          onState: async (listener: typeof publish) => {
            publish = listener;
            return () => {};
          },
        },
      });
      await act(() => {
        renderer = create(<ShellEmbedRouteBridge threadRef={first} surface={surface} />);
      });
      const key = surface === "terminal" ? "workspace" : "rightPanel";
      await act(() => publish({ [key]: { threadKey: scopedThreadKey(first) } }));
      expect(navigate).not.toHaveBeenCalled();
      await act(() => publish({ [key]: { threadKey: scopedThreadKey(second) } }));
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/embed/$environmentId/$threadId",
        params: { environmentId: "env-b", threadId: "thread-b" },
        search: { surface },
        replace: true,
      });
      await act(() =>
        renderer?.update(<ShellEmbedRouteBridge threadRef={second} surface={surface} />),
      );
      await act(() => publish({ [key]: { threadKey: scopedThreadKey(second) } }));
      expect(navigate).toHaveBeenCalledTimes(1);
    },
  );
});
