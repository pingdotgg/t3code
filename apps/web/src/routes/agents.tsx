import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import "../components/agents/agents.css";

export const Route = createFileRoute("/agents")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => (
    <div className="min-h-0 h-dvh w-full flex flex-col">
      <Outlet />
    </div>
  ),
});
