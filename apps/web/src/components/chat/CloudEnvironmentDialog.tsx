import { useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderCloudConfiguration,
  ProviderCloudEnvironment,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon } from "lucide-react";

import { CloudEnvironmentSetup } from "./CloudEnvironmentSetup";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

interface CloudEnvironmentDialogProps {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  repository?: string | undefined;
  readOnly?: boolean | undefined;
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
  const [page, setPage] = useState<"choose" | "create" | "review">("choose");
  const selectedId = choice ?? props.preferredId;
  const setupSelected = props.environments.some((entry) => entry.id === selectedId && entry.setup);
  const available =
    !props.error &&
    !props.loading &&
    props.environments.some((environment) => environment.id === selectedId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {page === "create"
              ? "Create a cloud environment"
              : page === "review"
                ? "Review cloud environment"
                : "Run in Codex Cloud"}
          </DialogTitle>
          <DialogDescription>
            {page === "create"
              ? "Choose connected repositories, then prepare the environment in a setup conversation."
              : page === "review"
                ? "Review and publish the environment prepared by Codex."
                : "Choose an environment for this thread. Your choice is remembered for this project."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-4">
          {page !== "choose" ? (
            <CloudEnvironmentSetup
              environmentId={props.environmentId}
              instanceId={props.instanceId}
              repository={props.repository}
              {...(page === "review" && selectedId ? { configId: selectedId } : {})}
              onSetup={props.onSetup}
              onChanged={props.onRefresh}
              onBack={() => {
                setChoice(undefined);
                setPage("choose");
                props.onRefresh();
              }}
            />
          ) : (
            <>
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
                <SelectTrigger aria-label="Codex Cloud environment">
                  <SelectValue
                    placeholder={props.loading ? "Loading environments…" : "Choose an environment"}
                  />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {props.environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      <span className="flex flex-col">
                        <span>
                          {environment.label}
                          {environment.setup ? " · Setup draft" : ""}
                        </span>
                        {environment.repository ? (
                          <span className="text-xs text-muted-foreground">
                            {environment.repository} · Suggested
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {props.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {props.error}
                </p>
              ) : !props.loading && props.environments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No cloud environments found. Create one to get started.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {!props.readOnly ? (
                  <Button variant="outline" size="sm" onClick={() => setPage("create")}>
                    <PlusIcon /> Create environment
                  </Button>
                ) : null}
                {selectedId && /(?:^|~)asenvcfg_/.test(selectedId) ? (
                  <Button variant="outline" size="sm" onClick={() => setPage("review")}>
                    Review environment
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.loading}
                  onClick={props.onRefresh}
                >
                  <RefreshCwIcon /> Refresh
                </Button>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Back to draft
          </Button>
          {page !== "choose" ? (
            <Button variant="outline" onClick={() => setPage("choose")}>
              Back to environments
            </Button>
          ) : null}
          {page === "choose" ? (
            <Button
              disabled={!available || props.readOnly}
              onClick={() => {
                if (available && selectedId) {
                  if (setupSelected) setPage("review");
                  else props.onSelect(selectedId);
                }
              }}
            >
              {setupSelected ? "Open setup" : "Use environment"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
