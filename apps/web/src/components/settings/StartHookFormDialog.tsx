import type { StartHookForm } from "@t3tools/contracts";
import { useCallback, useId, useMemo, useState } from "react";

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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { isStartHookInputComponent, validateStartHookTextInput } from "./startHook";

interface StartHookFormDialogProps {
  readonly environmentLabel: string;
  readonly form: StartHookForm;
  readonly submitting: boolean;
  readonly onSubmit: (values: ReadonlyArray<string>) => void;
  readonly onCancel: () => void;
}

/**
 * Renders the component form a start hook returns with a 400: the management
 * solution needs input (instance size, region, …) before it starts the
 * instance. Submitting sends the resolved values back as a JSON array.
 */
export function StartHookFormDialog({
  environmentLabel,
  form,
  submitting,
  onSubmit,
  onCancel,
}: StartHookFormDialogProps) {
  const fieldIdPrefix = useId();
  const initialValues = useMemo(() => {
    const values: Record<number, string> = {};
    form.components.forEach((component, index) => {
      if (isStartHookInputComponent(component)) {
        values[index] = component.type === "select" ? component.defaultValue : "";
      }
    });
    return values;
  }, [form]);
  const [values, setValues] = useState<Record<number, string>>(initialValues);
  const [errors, setErrors] = useState<Record<number, string>>({});
  // The endpoint may re-prompt with a different form after a submission;
  // reset the collected input when that happens.
  const [renderedForm, setRenderedForm] = useState(form);
  if (renderedForm !== form) {
    setRenderedForm(form);
    setValues(initialValues);
    setErrors({});
  }
  // Hook forms carry no component ids, so the position doubles as identity;
  // the title/text only disambiguates the key for readability.
  const componentEntries = useMemo(
    () =>
      form.components.map((component, index) => ({
        component,
        index,
        key: `${index}:${isStartHookInputComponent(component) ? component.title : component.text}`,
      })),
    [form],
  );

  const handleSubmit = useCallback(() => {
    const nextErrors: Record<number, string> = {};
    const resolved: Array<string> = [];
    form.components.forEach((component, index) => {
      if (!isStartHookInputComponent(component)) return;
      const value = values[index] ?? "";
      if (component.type === "text") {
        const validationError = validateStartHookTextInput(component, value);
        if (validationError !== null) {
          nextErrors[index] = validationError;
        }
      }
      resolved.push(value);
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      onSubmit(resolved);
    }
  }, [form, onSubmit, values]);

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start {environmentLabel}</DialogTitle>
          <DialogDescription>
            The service managing this environment needs a few details before it starts the instance.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {componentEntries.map(({ component, index, key }) => {
            if (!isStartHookInputComponent(component)) {
              return (
                <p key={key} className="text-sm text-muted-foreground">
                  {component.text}
                </p>
              );
            }
            const fieldId = `${fieldIdPrefix}-${index}`;
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={fieldId}>{component.title}</Label>
                {component.description ? (
                  <p className="text-xs text-muted-foreground">{component.description}</p>
                ) : null}
                {component.type === "select" ? (
                  <Select
                    value={values[index] ?? component.defaultValue}
                    onValueChange={(nextValue) =>
                      nextValue !== null &&
                      setValues((current) => ({ ...current, [index]: nextValue }))
                    }
                  >
                    <SelectTrigger id={fieldId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {component.values.map((option) => (
                        <SelectItem key={option.content} value={option.content}>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{option.userTitle}</span>
                            {option.userDescription ? (
                              <span className="truncate text-xs text-muted-foreground">
                                {option.userDescription}
                              </span>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <>
                    <Input
                      id={fieldId}
                      value={values[index] ?? ""}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [index]: event.target.value }))
                      }
                    />
                    {errors[index] ? (
                      <p className="text-destructive text-xs">{errors[index]}</p>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={handleSubmit}>
            {submitting ? "Submitting…" : form.button_text}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
