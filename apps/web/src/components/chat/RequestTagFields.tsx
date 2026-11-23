import {
  requestTagFieldRows,
  requestTagFieldValues,
  requestTagsFromFields,
  type RequestTagFieldsResult,
} from "@t3tools/client-runtime/request-tag-fields";
import { parseLiteLLMRequestTags } from "@t3tools/contracts";
import type { LiteLLMDefaultRequestTag } from "@t3tools/contracts/settings";
import { useMessages } from "gt-react";
import { useId, useState } from "react";

import { Input } from "../ui/input";
import { Label } from "../ui/label";

/** One labeled input per tag category. `value` seeds the fields; remount to reset them. */
export function RequestTagFields(props: {
  value: string;
  driver: string | undefined;
  defaultTag: LiteLLMDefaultRequestTag;
  onChange: (result: RequestTagFieldsResult) => void;
  onSubmit?: () => void;
}) {
  const id = useId();
  const m = useMessages();
  const [original] = useState(() => parseLiteLLMRequestTags(props.value));
  const [fields, setFields] = useState(() => requestTagFieldValues(original));
  const { error } = requestTagsFromFields(original, fields);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
      {requestTagFieldRows(props.driver, props.defaultTag, m).map(({ key, label, placeholder }) => (
        <div key={key} className="contents">
          <Label htmlFor={`${id}-${key}`}>{label}</Label>
          <Input
            id={`${id}-${key}`}
            size="compact"
            placeholder={placeholder}
            value={fields[key]}
            onChange={(event) => {
              const next = { ...fields, [key]: event.target.value };
              setFields(next);
              props.onChange(requestTagsFromFields(original, next));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !props.onSubmit) return;
              event.preventDefault();
              props.onSubmit();
            }}
          />
        </div>
      ))}
      {error ? (
        <p role="alert" className="col-span-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
