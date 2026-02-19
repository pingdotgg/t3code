import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import Sidebar from "../components/Sidebar";

function ChatRouteLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground isolate">
      <Sidebar />
      <DiffWorkerPoolProvider>
        <Outlet />
      </DiffWorkerPoolProvider>
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});

