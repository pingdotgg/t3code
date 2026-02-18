import { Outlet, createFileRoute } from "@tanstack/react-router";

import DiffPanel from "../components/DiffPanel";
import Sidebar from "../components/Sidebar";
import { useStore } from "../store";

function ChatRouteLayout() {
  const { state } = useStore();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground isolate">
      <Sidebar />
      <Outlet />
      {state.diffOpen && <DiffPanel />}
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
