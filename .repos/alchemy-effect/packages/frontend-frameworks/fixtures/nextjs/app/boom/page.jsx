export const dynamic = "force-dynamic";

// Always throws during server render — exercises the segment error
// boundary (error.jsx renders client-side after hydration).
export default function Boom() {
  throw new Error("BOOM_FIXTURE_ERROR");
}
