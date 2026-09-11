import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  createGatewayRuntimePortFromContext,
  type AgentHandoffResult,
} from "@t3tools/client-runtime/gateway";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

import { agentMachineUnavailableReason } from "./agentMachineAvailability";

export function AgentHandoffDialog({
  sourceEnvironmentId,
  sourceThreadId,
  initialSummary,
  onClose,
}: {
  sourceEnvironmentId: string;
  sourceThreadId: string;
  initialSummary: string;
  onClose: () => void;
}) {
  const { profiles } = useAgentLibrary();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const runtime = useAtomValue(connectionAtomRuntime);
  const navigate = useNavigate();
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [summary, setSummary] = useState(initialSummary.slice(0, 64000));
  const [prompt, setPrompt] = useState("");
  const [paths, setPaths] = useState("");
  const [handoffId] = useState(randomUUID);
  const [result, setResult] = useState<AgentHandoffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const profile = profiles.find((p) => p.profileId === profileId);
  const machines = environments.map((env) => ({
    env,
    reason: profile ? agentMachineUnavailableReason(profile, env) : "Select an agent",
  }));
  const eligible = machines.filter(({ reason }) => reason === undefined).map(({ env }) => env);
  const target = environmentId
    ? eligible.find((env) => env.environmentId === environmentId)
    : eligible[0];
  const choices = projects
    .filter((p) => p.environmentId === target?.environmentId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const project = choices.find((p) => p.id === projectId) ?? choices[0];
  const openDestination = async (settle: boolean) => {
    if (!result || runtime._tag !== "Success") return;
    setBusy(true);
    setError("");
    try {
      if (settle)
        await createGatewayRuntimePortFromContext(runtime.value).settleThread!(
          sourceEnvironmentId,
          sourceThreadId,
        );
      await navigate({
        to: "/agents/$environmentId/$threadId",
        params: { environmentId: result.environmentId, threadId: ThreadId.make(result.threadId) },
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the destination.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="agent-dialog p-6">
        <DialogTitle>{result ? "Handoff created" : "Hand off to an agent"}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          {result
            ? "Your source conversation remains intact."
            : "Review the summary, choose the next agent, and describe its task. Selected text files are copied into a Markdown brief on the destination machine."}
        </DialogDescription>
        {result ? (
          <div className="agent-form">
            <p className="break-all">Brief: {result.briefPath}</p>
            {result.status === "sent" ? (
              <p>Would you like to settle this source conversation?</p>
            ) : (
              <p role="alert">
                The new chat exists, but delivery did not finish: {result.error}. Open it to
                recover; the source has not been settled.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <footer>
              <button disabled={busy} onClick={() => void openDestination(false)}>
                {result.status === "sent" ? "Keep source open" : "Open new chat"}
              </button>
              {result.status === "sent" && (
                <button
                  className="agent-primary"
                  disabled={busy}
                  onClick={() => void openDestination(true)}
                >
                  Settle source and continue
                </button>
              )}
            </footer>
          </div>
        ) : (
          <form
            className="agent-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!profile || !target || !project || runtime._tag !== "Success") return;
              setBusy(true);
              setError("");
              try {
                setResult(
                  await createGatewayRuntimePortFromContext(runtime.value).handoffThread!({
                    sourceEnvironmentId,
                    sourceThreadId,
                    environmentId: target.environmentId,
                    projectId: project.id,
                    profileId,
                    handoffId,
                    title: `Handoff to ${profile.name}`,
                    summary,
                    prompt,
                    files: paths
                      .split("\n")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  }),
                );
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Handoff failed.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Destination agent
              <select
                required
                value={profileId}
                onChange={(e) => {
                  setProfileId(e.target.value);
                  setEnvironmentId("");
                  setProjectId("");
                }}
              >
                {profiles.map((p) => (
                  <option key={p.profileId} value={p.profileId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="agent-form-grid">
              <label>
                Machine
                <select
                  value={target?.environmentId ?? ""}
                  onChange={(e) => {
                    setEnvironmentId(e.target.value);
                    setProjectId("");
                  }}
                >
                  <option value="" disabled>
                    Select machine
                  </option>
                  {machines.map(({ env, reason }) => (
                    <option
                      key={env.environmentId}
                      value={env.environmentId}
                      disabled={reason !== undefined}
                    >
                      {env.label}
                      {reason ? ` — ${reason}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Project
                <select value={project?.id ?? ""} onChange={(e) => setProjectId(e.target.value)}>
                  {choices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!target && (
              <p role="alert">
                No available machine selected. Check the machine list for connection, provider, or
                model issues.
              </p>
            )}
            <label>
              Summary / findings
              <textarea
                required
                rows={5}
                maxLength={64000}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
            <span className="text-xs text-muted-foreground">
              Starts with the latest assistant response. Review it before sending.
            </span>
            <label>
              Source files · optional
              <textarea
                rows={2}
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder="One workspace-relative text file per line, e.g. plan.md"
              />
            </label>
            <label>
              Task for the next agent
              <textarea
                required
                rows={3}
                maxLength={16000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Implement the plan, or review the changes and report findings…"
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                className="agent-primary"
                disabled={busy || !target || !project || !profile || runtime._tag !== "Success"}
              >
                {busy ? "Creating handoff…" : "Create handoff"}
              </button>
            </footer>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
