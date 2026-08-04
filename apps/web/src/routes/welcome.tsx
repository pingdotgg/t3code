import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";

/**
 * First-run welcome wizard. Full-screen, outside the sidebar shell (the root
 * route mounts this path bare, like /pair). Reached only via the first-run
 * gate on the index route; visiting it directly after onboarding is harmless —
 * finishing again just refreshes the completion flag.
 */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  // An authenticated gate means a primary server is serving this app —
  // desktop, `npx t3`, or a dev server — and that server is "this machine"
  // no matter what hostname the browser used. Only hosted-static has no
  // local server to offer.
  const localAvailable = authGateState.status === "authenticated";
  return (
    <WelcomeWizard
      localAvailable={localAvailable}
      onDone={() => {
        void navigate({ to: "/", replace: true });
      }}
    />
  );
}
