import { memo, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import {
  selectActiveTerminalSurface,
  useRightPanelStore,
  type TerminalPanelSurface,
} from "~/rightPanelStore";

import type { RightPanelTerminalProps } from "./chat/RightPanelSurfaceContent";
import { reconcileMountedTerminalThreads } from "./RightPanelTabs.logic";
import { RightPanelTerminalBody } from "./RightPanelTerminalBody";
import type { TerminalBodyHost, TerminalBodyHosts } from "./terminalBodyHosts";

const EMPTY_KEYS: readonly string[] = [];

/** Keeps drawer terminals mounted for recently shown threads; only the active one is visible. */
export function RightPanelTerminalBodies(props: {
  hosts: TerminalBodyHosts;
  activeThreadKey: string | null;
  drawerVisible: boolean;
  terminal: RightPanelTerminalProps;
}) {
  const { hosts, activeThreadKey } = props;
  const panelOpenKeys = useRightPanelStore(
    useShallow((state) =>
      Object.entries(state.byThreadKey).flatMap(([threadKey, thread]) =>
        thread.isOpen && thread.surfaces.some((surface) => surface.kind === "terminal")
          ? [threadKey]
          : [],
      ),
    ),
  );
  const [mounted, setMounted] = useState(EMPTY_KEYS);
  const next = reconcileMountedTerminalThreads({
    current: mounted,
    panelOpen: new Set(panelOpenKeys),
    active: activeThreadKey,
    activeShowing: props.drawerVisible,
  });
  if (next.length !== mounted.length || next.some((key, index) => key !== mounted[index])) {
    setMounted(next);
  }
  const holderRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives parked hosts a hidden DOM home and drops the hosts of threads whose terminals unmounted
  useLayoutEffect(() => {
    hosts.setHolder(holderRef.current);
    hosts.retain(new Set(activeThreadKey === null ? mounted : [...mounted, activeThreadKey]));
  }, [activeThreadKey, hosts, mounted]);
  const hiddenTerminal = { ...props.terminal, launchContext: null };

  return (
    <div hidden ref={holderRef}>
      {mounted.map((threadKey) => {
        const active = threadKey === activeThreadKey;
        return (
          <ThreadTerminalBodyPortal
            key={threadKey}
            host={hosts.host(threadKey)}
            visible={active && props.drawerVisible}
            terminal={active ? props.terminal : hiddenTerminal}
          />
        );
      })}
    </div>
  );
}

const ThreadTerminalBodyPortal = memo(function ThreadTerminalBodyPortal(props: {
  host: TerminalBodyHost;
  visible: boolean;
  terminal: RightPanelTerminalProps;
}) {
  const { threadRef } = props.host;
  const surface = useRightPanelStore((state): TerminalPanelSurface | null =>
    selectActiveTerminalSurface(state.byThreadKey, threadRef),
  );
  if (!surface || !threadRef) return null;
  return createPortal(
    <RightPanelTerminalBody
      key={surface.id}
      threadRef={threadRef}
      surface={surface}
      visible={props.visible}
      terminal={props.terminal}
    />,
    props.host.element,
  );
});
