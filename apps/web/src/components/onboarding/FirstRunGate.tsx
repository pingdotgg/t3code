import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  type FirstRunDecision,
} from "../../onboarding/firstRun.logic";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";

/**
 * Holds back authenticated and hosted app trees until the first-run decision
 * is known, so a fresh install never flashes the main screen before the wizard.
 * Nothing renders while pending — no shell, no EventRouter (whose welcome
 * payload would otherwise navigate into a thread), no dialogs.
 *
 * Decision order: a set `onboardingCompletedAt` resolves to the app as soon as
 * settings hydrate (the common case, no server round-trip). A `null` flag also
 * covers installs that predate the field, so it alone is not enough — the gate
 * waits for environment shells to bootstrap and inspects the workspace.
 * Hosted mode instead checks its saved environment catalog. A timeout guards
 * an unreachable primary server; hosted mode does not need that server timer.
 */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

export function FirstRunGate({
  enabled,
  hostedStatic,
  children,
}: {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const hydrated = useClientSettingsHydrated();
  const completeOnboarding = useCompleteOnboarding();
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments, isReady: environmentCatalogReady } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  const workspaceEvidenceLive = useAtomValue(workspaceEvidenceLiveAtom);
  // Within a session settings stay hydrated, so remounts (e.g. returning from
  // the wizard) resolve synchronously instead of blanking a frame.
  const [decision, setDecision] = useState<FirstRunDecision>(() =>
    (!enabled && !hostedStatic) || (hydrated && onboardingCompletedAt !== null) ? "app" : "pending",
  );

  // A workspace still counts as fresh when its only content is the server's
  // own cwd auto-bootstrap: web mode creates a project + thread from cwd at
  // startup (`autoBootstrapProjectFromCwd` defaults on there), so "no
  // projects at all" would mean `npx t3` users never see the wizard. Any
  // other project, more than one thread, or state in a non-primary
  // environment is real user state — the aggregate hooks span every
  // environment, and a saved remote's project must never read as "the
  // bootstrap project" just because its root string matches the primary cwd.
  const serverCwd = serverConfig?.cwd ?? null;
  const primaryEnvironmentId = serverConfig?.environment.environmentId ?? null;
  const workspaceFresh = isFreshFirstRunWorkspace({
    primaryEnvironmentId,
    serverCwd,
    projects,
    threads,
  });

  const { decision: nextDecision, persistCompletion } = hostedStatic
    ? resolveHostedFirstRunDecision({
        hydrated,
        completed: onboardingCompletedAt !== null,
        catalogReady: environmentCatalogReady,
        environmentCount: environments.length,
      })
    : resolveFirstRunDecision({
        enabled,
        hydrated,
        completed: onboardingCompletedAt !== null,
        bootstrapped,
        authoritative: primaryShellLive,
        workspaceAuthoritative: workspaceEvidenceLive,
        serverConfigAvailable: serverConfig !== null,
        workspaceFresh,
        projectCount: projects.length,
        threadCount: threads.length,
      });

  useEffect(() => {
    if (decision === "wizard" || !hydrated) return;

    if (persistCompletion && onboardingCompletedAt === null) {
      completeOnboarding();
    }

    if (
      (decision === "pending" && nextDecision !== "pending") ||
      (decision === "app" && nextDecision === "wizard")
    ) {
      setDecision(nextDecision);
    }
  }, [
    completeOnboarding,
    decision,
    hydrated,
    nextDecision,
    onboardingCompletedAt,
    persistCompletion,
  ]);

  // The fallback only guards a stalled *server* read. It must not start
  // before settings hydrate, or slow hydration would resolve to the app
  // without the decision effect ever seeing `onboardingCompletedAt`.
  useEffect(() => {
    if (!enabled || decision !== "pending" || !hydrated) return;
    const timer = window.setTimeout(() => setDecision("app"), FIRST_RUN_DECISION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [decision, enabled, hydrated]);

  useEffect(() => {
    if (decision === "wizard") {
      void navigate({ to: "/welcome", replace: true });
    }
  }, [decision, navigate]);

  if (decision !== "app") {
    return null;
  }
  return children;
}
