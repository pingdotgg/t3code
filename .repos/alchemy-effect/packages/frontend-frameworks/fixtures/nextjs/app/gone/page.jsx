import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// Always 404s via notFound() — exercises the custom not-found boundary
// from a server component (as opposed to an unmatched URL).
export default function Gone() {
  notFound();
}
