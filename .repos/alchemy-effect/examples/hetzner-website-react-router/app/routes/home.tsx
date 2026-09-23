import { useLoaderData } from "react-router";
import { Card } from "../components/Card.tsx";

// Runs on the server (the Hetzner Server systemd unit, or the Vite
// dev server under `alchemy dev`), so it reads the `env` declared in
// alchemy.run.ts from `process.env`.
export function loader() {
  return { greeting: process.env.GREETING ?? "Hello!" };
}

export default function Home() {
  const { greeting } = useLoaderData() as { greeting: string };
  return (
    <main>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </main>
  );
}
