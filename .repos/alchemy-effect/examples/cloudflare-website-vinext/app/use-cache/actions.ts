"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";

export async function refreshCachedStamp() {
  updateTag("demo-stamp");
  redirect("/use-cache");
}
