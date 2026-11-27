import { T, useGT } from "gt-react";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function FilePasswordPrompt(props: {
  readonly incorrect: boolean;
  readonly onSubmit: (password: string) => void;
}) {
  const gt = useGT();
  const status = useId();
  return (
    <form
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const form = event.currentTarget;
        const password = new FormData(form).get("password");
        form.reset();
        if (typeof password === "string" && password.length > 0) props.onSubmit(password);
      }}
    >
      <p id={status} role={props.incorrect ? "alert" : "status"} className="text-sm">
        {props.incorrect
          ? gt("Incorrect password. Try again.")
          : gt("This file requires a password.")}
      </p>
      <div className="flex w-full max-w-xs gap-2">
        <div className="min-w-0 flex-1">
          <Input
            type="password"
            name="password"
            aria-label={gt("File password")}
            aria-describedby={status}
            autoComplete="off"
            autoFocus={props.incorrect}
            required
          />
        </div>
        <Button type="submit">
          <T>Unlock</T>
        </Button>
      </div>
    </form>
  );
}
