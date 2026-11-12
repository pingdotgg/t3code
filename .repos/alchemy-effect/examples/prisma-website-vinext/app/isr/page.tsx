export const revalidate = 60;

export default function IsrPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">ISR</h1>
      <p className="mt-4 text-slate-600">
        Rendered at {new Date().toISOString()} (revalidate 60s). The cache stays in memory unless
        REDIS_URL configures a shared Redis store.
      </p>
    </main>
  );
}
