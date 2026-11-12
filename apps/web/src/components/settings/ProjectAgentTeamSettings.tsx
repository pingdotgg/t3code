import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef, type ScopedProjectRef } from "@t3tools/client-runtime/environment";
import type { AgentTeamSeatStatus, OrchestrationV2ReadAgentTeamResult } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { openAddSpecialistsFromTemplate } from "../AddSpecialistsFromTemplateDialog";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function statusLabel(status: AgentTeamSeatStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "active":
      return "Active";
    case "needs_attention":
      return "Needs attention";
    case "archived":
      return "Archived";
    default:
      return status;
  }
}

function ProjectAgentTeamSettingsInner({ projectRef }: { projectRef: ScopedProjectRef }) {
  const navigate = useNavigate();
  const readAgentTeam = useAtomCommand(threadEnvironment.readAgentTeam, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<OrchestrationV2ReadAgentTeamResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load roster from the server for this project
  useEffect(() => {
    let cancelled = false;
    void readAgentTeam({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        setSnapshot(null);
        setError(failure instanceof Error ? failure.message : "Could not load agent team.");
        return;
      }
      setSnapshot(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRef.environmentId, projectRef.projectId, readAgentTeam]);

  const team = snapshot?.team ?? null;
  const seats = snapshot?.seats ?? [];

  return (
    <SettingsSection
      title="Agent team"
      description="Durable specialist seats installed from a team template."
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading agent team…</p>
      ) : error !== null ? (
        <p className="text-sm text-destructive-foreground">{error}</p>
      ) : team === null ? (
        <SettingsRow
          {...searchableSetting("project-agent-team")}
          title="No agent team"
          description="Install Workshop or a repo contributor bundle to get a lead and specialist seats."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => openAddSpecialistsFromTemplate({ projectRef })}
            >
              <UsersIcon />
              Add agent team…
            </Button>
          }
        />
      ) : (
        <>
          <SettingsRow
            {...searchableSetting("project-agent-team")}
            title={team.name}
            description="One team per project. Membership follows specialist thread bindings."
          />
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {seats.map((seat) => (
              <li
                key={seat.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{seat.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {statusLabel(seat.status)}
                    {seat.openOwnedWorkCount > 0 ? ` · ${seat.openOwnedWorkCount} open work` : ""}
                    {seat.pendingReviewCount > 0 ? ` · ${seat.pendingReviewCount} review` : ""}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(projectRef.environmentId, seat.threadId),
                      ),
                    })
                  }
                >
                  Open thread
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsSection>
  );
}

export function ProjectAgentTeamSettings({ projectRef }: { projectRef: ScopedProjectRef }) {
  return (
    <ProjectAgentTeamSettingsInner
      key={`${projectRef.environmentId}:${projectRef.projectId}`}
      projectRef={projectRef}
    />
  );
}
