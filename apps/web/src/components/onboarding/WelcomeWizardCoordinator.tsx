import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { SETUP_COMPLETED_KEY } from "../../onboarding/firstRun";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { WelcomeWizard } from "./WelcomeWizard";

/** Only the empty home opens setup automatically; direct links always remain usable. */
export function WelcomeWizardCoordinator() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady } = useEnvironments();
  const [completed, setCompleted] = useLocalStorage(SETUP_COMPLETED_KEY, false, Schema.Boolean);
  const settingsHydrated = useClientSettingsHydrated();
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [opened, setOpened] = useState(false);
  const shouldOpen =
    pathname === "/" &&
    !completed &&
    onboardingCompletedAt === null &&
    settingsHydrated &&
    isReady &&
    bootstrapped &&
    projects.length === 0;
  if (!opened && shouldOpen) setOpened(true);
  if (pathname !== "/" || (!opened && !shouldOpen)) return null;
  return (
    <WelcomeWizard
      localAvailable={primaryEnvironmentId !== null}
      onDone={async () => {
        setOpened(false);
        setCompleted(true);
        await navigate({ to: "/" });
      }}
    />
  );
}
