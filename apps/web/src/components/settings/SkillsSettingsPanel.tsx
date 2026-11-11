import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { BookOpenIcon, DownloadIcon, Trash2Icon } from "lucide-react";
import { RefreshIcon } from "../ui/refresh-icon";
import type {
  EnvironmentId,
  ManagedSkill,
  ManageBundledSkillInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const STATUS_LABELS = {
  not_installed: "Not installed",
  installed: "Up to date",
  update_available: "Update available",
  modified: "Locally modified",
  unmanaged: "Installed outside T3 Code",
} as const;

export function EnvironmentSkillsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.bundledSkills({ environmentId, input: {} }));
  const manage = useAtomCommand(serverEnvironment.manageBundledSkill, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const canManage = useAtomValue(
    serverEnvironment.manageBundledSkill.permissionAtom(environmentId),
  );
  const [selectedId, setSelectedId] = useState<ProviderInstanceId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    skill: ManagedSkill;
    instanceId: ProviderInstanceId;
    label: string;
  } | null>(null);
  const targets = query.data?.targets ?? [];
  const target = targets.find((target) => target.instanceId === selectedId) ?? targets[0];

  const change = async (
    skill: ManagedSkill,
    action: ManageBundledSkillInput["action"],
    requestedInstanceId?: ProviderInstanceId,
  ) => {
    const instanceId = requestedInstanceId ?? target?.instanceId;
    if (!instanceId || busy !== null) return;
    setBusy(skill.id);
    setError(null);
    setNotice(null);
    const result = await manage({
      environmentId,
      input: { instanceId, skillId: skill.id, action, expectedFingerprint: skill.fingerprint },
    });
    query.refresh();
    if (result._tag === "Success") {
      setNotice(
        `${skill.title} ${action === "remove" ? "removed" : action === "update" ? "updated" : "installed"}. Restart the agent session to apply the change.`,
      );
      await refreshProviders({ environmentId, input: { instanceId } });
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The skill could not be changed.");
    }
    setBusy(null);
  };

  return (
    <>
      <SettingsSection
        title="T3 Code skills"
        icon={<BookOpenIcon className="size-4" />}
        headerAction={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => query.refresh()}
            disabled={query.isPending || busy !== null}
          >
            <RefreshIcon /> Check for updates
          </Button>
        }
      >
        <SettingsRow
          title="Provider"
          description="Install for every project using this provider on the selected environment."
          control={
            <Select
              value={target?.instanceId ?? ""}
              disabled={busy !== null || targets.length === 0}
              onValueChange={(value) => {
                const next = targets.find((target) => target.instanceId === value);
                if (next) {
                  setSelectedId(next.instanceId);
                  setError(null);
                  setNotice(null);
                }
              }}
            >
              <SelectTrigger aria-label="Skill provider">
                <SelectValue>{target?.label ?? "Select provider"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {targets.map((entry) => (
                  <SelectItem key={entry.instanceId} value={entry.instanceId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {query.isPending && !query.data ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading skills…
          </p>
        ) : null}
        {target?.skills.map((skill) => {
          const blocked = skill.status === "modified" || skill.status === "unmanaged";
          const installable =
            skill.status === "not_installed" || skill.status === "update_available";
          return (
            <div key={skill.id} className="space-y-3 px-3 py-4 sm:px-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{skill.title}</h3>
                <Badge
                  size="sm"
                  variant={
                    skill.status === "installed"
                      ? "success"
                      : blocked || skill.status === "update_available"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {STATUS_LABELS[skill.status]}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{skill.description}</p>
              {skill.requirements ? (
                <p className="text-sm text-muted-foreground">{skill.requirements}</p>
              ) : null}
              <p className="break-all text-xs text-muted-foreground">{skill.path}</p>
              <div className="flex flex-wrap items-center gap-2">
                {installable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${skill.status === "update_available" ? "Update" : "Install"} ${skill.title}`}
                    disabled={!canManage || busy !== null || query.isPending}
                    onClick={() =>
                      void change(skill, skill.status === "update_available" ? "update" : "install")
                    }
                  >
                    {busy === skill.id ? (
                      <Spinner />
                    ) : skill.status === "update_available" ? (
                      <RefreshIcon />
                    ) : (
                      <DownloadIcon />
                    )}
                    {busy === skill.id
                      ? "Saving…"
                      : skill.status === "update_available"
                        ? "Update"
                        : "Install"}
                  </Button>
                ) : null}
                {skill.status === "installed" || skill.status === "update_available" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${skill.title}`}
                    disabled={!canManage || busy !== null || query.isPending}
                    onClick={() =>
                      setRemoving({ skill, instanceId: target.instanceId, label: target.label })
                    }
                  >
                    <Trash2Icon /> Remove
                  </Button>
                ) : null}
                {blocked ? (
                  <p className="text-xs text-muted-foreground">
                    Your files are preserved. Move this copy before installing the bundled version.
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </SettingsSection>
      {query.error || error ? (
        <Alert variant="error">
          <AlertDescription>{error ?? query.error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {query.data && targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add a Codex or Claude provider to install T3 Code skills.
        </p>
      ) : null}
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Settings permission is required to install, update, or remove skills.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Skills are bundled with this environment’s T3 Code version. Updating the server makes newer
        copies available here. Installation currently supports Codex and Claude; other providers can
        use manual installation.
      </p>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.skill.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the managed copy for {removing?.label}. Your threads and worktrees stay
              in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canManage || busy !== null}
              onClick={() => {
                const pending = removing;
                setRemoving(null);
                if (pending) void change(pending.skill, "remove", pending.instanceId);
              }}
            >
              Remove skill
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function SkillsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {!environment ? (
        <p className="text-sm text-muted-foreground">Connect an environment to manage skills.</p>
      ) : environment.serverConfig?.environment.capabilities.bundledSkills !== true ? (
        <p className="text-sm text-muted-foreground">
          Update this environment’s T3 Code server to manage bundled skills.
        </p>
      ) : (
        <EnvironmentSkillsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      )}
    </SettingsPageContainer>
  );
}
