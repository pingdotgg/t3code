import type { TerminalPosition, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { stripDiffSearchParams } from "../diffRouteSearch";
import type { RightRailPanel } from "../workspacePanels";

type UseWorkspacePanelControllerInput = {
  diffOpen: boolean;
  diffToggleActive: boolean;
  replaceHistory?: boolean;
  terminalOpen: boolean;
  terminalPosition: TerminalPosition;
  terminalToggleActive: boolean;
  setTerminalOpen: (open: boolean) => void;
  threadId: ThreadId;
};

export function useWorkspacePanelController(input: UseWorkspacePanelControllerInput) {
  const navigate = useNavigate();
  const replace = input.replaceHistory ?? false;
  const {
    diffOpen,
    diffToggleActive,
    setTerminalOpen,
    terminalOpen,
    terminalPosition,
    terminalToggleActive,
    threadId,
  } = input;

  const closeDiffPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      ...(replace ? { replace: true } : {}),
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        diff: undefined,
      }),
    });
  }, [navigate, replace, threadId]);

  const openDiffPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      ...(replace ? { replace: true } : {}),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, replace, threadId]);

  const toggleDiffPanel = useCallback(() => {
    if (terminalPosition === "right") {
      if (diffToggleActive) {
        closeDiffPanel();
        return;
      }
      setTerminalOpen(false);
      openDiffPanel();
      return;
    }
    if (diffOpen) {
      closeDiffPanel();
      return;
    }
    openDiffPanel();
  }, [
    closeDiffPanel,
    diffOpen,
    diffToggleActive,
    openDiffPanel,
    setTerminalOpen,
    terminalPosition,
  ]);

  const toggleTerminalPanel = useCallback(() => {
    if (terminalPosition === "right") {
      if (terminalToggleActive) {
        setTerminalOpen(false);
        return;
      }
      if (diffOpen) {
        setTerminalOpen(true);
        closeDiffPanel();
        return;
      }
      if (!terminalOpen) {
        setTerminalOpen(true);
      }
      return;
    }
    setTerminalOpen(!terminalOpen);
  }, [
    closeDiffPanel,
    diffOpen,
    setTerminalOpen,
    terminalOpen,
    terminalPosition,
    terminalToggleActive,
  ]);

  const reopenRightRailPanel = useCallback(
    (panel: Exclude<RightRailPanel, null>) => {
      if (panel === "terminal") {
        setTerminalOpen(true);
        return;
      }
      openDiffPanel();
    },
    [openDiffPanel, setTerminalOpen],
  );

  const closeRightRailPanel = useCallback(
    (panel: RightRailPanel) => {
      if (panel === "terminal") {
        setTerminalOpen(false);
        return;
      }
      if (panel === "diff") {
        closeDiffPanel();
      }
    },
    [closeDiffPanel, setTerminalOpen],
  );

  return {
    closeDiffPanel,
    closeRightRailPanel,
    openDiffPanel,
    reopenRightRailPanel,
    toggleDiffPanel,
    toggleTerminalPanel,
  };
}
