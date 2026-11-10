import { Card } from "../components/Card.tsx";
import { LocalTime } from "../components/LocalTime.tsx";
import { refreshCachedPage } from "./actions.ts";

export const revalidate = 30;

const buttonClass =
  "mt-4 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50";

export default function CachedPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Cached</h1>
      <Card title="revalidate=30">
        <p className="text-sm text-slate-900" data-testid="isr-time">
          Rendered at: <LocalTime cached value={new Date().toISOString()} />
        </p>
        <form action={refreshCachedPage}>
          <button className={buttonClass} data-testid="isr-refresh" type="submit">
            Refresh cache now
          </button>
        </form>
      </Card>
    </main>
  );
}
