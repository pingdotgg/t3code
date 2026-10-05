"use server";

import { redirect } from "next/navigation";

export async function submitName(form: FormData) {
  const value = form.get("name");
  const name = typeof value === "string" ? value.trim().slice(0, 64) : "";
  redirect(`/?submitted=${encodeURIComponent(name || "visitor")}`);
}
