import { useState } from "react";
import {
  isCloudEnvironmentConfig,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderCloudConfiguration,
  type ProviderCloudEnvironment,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";

import { CloudEnvironmentCreate, CloudEnvironmentReview } from "./CloudEnvironmentSetup";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

interface CloudEnvironmentDialogProps {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  repository?: string | undefined;
  readOnly?: boolean | undefined;
  /** "review" opens straight onto the selected environment's configuration and publishing. */
  initialPage?: "choose" | "review" | undefined;
  inSetupConversation?: boolean | undefined;
  onSetup: (config: ProviderCloudConfiguration) => void;
  environments: readonly ProviderCloudEnvironment[];
  preferredId: string | undefined;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
}

/** Resolve cloud setup beside the draft; closing the dialog never sends or clears it. */
export function CloudEnvironmentDialog(props: CloudEnvironmentDialogProps) {
  const [choice, setChoice] = useState<string>();
  const [page, setPage] = useState<"choose" | "create" | "review">(props.initialPage ?? "choose");
  const selectedId = choice ?? props.preferredId;
  const selected = props.environments.find((environment) => environment.id === selectedId);
  const backToList =
    props.initialPage === "review"
      ? undefined
      : () => {
          setPage("choose");
          props.onRefresh();
        };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        {page === "create" ? (
          <CloudEnvironmentCreate
            environmentId={props.environmentId}
            instanceId={props.instanceId}
            repository={props.repository}
            onSetup={props.onSetup}
            onCreated={props.onRefresh}
            onBack={() => setPage("choose")}
          />
        ) : page === "review" && selectedId ? (
          <CloudEnvironmentReview
            environmentId={props.environmentId}
            instanceId={props.instanceId}
            configId={selectedId}
            inSetupConversation={props.inSetupConversation ?? false}
            onSetup={props.onSetup}
            onChanged={props.onRefresh}
            onBack={backToList}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Run in Codex Cloud</DialogTitle>
              <DialogDescription>
                Choose an environment for this thread. Your choice is remembered for this project.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex gap-2">
                <Select
                  value={selectedId ?? null}
                  onValueChange={(value) => setChoice(value ?? undefined)}
                  disabled={
                    props.readOnly ||
                    props.loading ||
                    props.error !== null ||
                    props.environments.length === 0
                  }
                  items={props.environments.map((environment) => ({
                    value: environment.id,
                    label: environment.label,
                  }))}
                >
                  <SelectTrigger className="min-w-0 flex-1" aria-label="Codex Cloud environment">
                    <SelectValue
                      placeholder={
                        props.loading ? "Loading environments…" : "Choose an environment"
                      }
                    />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {props.environments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.id}>
                        <span className="flex flex-col">
                          <span>
                            {environment.label}
                            {environment.setup ? " · Not published" : ""}
                          </span>
                          {environment.repository ? (
                            <span className="text-xs text-muted-foreground">
                              Suggested for {environment.repository}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Refresh environments"
                  disabled={props.loading}
                  onClick={props.onRefresh}
                >
                  <RefreshIcon />
                </Button>
              </div>
              {props.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {props.error}
                </p>
              ) : !props.loading && props.environments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No cloud environments yet. Create one to get started.
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              {!props.readOnly ? (
                <Button variant="ghost" className="sm:mr-auto" onClick={() => setPage("create")}>
                  <PlusIcon /> Create environment
                </Button>
              ) : null}
              {isCloudEnvironmentConfig(selected?.id) && !selected?.setup ? (
                <Button variant="outline" onClick={() => setPage("review")}>
                  Manage
                </Button>
              ) : null}
              <Button
                disabled={!selected || props.readOnly || props.loading || props.error !== null}
                onClick={() => {
                  if (!selected) return;
                  if (selected.setup) setPage("review");
                  else props.onSelect(selected.id);
                }}
              >
                {selected?.setup ? "Review setup" : "Use environment"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
