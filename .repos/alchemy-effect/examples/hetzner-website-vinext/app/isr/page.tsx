export const revalidate = 60;

export default function IsrPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">ISR</h1>
      <p className="mt-4 text-slate-600">
        Rendered at {new Date().toISOString()} (revalidate 60s). On Hetzner this
        is in-process memory unless you set REDIS_URL.
      </p>
    </main>
  );
}
