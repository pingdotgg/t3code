import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomePage } from "../components/onboarding/WelcomePage";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

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
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const reviewProjects = hash.startsWith("projects:");
  // Sign-in and project import shortcuts carry the computer they were opened for.
  const resumeEnvironmentId =
    hash.startsWith("agents:") || reviewProjects
      ? Option.getOrUndefined(decodeEnvironmentId(hash.slice(hash.indexOf(":") + 1)))
      : undefined;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  // Trust the id only once the catalog has it.
  const waitingForCatalog =
    !isReady && (resumeEnvironmentId !== undefined || primaryEnvironmentId === null);
  const resumeKnown =
    resumeEnvironmentId !== undefined &&
    environments.some((environment) => environment.environmentId === resumeEnvironmentId);
  // An import shortcut must never silently switch to a different computer.
  const environmentId =
    (resumeKnown ? resumeEnvironmentId : undefined) ??
    (reviewProjects ? null : primaryEnvironmentId);
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
      reviewProjects={reviewProjects}
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
