import { getEnv } from "waku";
import { Card } from "../components/Card.tsx";

export default async function HomePage() {
  // `getEnv` reads the server environment at request time — the portable
  // way to reach env values from RSC page modules. On AWS it is backed by
  // the Lambda's `process.env`.
  const greeting = getEnv("GREETING") ?? "Hello!";
  return (
    <div>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
      <p className="mt-4 text-slate-600">
        This page is rendered by the server on every request.
      </p>
    </div>
  );
}

// Dynamic: rendered by the Lambda at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
