import { Card } from "../components/Card.tsx";
import { LocalTime } from "../components/LocalTime.tsx";

export const dynamic = "force-static";

export default function StaticPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Static</h1>
      <Card title="Prerendered at deploy">
        <p className="text-sm text-slate-900" data-testid="static-time">
          Rendered at: <LocalTime cached value={new Date().toISOString()} />
        </p>
        <p className="mt-2" data-testid="static-marker">
          This page is statically generated.
        </p>
      </Card>
    </main>
  );
}
