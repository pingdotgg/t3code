import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Card } from "../components/Card.tsx";
import { env } from "../env.ts";

// Runs on the server for both the SSR render and client navigations — in
// the deployed Worker (or, under `alchemy dev`, in TanStack Start's own
// Vite dev server). The `env` declared on the Website in alchemy.run.ts
// is available through the `cloudflare:workers` env proxy.
const getGreeting = createServerFn({ method: "GET" }).handler(
  () => env.GREETING ?? "Hello!",
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
