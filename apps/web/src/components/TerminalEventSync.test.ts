import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { applyTerminalRemovedEvent } from "./TerminalEventSync";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);

describe("TerminalEventSync", () => {
  beforeEach(() => {
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("removes a remotely closed terminal from the drawer and right panel", () => {
    const terminalStore = useTerminalUiStateStore.getState();
    terminalStore.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);
    const rightPanelStore = useRightPanelStore.getState();
    rightPanelStore.openTerminal(THREAD_REF, "term-1");
    rightPanelStore.splitTerminal(THREAD_REF, "terminal:term-1", "term-2");

    applyTerminalRemovedEvent(ENVIRONMENT_ID, {
      type: "remove",
      threadId: THREAD_ID,
      terminalId: "term-1",
    });

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF).surfaces,
    ).toEqual([
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
      },
    ]);

    applyTerminalRemovedEvent(ENVIRONMENT_ID, {
      type: "remove",
      threadId: THREAD_ID,
      terminalId: "term-2",
    });

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toMatchObject({ terminalOpen: false, terminalIds: [] });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
  });
});
