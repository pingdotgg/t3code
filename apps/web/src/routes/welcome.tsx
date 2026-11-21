import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomePage } from "../components/onboarding/WelcomePage";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveWelcomeEnvironmentId } from "../onboarding/welcomePage.logic";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // Settings → Environments opens the page for a connected computer to import its history.
  validateSearch: (raw: Record<string, unknown>): { environmentId?: EnvironmentId } => {
    const environmentId =
      typeof raw.environmentId === "string"
        ? Option.getOrUndefined(decodeEnvironmentId(raw.environmentId))
        : undefined;
    return environmentId === undefined ? {} : { environmentId };
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  // A ChatGPT sign-in returns here with the computer it set up.
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  const requestedEnvironmentId = Route.useSearch({ select: (search) => search.environmentId });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const waitingForCatalog =
    !isReady &&
    (resumeEnvironmentId !== undefined ||
      requestedEnvironmentId !== undefined ||
      primaryEnvironmentId === null);
  const environmentId = resolveWelcomeEnvironmentId({
    resumeEnvironmentId,
    requestedEnvironmentId,
    primaryEnvironmentId,
    knownEnvironmentIds: environments.map((environment) => environment.environmentId),
  });
  // The root can remount this pending outlet after navigation; do not reopen setup.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  if (waitingForCatalog) return null;
  if (environmentId === null || !isWelcomeRoute || dismissed) return <NoProjectsHero />;
  return (
    <WelcomePage
      key={environmentId}
      environmentId={environmentId}
      onDone={async (projectRef) => {
        setDismissed(true);
        if (projectRef !== undefined) {
          await openNewThread(projectRef, { replace: true }).catch(() =>
            navigate({ to: "/", replace: true }),
          );
          return;
        }
        await navigate({ to: "/", replace: true });
      }}
    />
  );
}
