import { useEffect, useMemo, useRef } from "react";

import ChatView from "./components/ChatView";
import DiffPanel from "./components/DiffPanel";
import Sidebar from "./components/Sidebar";
import { readNativeApi } from "./session-logic";
import { StoreProvider, useStore } from "./store";

function EventRouter() {
  const api = useMemo(() => readNativeApi(), []);
  const { dispatch } = useStore();
  const activeAssistantItemRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
      });
    });
  }, [api, dispatch]);

  return null;
}

function Layout() {
  const api = useMemo(() => readNativeApi(), []);
  const { state } = useStore();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-[#0c0c0c] text-[#e0e0e0]">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-[#a0a0a0]/60">
            Native bridge unavailable. Launch through Electron.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0c0c0c] text-[#e0e0e0]">
      <EventRouter />
      <Sidebar />
      <ChatView />
      {state.diffOpen && <DiffPanel />}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  );
}
