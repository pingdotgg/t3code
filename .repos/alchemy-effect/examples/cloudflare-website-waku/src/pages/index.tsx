import { getEnv } from "waku";
import { Card } from "../components/Card.tsx";

export default async function HomePage() {
  // `getEnv` reads the Worker env at request time — the portable way to
  // reach bindings and env values from RSC page modules. (A top-level
  // `import { env } from "cloudflare:workers"` would break waku's Node-side
  // SSG step.)
  const greeting = getEnv("GREETING") ?? "Hello!";
  return (
    <div>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
      <p className="mt-4 text-slate-600">
        This page is rendered by the Worker on every request.
      </p>
    </div>
  );
}

// Dynamic: rendered by the Worker at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
