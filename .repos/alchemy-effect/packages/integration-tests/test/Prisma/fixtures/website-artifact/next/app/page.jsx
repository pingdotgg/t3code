export const dynamic = "force-dynamic";

export default function Page() {
  return <h1>{process.env.NEXT_PUBLIC_ARTIFACT_GREETING}</h1>;
}
