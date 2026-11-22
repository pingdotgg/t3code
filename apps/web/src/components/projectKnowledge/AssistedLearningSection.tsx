import { useState } from "react";
import { T, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectKnowledgeStatus,
} from "@t3tools/contracts";
import { assistedLearningRunLabel } from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";

export function AssistedLearningSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly status: ProjectKnowledgeStatus | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = config?.settings;
  if (!settings || config.environment.capabilities.projectSettingsOverrides !== true) return null;
  const enabled = resolveProjectSettings(settings, props.projectId).settings.enableAssistedLearning;
  const lastRun = props.status?.assistedLearning?.lastRun ?? null;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: {
              ...settings.projectSettingsOverrides[props.projectId],
              enableAssistedLearning: next,
            },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section
      aria-label={gt("Automatic memory")}
      className="flex flex-col gap-1 rounded-md border p-3"
    >
      <div className="flex items-center justify-between gap-3 font-medium text-sm">
        <span>
          <T>Save facts from finished runs</T>
        </span>
        <Switch
          aria-label={gt("Save facts from finished runs")}
          checked={enabled}
          disabled={!canWrite || busy}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        <T>
          Completed runs are grouped into background learning batches. Your text generation model
          saves up to three cited facts per batch; eligible batches use at most one model call.
        </T>
      </p>
      {lastRun ? <p className="text-xs">{assistedLearningRunLabel(lastRun, m)}</p> : null}
      {!canWrite ? (
        <p className="text-xs">
          <T>This connection cannot change project settings.</T>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
