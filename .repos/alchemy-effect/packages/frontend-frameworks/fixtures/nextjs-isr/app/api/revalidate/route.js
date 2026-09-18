import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

// On-demand revalidation: purges the /isr entry from the (writable)
// incremental cache so the next request re-renders.
export function POST() {
  revalidatePath("/isr");
  return Response.json({ revalidated: true });
}
