export function App() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16 leading-relaxed">
      <h1 className="text-3xl font-bold">Web</h1>
      <p className="mt-4">
        Served through the shared <code>AWS.Website.Router</code>.
      </p>
      <p className="mt-2">
        This page is mounted at <code>/</code>.
      </p>
      <p className="mt-2">
        Edit <code>apps/web/src/App.tsx</code> and this updates instantly under{" "}
        <code>alchemy dev</code>.
      </p>
      <p className="mt-2">
        <a className="text-blue-600 underline" href="/docs/">
          Go to the docs site &rarr;
        </a>
      </p>
      <pre className="mt-4 rounded-lg bg-slate-100 p-3 text-sm">
        location.pathname = {location.pathname}
      </pre>
    </main>
  );
}
