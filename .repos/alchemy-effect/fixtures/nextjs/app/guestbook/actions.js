"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { revalidatePath } from "next/cache";

// Server action: writes the entry into the FIXTURE_KV binding via
// getCloudflareContext, then revalidates the page so the next render
// (force-dynamic anyway) reflects it.
export async function signGuestbook(formData) {
  const name = formData.get("name");
  if (typeof name !== "string" || name.length === 0) return;
  const { env } = getCloudflareContext();
  await env.FIXTURE_KV.put("guestbook:latest", name);
  revalidatePath("/guestbook");
}
