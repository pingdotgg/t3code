import { Card } from "../components/Card.tsx";
import { LocalTime } from "../components/LocalTime.tsx";
import { refreshCachedStamp } from "./actions.ts";
import { readCachedStamp } from "./cached-stamp.ts";

export const dynamic = "force-dynamic";

const buttonClass =
  "mt-4 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50";

export default async function UseCachePage() {
  const cached = await readCachedStamp();
  const request = new Date().toISOString();

  return (
    <main>
      <h1 className="text-3xl font-bold">use cache</h1>
      <Card title="SSR + cached function">
        <p className="text-sm text-slate-900" data-testid="use-cache-request">
          Request: <LocalTime value={request} />
        </p>
        <p className="mt-2 text-sm text-slate-900" data-testid="use-cache-cached">
          Cached: <LocalTime value={cached} />
        </p>
        <form action={refreshCachedStamp}>
          <button className={buttonClass} data-testid="use-cache-refresh" type="submit">
            Revalidate
          </button>
        </form>
      </Card>
    </main>
  );
}
