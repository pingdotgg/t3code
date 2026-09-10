"use server";

import { readMessage } from "./env.ts";

/**
 * A React server function driven by `useActionState` in a client component:
 * the form submission POSTs to the RSC endpoint and executes here, inside the
 * worker runtime — reading the `MESSAGE` binding proves it.
 */
export async function greet(_previous: string, formData: FormData): Promise<string> {
  const name = String(formData.get("name") ?? "anonymous");
  return `Hello, ${name}! MESSAGE=${await readMessage()}`;
}
