import { Card } from "./components/Card.tsx";
import { Counter } from "./components/Counter";
import { LocalTime } from "./components/LocalTime.tsx";
import { env } from "../src/Env.ts";

export const dynamic = "force-dynamic";

const greeting = env.GREETING ?? process.env.GREETING ?? "Hello from vinext!";

export default function HomePage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <Card title="SSR">
        <p className="text-sm text-slate-900" data-testid="timestamp">
          Rendered at: <LocalTime value={new Date().toISOString()} />
        </p>
        <Counter />
      </Card>
    </main>
  );
}
