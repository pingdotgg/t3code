import { revalidatePath } from "next/cache";

// On-demand revalidation: purges the /isr entry from the writable KV
// incremental cache so the next render produces a fresh stamp.
export function POST() {
  revalidatePath("/isr");
  return Response.json({ revalidated: true });
}
