import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Card } from "../components/Card.tsx";

// Runs on the server for both the SSR render and client navigations — in
// the deployed Railway Service (or, under `alchemy dev`, in TanStack
// Start's own Vite dev server). The `env` values declared in
// alchemy.run.ts are available on `process.env` either way.
const getGreeting = createServerFn({ method: "GET" }).handler(
  () => process.env.GREETING ?? "Hello!",
);

export const Route = createFileRoute("/")({
  loader: () => getGreeting(),
  component: Home,
});

function Home() {
  const greeting = Route.useLoaderData();
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
