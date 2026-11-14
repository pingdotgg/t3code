import { textDirection } from "@t3tools/shared/textDirection";
import type { FormEvent } from "react";

export * from "@t3tools/shared/textDirection";

/** Props for an uncontrolled field, whose text React never sees: the direction follows what is typed. */
export function uncontrolledFieldDirection(defaultValue: string) {
  return {
    dir: textDirection(defaultValue),
    onInput: (event: FormEvent<HTMLTextAreaElement>) => {
      event.currentTarget.dir = textDirection(event.currentTarget.value) ?? "";
    },
  };
}
