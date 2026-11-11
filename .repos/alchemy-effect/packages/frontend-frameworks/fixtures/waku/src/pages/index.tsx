import { Counter } from "../components/Counter.tsx";
import { GreetingForm } from "../components/GreetingForm.tsx";
import { readEnv } from "../env.ts";

export default async function HomePage() {
  const env = await readEnv();
  return (
    <div>
      <div data-testid="page-marker">PAGE_MARKER</div>
      <div data-testid="env-message">MESSAGE={String(env.MESSAGE ?? "unset")}</div>
      <Counter />
      <GreetingForm />
    </div>
  );
}

// Dynamic so the worker must serve it at request time (exercises the
// cloudflare:workers env binding in both dev/workerd and preview/miniflare).
export const getConfig = async () => ({ render: "dynamic" }) as const;
