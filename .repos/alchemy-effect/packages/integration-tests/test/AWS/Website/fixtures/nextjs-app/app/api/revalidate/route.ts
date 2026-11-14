import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

// Expire the ISR page; the next request renders it again.
export async function POST() {
  revalidatePath("/isr");
  return Response.json({ revalidated: true });
}
