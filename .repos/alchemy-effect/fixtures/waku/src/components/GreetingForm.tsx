"use client";

import { useActionState } from "react";
import { greet } from "../actions.ts";

export function GreetingForm() {
  const [message, formAction] = useActionState(greet, "");
  return (
    <form action={formAction}>
      <input name="name" data-testid="greet-name" />
      <button type="submit" data-testid="greet-submit">
        Greet
      </button>
      <output data-testid="greet-output">{message}</output>
    </form>
  );
}
