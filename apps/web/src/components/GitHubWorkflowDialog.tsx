import type { GitHubWorkflow } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { GitHubIcon } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";

function initialValues(workflow: GitHubWorkflow | null): Record<string, string> {
  return Object.fromEntries(
    (workflow?.inputs ?? []).map((input) => [
      input.name,
      input.type === "boolean"
        ? input.defaultValue === "true"
          ? "true"
          : "false"
        : (input.defaultValue ?? input.options?.[0] ?? ""),
    ]),
  );
}

export function GitHubWorkflowDialog({
  workflow,
  onClose,
  onRun,
}: {
  workflow: GitHubWorkflow | null;
  onClose: () => void;
  onRun: (workflow: GitHubWorkflow, inputs: Record<string, string>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showValidation, setShowValidation] = useState(false);

  useEffect(() => {
    setValues(initialValues(workflow));
    setSubmitting(false);
    setShowValidation(false);
  }, [workflow]);

  const missingRequired = useMemo(
    () =>
      workflow?.inputs.find((input) => input.required && !(values[input.name] ?? "").trim()) ??
      null,
    [values, workflow],
  );

  const submit = async () => {
    if (!workflow) return;
    if (missingRequired) {
      setShowValidation(true);
      return;
    }
    setSubmitting(true);
    const submittedInputs = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.length > 0),
    );
    const succeeded = await onRun(workflow, submittedInputs);
    setSubmitting(false);
    if (succeeded) onClose();
  };

  return (
    <Dialog open={workflow !== null} onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitHubIcon className="size-5" />
            {workflow?.name ?? "Run workflow"}
          </DialogTitle>
          <DialogDescription>
            Configure the manual inputs. This run will use the thread’s current branch.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {workflow?.inputs.map((input) => {
            const invalid = showValidation && input.required && !(values[input.name] ?? "").trim();
            return (
              <label
                className={
                  input.type === "boolean"
                    ? "grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-md border border-border/70 px-3 py-2.5 dark:border-transparent dark:bg-white/[0.035]"
                    : "grid gap-1.5"
                }
                key={input.name}
              >
                <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                  {input.name}
                  {input.required ? <span className="text-destructive">*</span> : null}
                </span>
                {input.type === "boolean" ? (
                  <Switch
                    aria-label={input.name}
                    checked={values[input.name] === "true"}
                    onCheckedChange={(checked) =>
                      setValues((current) => ({
                        ...current,
                        [input.name]: checked ? "true" : "false",
                      }))
                    }
                  />
                ) : input.options ? (
                  <Select
                    value={values[input.name] ?? ""}
                    onValueChange={(value) =>
                      setValues((current) => ({ ...current, [input.name]: value ?? "" }))
                    }
                  >
                    <SelectTrigger aria-invalid={invalid || undefined}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {input.options.map((option) => (
                        <SelectItem hideIndicator key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Input
                    aria-invalid={invalid || undefined}
                    value={values[input.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [input.name]: event.target.value }))
                    }
                  />
                )}
                {input.description ? (
                  <span
                    className={`text-pretty text-xs text-muted-foreground ${
                      input.type === "boolean" ? "col-span-2" : ""
                    }`}
                  >
                    {input.description}
                  </span>
                ) : null}
                {invalid ? (
                  <span className="text-xs text-destructive">This input is required.</span>
                ) : null}
              </label>
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={submitting} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void submit()}>
            {submitting ? <Spinner className="size-4" /> : <GitHubIcon className="size-4" />}
            Start workflow
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
