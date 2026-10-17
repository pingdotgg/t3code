import type { IssueFieldValues, IssueInputField } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { IssueJsonField, jsonFieldError } from "./IssueJsonField";

function cascadeChoice(field: IssueInputField, value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { id, child, ...rest } = parsed as Record<string, unknown>;
  const parent = field.options?.find((option) => option.value === id);
  if (!parent || Object.keys(rest).length > 0) return null;
  if (child === undefined) return { parent: parent.value, child: null };
  if (typeof child !== "object" || child === null || Array.isArray(child)) return null;
  const { id: childId, ...childRest } = child as Record<string, unknown>;
  const option = parent.children?.find((candidate) => candidate.value === childId);
  if (!option || Object.keys(childRest).length > 0) return null;
  return { parent: parent.value, child: option.value };
}

export function nativeFieldValues(fields: readonly IssueInputField[], values: IssueFieldValues) {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.id];
      if (value === undefined) return [];
      if (
        !field.required &&
        typeof value === "string" &&
        !value.trim() &&
        field.kind !== "text" &&
        field.kind !== "textarea" &&
        field.kind !== "multiselect" &&
        !(field.kind === "select" && field.options?.some((option) => option.value === value))
      )
        return [];
      const native =
        field.kind === "datetime" && typeof value === "string" && value.trim()
          ? new Date(value).toISOString()
          : value;
      return [[field.id, native]];
    }),
  ) as IssueFieldValues;
}

export function nativeFieldError(fields: readonly IssueInputField[], values: IssueFieldValues) {
  for (const field of fields) {
    const value = values[field.id];
    const empty =
      value === undefined || (typeof value === "string" ? !value.trim() : !value.length);
    if (empty) {
      if (field.required) return `Fill in ${field.label}.`;
      continue;
    }
    if (field.kind === "multiselect") {
      if (
        typeof value === "string" ||
        value.some((item) => !field.options?.some((option) => option.value === item))
      )
        return `Choose values for ${field.label}.`;
    } else if (typeof value !== "string") return `Enter a value for ${field.label}.`;
    else if (field.kind === "select" && !field.options?.some((option) => option.value === value))
      return `Choose a value for ${field.label}.`;
    else if (field.kind === "number" && !Number.isFinite(Number(value)))
      return `Enter a number for ${field.label}.`;
    else if (field.kind === "datetime" && !Number.isFinite(new Date(value).getTime()))
      return `Enter a date and time for ${field.label}.`;
    else if (field.kind === "cascading-select" && !cascadeChoice(field, value))
      return `Choose a value for ${field.label}.`;
    else if (field.kind === "json") {
      const error = jsonFieldError(value, field.label);
      if (error) return error;
    }
  }
  return null;
}

export function IssueNativeFields({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: readonly IssueInputField[];
  values: IssueFieldValues;
  onChange: (values: IssueFieldValues) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4">
      {fields.map((field) => {
        const id = `issue-native-field-${field.id}`;
        const value = values[field.id];
        const text = typeof value === "string" ? value : "";
        const multiple = field.kind === "multiselect";
        const set = (next: string | readonly string[] | undefined) => {
          const updated = { ...values };
          delete updated[field.id];
          onChange(next === undefined ? updated : { ...values, [field.id]: next });
        };
        const cascade =
          field.kind === "cascading-select" && text ? cascadeChoice(field, text) : null;
        const cascadeChildren = field.options?.find(
          (option) => option.value === cascade?.parent,
        )?.children;
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            <Label htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            {field.description ? (
              <p className="text-xs text-muted-foreground">{field.description}</p>
            ) : null}
            {field.kind === "cascading-select" ? (
              <div className="flex flex-col gap-1.5">
                <Select
                  value={cascade?.parent ?? null}
                  disabled={disabled}
                  onValueChange={(next: string | null) =>
                    set(next ? JSON.stringify({ id: next }) : undefined)
                  }
                >
                  <SelectTrigger id={id} size="sm" aria-label={field.label}>
                    <SelectValue>
                      {(selected: string | null) =>
                        field.options?.find((option) => option.value === selected)?.label ??
                        "Select…"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {!field.required ? <SelectItem value="">None</SelectItem> : null}
                    {field.options?.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {cascade && cascadeChildren?.length ? (
                  <Select
                    value={cascade.child ?? ""}
                    disabled={disabled}
                    onValueChange={(next: string | null) =>
                      set(
                        JSON.stringify(
                          next
                            ? { id: cascade.parent, child: { id: next } }
                            : { id: cascade.parent },
                        ),
                      )
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`${field.label} option`}>
                      <SelectValue>
                        {(selected: string | null) =>
                          cascadeChildren.find((option) => option.value === selected)?.label ??
                          "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">None</SelectItem>
                      {cascadeChildren.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </div>
            ) : field.kind === "json" ? (
              <IssueJsonField
                id={id}
                label={field.label}
                value={text}
                disabled={disabled}
                onChange={set}
              />
            ) : field.kind === "select" || multiple ? (
              <Select
                multiple={multiple}
                value={
                  multiple
                    ? Array.isArray(value)
                      ? [...value]
                      : []
                    : value === undefined
                      ? null
                      : text
                }
                disabled={disabled}
                onValueChange={(next: string | string[] | null) =>
                  set(next ?? (multiple ? [] : ""))
                }
              >
                <SelectTrigger id={id} size="sm" aria-label={field.label}>
                  <SelectValue>
                    {(selected: string | string[] | null) => {
                      const selectedValues = Array.isArray(selected)
                        ? selected
                        : selected !== null
                          ? [selected]
                          : [];
                      return (
                        selectedValues
                          .map(
                            (item) =>
                              field.options?.find((option) => option.value === item)?.label ?? item,
                          )
                          .join(", ") || (selected === "" ? "None" : "Select…")
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {!multiple &&
                  !field.required &&
                  !field.options?.some((option) => option.value === "") ? (
                    <SelectItem value="">None</SelectItem>
                  ) : null}
                  {field.options?.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : field.kind === "textarea" ? (
              <Textarea
                id={id}
                value={text}
                required={field.required}
                maxLength={65_536}
                onChange={(event) => set(event.target.value)}
              />
            ) : (
              <Input
                id={id}
                value={text}
                required={field.required}
                maxLength={65_536}
                type={
                  field.kind === "datetime"
                    ? "datetime-local"
                    : field.kind === "text"
                      ? "text"
                      : field.kind
                }
                onChange={(event) => set(event.target.value)}
              />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
