import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderCloudConfiguration,
  ProviderCloudEnvironmentMutation,
} from "@t3tools/contracts";
import {
  mutateCloudEnvironment,
  providerCloudConfiguration,
  providerCloudRepositories,
} from "../../cloudRunStore";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Native repository selection and publish controls beside an ordinary T3 setup conversation. */
export function CloudEnvironmentSetup(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  repository?: string | undefined;
  configId?: string | undefined;
  onSetup: (config: ProviderCloudConfiguration) => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(props.repository?.split("/").at(-1) ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [network, setNetwork] = useState<"disabled" | "package_managers" | "unrestricted">(
    "package_managers",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const canOperate = useAtomValue(mutateCloudEnvironment.permissionAtom(props.environmentId));
  const mutate = useAtomCommand(mutateCloudEnvironment);
  const repositories = useEnvironmentQuery(
    !props.configId
      ? providerCloudRepositories({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, query },
        })
      : null,
  );
  const configuration = useEnvironmentQuery(
    props.configId
      ? providerCloudConfiguration({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, id: props.configId },
        })
      : null,
  );
  const run = async (input: ProviderCloudEnvironmentMutation) => {
    if (busy || !canOperate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "The request failed. Refresh before trying again; it may have completed.",
        );
        return;
      }
      props.onChanged();
      if (input.operation === "create" && result.value) props.onSetup(result.value);
      else if (input.operation === "delete") setDeleted(true);
      else configuration.refresh();
    } finally {
      setBusy(false);
    }
  };
  if (deleted)
    return (
      <div className="flex flex-col gap-3">
        <p>Environment deleted.</p>
        <Button onClick={props.onBack}>Back to environments</Button>
      </div>
    );
  if (props.configId) {
    const config = configuration.data;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {config?.name ?? "Environment"} · {config?.published ? "Published" : "Setup draft"}
        </p>
        {configuration.error ? <p role="alert">{configuration.error}</p> : null}
        {config ? (
          <>
            <p className="text-sm text-muted-foreground">
              Review the setup conversation and configuration before publishing. Publishing saves
              the prepared cloud filesystem for new tasks.
            </p>
            <details>
              <summary>Setup configuration</summary>
              <div className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                <p>Working directory: {config.cwd}</p>
                <p>
                  Repositories:{" "}
                  {config.repositories.map((repo) => `${repo.id} @ ${repo.ref}`).join(", ")}
                </p>
                <p>Install script:</p>
                <pre>{config.installScript || "None"}</pre>
                <p>Start skill:</p>
                <pre>{config.startSkill || "None"}</pre>
              </div>
            </details>
            {!config.published ? (
              <Button disabled={busy || !canOperate} onClick={() => props.onSetup(config)}>
                Open setup conversation
              </Button>
            ) : null}
            <Button
              disabled={busy || !canOperate || config.revision === null}
              onClick={() =>
                void run({ instanceId: props.instanceId, operation: "publish", id: config.id })
              }
            >
              {busy
                ? "Publishing…"
                : config.published
                  ? "Republish environment"
                  : "Publish environment"}
            </Button>
            <details>
              <summary className="text-sm text-muted-foreground">Delete environment</summary>
              <p className="my-2 text-sm">This removes the saved environment from Codex Cloud.</p>
              <Button
                variant="destructive"
                disabled={busy || !canOperate}
                onClick={() =>
                  void run({ instanceId: props.instanceId, operation: "delete", id: config.id })
                }
              >
                Delete environment
              </Button>
            </details>
          </>
        ) : null}
        <Button variant="outline" disabled={busy} onClick={configuration.refresh}>
          Refresh configuration
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Environment name
        <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
        }}
      >
        <Input
          aria-label="Search connected GitHub repositories"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search connected repositories"
        />
        <Button variant="outline" type="submit">
          Search
        </Button>
      </form>
      <div className="max-h-56 overflow-y-auto">
        {repositories.isPending ? (
          <p>Loading repositories…</p>
        ) : repositories.error ? (
          <p role="alert">{repositories.error}</p>
        ) : repositories.data?.length ? (
          repositories.data.map((repo) => (
            <label key={repo.id} className="flex items-center gap-2 py-2 text-sm">
              <input
                type="checkbox"
                checked={repositoryIds.includes(repo.id)}
                onChange={(event) =>
                  setRepositoryIds((ids) =>
                    event.target.checked ? [...ids, repo.id] : ids.filter((id) => id !== repo.id),
                  )
                }
              />
              {repo.name}
            </label>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No connected repositories found. Check GitHub access in your Codex account.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{repositoryIds.length} selected</p>
      <Select
        value={network}
        items={[
          { value: "package_managers", label: "Package managers" },
          { value: "unrestricted", label: "Unrestricted internet" },
          { value: "disabled", label: "Internet disabled" },
        ]}
        onValueChange={(value) => {
          if (value === "disabled" || value === "package_managers" || value === "unrestricted")
            setNetwork(value);
        }}
      >
        <SelectTrigger aria-label="Cloud internet access">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="package_managers">Package managers</SelectItem>
          <SelectItem value="unrestricted">Unrestricted internet</SelectItem>
          <SelectItem value="disabled">Internet disabled</SelectItem>
        </SelectPopup>
      </Select>
      <p className="text-sm text-muted-foreground">
        Codex prepares this private environment in a separate setup conversation. Your current draft
        stays saved.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <Button
        disabled={busy || !canOperate || !name.trim() || !repositoryIds.length}
        onClick={() =>
          void run({
            instanceId: props.instanceId,
            operation: "create",
            name: name.trim(),
            repositoryIds,
            network,
          })
        }
      >
        {busy ? "Creating environment…" : "Create and open setup"}
      </Button>
    </div>
  );
}
