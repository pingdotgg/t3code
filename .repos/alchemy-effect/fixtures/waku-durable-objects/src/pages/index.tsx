import { counterNamespace, readEnv } from "../env.ts";

export default async function HomePage() {
  const env = await readEnv();
  const counter = await counterNamespace();
  // SSR reads the DO at request time — proves the namespace binding resolves
  // to the Counter class exported by the user's worker entry.
  const count = counter ? await counter.getByName("fixture").get() : -1;
  return (
    <div>
      <div data-testid="page-marker">PAGE_MARKER</div>
      <div data-testid="env-message">MESSAGE={String(env.MESSAGE ?? "unset")}</div>
      <div data-testid="do-count">COUNT={count}</div>
    </div>
  );
}

// Dynamic so the worker must serve it at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
