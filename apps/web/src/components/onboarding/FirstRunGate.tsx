import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { resolveFirstRunDecision, type FirstRunDecision } from "../../onboarding/firstRun.logic";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { primaryServerConfigAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";

/**
 * Holds back the authenticated app tree until the first-run decision is known,
 * so a fresh install never flashes the main screen before the welcome wizard.
 * Nothing renders while pending — no shell, no EventRouter (whose welcome
 * payload would otherwise navigate into a thread), no dialogs.
 *
 * Decision order: a set `onboardingCompletedAt` resolves to the app as soon as
 * settings hydrate (the common case, no server round-trip). A `null` flag also
 * covers installs that predate the field, so it alone is not enough — the gate
 * waits for environment shells to bootstrap and inspects the workspace. A
 * timeout guards the pathological case where shells never bootstrap
 * (unreachable server): after it, the app renders as usual.
 */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

export function FirstRunGate({
  enabled,
  children,
}: {
  /**
   * Only an authenticated primary-server session gates. Hosted-static has no
   * primary server config to inspect and its empty state handles onboarding
   * itself; gating it would just add a decision timeout to every load.
   */
  readonly enabled: boolean;
  readonly children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const hydrated = useClientSettingsHydrated();
  const completeOnboarding = useCompleteOnboarding();
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  // Within a session settings stay hydrated, so remounts (e.g. returning from
  // the wizard) resolve synchronously instead of blanking a frame.
  const [decision, setDecision] = useState<FirstRunDecision>(() =>
    !enabled || (hydrated && onboardingCompletedAt !== null) ? "app" : "pending",
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
  const workspaceFresh =
    projects.every(
      (project) =>
        project.environmentId === primaryEnvironmentId &&
        serverCwd !== null &&
        normalizeProjectPathForComparison(project.workspaceRoot) ===
          normalizeProjectPathForComparison(serverCwd),
    ) &&
    threads.length <= 1 &&
    threads.every((thread) => thread.environmentId === primaryEnvironmentId);

  const { decision: nextDecision, persistCompletion } = resolveFirstRunDecision({
    enabled,
    hydrated,
    completed: onboardingCompletedAt !== null,
    bootstrapped,
    authoritative: primaryShellLive,
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

    if (decision === "pending" && nextDecision !== "pending") {
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
    if (decision !== "pending" || !hydrated) return;
    const timer = window.setTimeout(() => setDecision("app"), FIRST_RUN_DECISION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [decision, hydrated]);

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
