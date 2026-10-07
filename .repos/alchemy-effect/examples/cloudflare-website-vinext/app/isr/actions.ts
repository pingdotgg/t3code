"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function refreshCachedPage() {
  revalidatePath("/isr");
  redirect("/isr");
}
