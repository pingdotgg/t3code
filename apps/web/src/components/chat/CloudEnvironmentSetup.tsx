import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderCloudConfiguration,
  ProviderCloudEnvironmentMutation,
} from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";

import { cloudEnvironments } from "../../cloudRunStore";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

interface CloudEnvironmentTarget {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
}

/** Runs one environment change at a time; failures surface as toasts. */
export function useCloudEnvironmentMutation(environmentId: EnvironmentId | null) {
  const [busy, setBusy] = useState<ProviderCloudEnvironmentMutation["operation"] | null>(null);
  const canOperate = useAtomValue(cloudEnvironments.mutate.permissionAtom(environmentId));
  const mutate = useAtomCommand(cloudEnvironments.mutate);
  const run = async (input: ProviderCloudEnvironmentMutation) => {
    if (busy || !canOperate || !environmentId) return null;
    setBusy(input.operation);
    try {
      const result = await mutate({ environmentId, input });
      return result._tag === "Success" ? { value: result.value } : null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, canOperate, run };
}

/** A dialog title with an optional way back to the environment list. */
function PageHeader(props: {
  title: ReactNode;
  description: ReactNode;
  onBack?: (() => void) | undefined;
}) {
  return (
    <DialogHeader>
      <div className="flex items-center gap-2">
        {props.onBack ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Back to environments"
            onClick={props.onBack}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <DialogTitle>{props.title}</DialogTitle>
      </div>
      <DialogDescription>{props.description}</DialogDescription>
    </DialogHeader>
  );
}

/** Picks connected repositories for a new environment, then hands off to its setup conversation. */
export function CloudEnvironmentCreate(
  props: CloudEnvironmentTarget & {
    repository?: string | undefined;
    onSetup: (config: ProviderCloudConfiguration) => void;
    onCreated: () => void;
    onBack: () => void;
  },
) {
  const [name, setName] = useState(props.repository?.split("/").at(-1) ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [network, setNetwork] = useState<"disabled" | "package_managers" | "unrestricted">(
    "package_managers",
  );
  const mutation = useCloudEnvironmentMutation(props.environmentId);
  const repositories = useEnvironmentQuery(
    cloudEnvironments.repositories({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, query },
    }),
  );
  const create = async () => {
    const result = await mutation.run({
      instanceId: props.instanceId,
      operation: "create",
      name: name.trim(),
      repositoryIds,
      network,
    });
    if (!result) return;
    props.onCreated();
    if (result.value) props.onSetup(result.value);
  };
  return (
    <>
      <PageHeader
        title="Create a cloud environment"
        description="Pick repositories. Codex then prepares the environment with you in a setup conversation."
        onBack={props.onBack}
      />
      <DialogPanel>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cloud-environment-name">Name</Label>
          <Input
            id="cloud-environment-name"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cloud-environment-search">Repositories</Label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(search);
            }}
          >
            <Input
              id="cloud-environment-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search connected repositories"
            />
          </form>
          <div className="max-h-56 overflow-y-auto">
            {repositories.isPending ? (
              <p className="py-2 text-sm text-muted-foreground">Loading repositories…</p>
            ) : repositories.error ? (
              <p role="alert" className="py-2 text-sm text-destructive">
                {repositories.error}
              </p>
            ) : repositories.data?.length ? (
              repositories.data.map((repo) => (
                <label key={repo.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <Checkbox
                    checked={repositoryIds.includes(repo.id)}
                    onCheckedChange={(checked) =>
                      setRepositoryIds((ids) =>
                        checked ? [...ids, repo.id] : ids.filter((id) => id !== repo.id),
                      )
                    }
                  />
                  {repo.name}
                </label>
              ))
            ) : (
              <p className="py-2 text-sm text-muted-foreground">
                No connected repositories found. Check GitHub access in your Codex account.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Internet access</Label>
          <Select
            value={network}
            items={[
              { value: "package_managers", label: "Package managers" },
              { value: "unrestricted", label: "Unrestricted" },
              { value: "disabled", label: "Disabled" },
            ]}
            onValueChange={(value) => {
              if (value === "disabled" || value === "package_managers" || value === "unrestricted")
                setNetwork(value);
            }}
          >
            <SelectTrigger aria-label="Internet access">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="package_managers">Package managers</SelectItem>
              <SelectItem value="unrestricted">Unrestricted</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </DialogPanel>
      <DialogFooter>
        <p className="mr-auto self-center text-xs text-muted-foreground">
          {repositoryIds.length === 0
            ? "None selected"
            : `${repositoryIds.length} ${repositoryIds.length === 1 ? "repository" : "repositories"}`}
        </p>
        <Button
          disabled={
            mutation.busy !== null ||
            !mutation.canOperate ||
            !name.trim() ||
            repositoryIds.length === 0
          }
          onClick={() => void create()}
        >
          {mutation.busy ? "Creating…" : "Get started"}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * An environment configuration at a glance, with publishing as its one
 * action. `inSetupConversation` hides the way into the conversation the user
 * is already in.
 */
export function CloudEnvironmentReview(
  props: CloudEnvironmentTarget & {
    configId: string;
    inSetupConversation: boolean;
    onSetup: (config: ProviderCloudConfiguration) => void;
    onChanged: () => void;
    onBack?: (() => void) | undefined;
  },
) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const mutation = useCloudEnvironmentMutation(props.environmentId);
  const configuration = useEnvironmentQuery(
    cloudEnvironments.configuration({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, id: props.configId },
    }),
  );
  const config = configuration.data;
  const operate = async (operation: "publish" | "delete") => {
    if (!config) return;
    const result = await mutation.run({
      instanceId: props.instanceId,
      operation,
      id: config.id,
    });
    if (!result) return;
    props.onChanged();
    if (operation === "delete") props.onBack?.();
    else configuration.refresh();
  };
  const ready = config?.revision !== null && config?.revision !== undefined;
  return (
    <>
      <PageHeader
        title={config?.name ?? "Cloud environment"}
        description={
          !config
            ? configuration.isPending
              ? "Loading configuration…"
              : "Could not load this environment."
            : config.published
              ? "Published. New cloud tasks start from this environment."
              : ready
                ? "Setup is ready to publish."
                : "Not published. Finish the setup conversation to publish it."
        }
        onBack={props.onBack}
      />
      <DialogPanel>
        {configuration.error ? (
          <p role="alert" className="text-sm text-destructive">
            {configuration.error}
          </p>
        ) : null}
        {config ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Repositories</dt>
            <dd className="min-w-0 break-words">
              {config.repositories.map((repo) => `${repo.id} @ ${repo.ref}`).join(", ") || "None"}
            </dd>
            <dt className="text-muted-foreground">Directory</dt>
            <dd className="min-w-0 break-words font-mono text-xs">{config.cwd || "Default"}</dd>
            <dt className="text-muted-foreground">Install</dt>
            <dd className="min-w-0">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                {config.installScript || "None"}
              </pre>
            </dd>
            <dt className="text-muted-foreground">Start skill</dt>
            <dd className="min-w-0">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                {config.startSkill || "None"}
              </pre>
            </dd>
          </dl>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <div className="mr-auto flex gap-1">
          {config ? (
            <Button
              variant="ghost-destructive"
              disabled={mutation.busy !== null || !mutation.canOperate}
              onClick={() =>
                confirmingDelete ? void operate("delete") : setConfirmingDelete(true)
              }
              onBlur={() => setConfirmingDelete(false)}
            >
              {mutation.busy === "delete"
                ? "Deleting…"
                : confirmingDelete
                  ? "Confirm delete"
                  : "Delete"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh configuration"
            disabled={configuration.isPending}
            onClick={configuration.refresh}
          >
            <RefreshIcon />
          </Button>
        </div>
        {config && !config.published && !props.inSetupConversation ? (
          <Button
            variant="outline"
            disabled={!mutation.canOperate}
            onClick={() => props.onSetup(config)}
          >
            Continue setup
          </Button>
        ) : null}
        {config ? (
          <Button
            disabled={mutation.busy !== null || !mutation.canOperate || !ready}
            onClick={() => void operate("publish")}
          >
            {mutation.busy === "publish"
              ? "Publishing…"
              : config.published
                ? "Republish"
                : "Publish environment"}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
