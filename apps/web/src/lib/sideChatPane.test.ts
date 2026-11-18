import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { resolveThreadOpenRoute } from "./sideChatPane";

const environmentId = EnvironmentId.make("environment:test");
const mainRef = scopeThreadRef(environmentId, ThreadId.make("main"));
const sideChatRef = scopeThreadRef(environmentId, ThreadId.make("side-chat"));

it("routes a side chat to its parent with the side chat tab active", () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const route = resolveThreadOpenRoute(sideChatRef, {
    lineage: { sideChat: true, parentThreadId: mainRef.threadId } as never,
  });

  expect(route).toEqual(mainRef);
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, mainRef)?.id,
  ).toBe("side-chat:side-chat");
  expect(
    resolveThreadOpenRoute(mainRef, {
      lineage: { sideChat: false, parentThreadId: null } as never,
    }),
  ).toBe(mainRef);
});
