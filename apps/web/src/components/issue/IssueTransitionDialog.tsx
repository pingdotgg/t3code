import { useGT } from "gt-react";
import { useRef, useState } from "react";
import type { IssueTransition } from "@t3tools/contracts";
import {
  issueTransitionSubmission,
  type IssueTransitionDrafts,
} from "@t3tools/client-runtime/issue-transitions";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function IssueTransitionDialog(props: {
  readonly transition: IssueTransition;
  readonly issueKey: string;
  readonly issueUrl: string;
  readonly onClose: () => void;
  readonly onSubmit: (
    fields: ReturnType<typeof issueTransitionSubmission>["fields"],
  ) => Promise<string | null>;
}) {
  const gt = useGT();
  const validationMessages = {
    required: gt("This field is required."),
    "invalid-choice": gt("Choose a valid value."),
    "invalid-value": gt("Enter a value."),
    "invalid-number": gt("Enter a valid number."),
    "invalid-date": gt("Use YYYY-MM-DD."),
    "invalid-datetime": gt("Enter a valid date and time."),
  };
  const [drafts, setDrafts] = useState<IssueTransitionDrafts>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = issueTransitionSubmission(props.transition, drafts);
  const setDraft = (id: string, value: string | ReadonlyArray<string>) =>
    setDrafts((held) => ({ ...held, [id]: value }));
  const submit = async () => {
    setAttempted(true);
    if (submission.blocked || Object.keys(submission.errors).length > 0 || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const error = await props.onSubmit(submission.fields);
    inFlight.current = false;
    setBusy(false);
    if (error === null) props.onClose();
    else setFailure(error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.transition.name}</DialogTitle>
            <DialogDescription>
              {props.issueKey} → {props.transition.to.name}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {props.transition.fields.map((field) => {
                const id = `issue-transition-${field.id}`;
                const draft = drafts[field.id];
                const value = typeof draft === "string" ? draft : "";
                const errorCode = attempted ? submission.errors[field.id] : undefined;
                const error = errorCode === undefined ? undefined : validationMessages[errorCode];
                return (
                  <div key={field.id} className="space-y-1.5">
                    <label htmlFor={id} className="text-sm font-medium">
                      {field.label}
                      {field.required ? " *" : ` (${gt("Optional")})`}
                    </label>
                    {field.type === "unsupported" ? (
                      <p className="text-sm text-muted-foreground">
                        {gt("This field needs Jira’s own editor.")}
                      </p>
                    ) : field.type === "select" ? (
                      <Select
                        items={field.options}
                        value={value || null}
                        onValueChange={(next) => setDraft(field.id, next ?? "")}
                        disabled={busy}
                      >
                        <SelectTrigger
                          id={id}
                          aria-invalid={!!error}
                          aria-describedby={error ? `${id}-error` : undefined}
                        >
                          <SelectValue placeholder={gt("Choose a value…")} />
                        </SelectTrigger>
                        <SelectPopup>
                          {field.options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : field.type === "multiselect" ? (
                      <div role="group" aria-label={field.label} className="space-y-2">
                        {field.options.map((option) => {
                          const selected =
                            typeof draft !== "string" && draft?.includes(option.value) === true;
                          return (
                            <label key={option.value} className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={selected}
                                disabled={busy}
                                onCheckedChange={(checked) => {
                                  const held = typeof draft === "string" ? [] : (draft ?? []);
                                  setDraft(
                                    field.id,
                                    checked
                                      ? [...held, option.value]
                                      : held.filter((v) => v !== option.value),
                                  );
                                }}
                              />
                              {option.label}
                            </label>
                          );
                        })}
                      </div>
                    ) : field.type === "multiline" ? (
                      <Textarea
                        id={id}
                        value={value}
                        disabled={busy}
                        aria-invalid={!!error}
                        aria-describedby={error ? `${id}-error` : undefined}
                        onChange={(event) => setDraft(field.id, event.target.value)}
                      />
                    ) : (
                      <Input
                        id={id}
                        type={
                          field.type === "datetime"
                            ? "datetime-local"
                            : field.type === "date"
                              ? "date"
                              : field.type === "number"
                                ? "number"
                                : "text"
                        }
                        step={field.type === "number" ? "any" : undefined}
                        value={value}
                        disabled={busy}
                        aria-invalid={!!error}
                        aria-describedby={error ? `${id}-error` : undefined}
                        onChange={(event) => setDraft(field.id, event.target.value)}
                      />
                    )}
                    {error ? (
                      <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {submission.blocked ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  {gt("A required field needs Jira’s editor. Complete this transition in Jira.")}
                </p>
              ) : null}
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" type="button" disabled={busy} onClick={props.onClose}>
              {gt("Cancel")}
            </Button>
            <Button
              variant="outline"
              type="button"
              render={<a href={props.issueUrl} target="_blank" rel="noopener noreferrer" />}
            >
              {gt("Open in Jira")}
            </Button>
            {submission.blocked ? null : (
              <Button type="submit" disabled={busy}>
                {busy ? gt("Applying…") : gt("Apply transition")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
