import type { IssueTemplateField } from "@t3tools/contracts";

import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { IssueTemplateValues } from "./issueCreate.logic";

function FieldHeading({ id, label, required }: { id: string; label: string; required: boolean }) {
  return (
    <Label htmlFor={`issue-field-${id}`}>
      {label}
      {required ? <span className="text-destructive">*</span> : null}
    </Label>
  );
}

export function IssueTemplateForm({
  fields,
  values,
  onChange,
}: {
  fields: ReadonlyArray<IssueTemplateField>;
  values: IssueTemplateValues;
  onChange: (next: IssueTemplateValues) => void;
}) {
  const set = (id: string, value: string | ReadonlyArray<string>) =>
    onChange({ ...values, [id]: value });

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => {
        if (field.kind === "markdown") {
          return (
            <p key={field.value} className="whitespace-pre-wrap text-muted-foreground text-xs">
              {field.value}
            </p>
          );
        }
        const value = values[field.id];
        const text = typeof value === "string" ? value : "";
        const list = typeof value === "string" || value === undefined ? [] : value;
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            <FieldHeading id={field.id} label={field.label} required={field.required} />
            {field.description ? (
              <p className="text-muted-foreground text-xs">{field.description}</p>
            ) : null}
            {field.kind === "input" ? (
              <Input
                id={`issue-field-${field.id}`}
                placeholder={field.placeholder ?? undefined}
                value={text}
                onChange={(event) => set(field.id, event.target.value)}
              />
            ) : field.kind === "textarea" ? (
              <Textarea
                id={`issue-field-${field.id}`}
                placeholder={field.placeholder ?? undefined}
                value={text}
                onChange={(event) => set(field.id, event.target.value)}
              />
            ) : field.kind === "dropdown" ? (
              <Select
                multiple={field.multiple}
                value={field.multiple ? [...list] : text || null}
                onValueChange={(next: string | string[] | null) => set(field.id, next ?? "")}
              >
                <SelectTrigger id={`issue-field-${field.id}`} size="sm">
                  <SelectValue>
                    {(selected: string | string[] | null) =>
                      (Array.isArray(selected) ? selected.join(", ") : selected) || "Select…"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {field.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <div className="flex flex-col gap-1.5">
                {field.options.map((option) => (
                  <label key={option.label} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={list.includes(option.label)}
                      onCheckedChange={(checked) =>
                        set(
                          field.id,
                          checked
                            ? [...list, option.label]
                            : list.filter((entry) => entry !== option.label),
                        )
                      }
                    />
                    {option.label}
                    {option.required ? <span className="text-destructive">*</span> : null}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
