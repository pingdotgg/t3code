import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ShortyApi, type LinkView } from "../../src/ShortyApi.ts";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL as string;

// A typed client derived from the same `ShortyApi` value the Worker serves.
const makeClient = HttpApiClient.make(ShortyApi, { baseUrl: API_URL });

const call = <A, E>(f: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>) =>
  Effect.runPromise(makeClient.pipe(Effect.flatMap(f), Effect.provide(FetchHttpClient.layer)));

/** Live click count for one link, pushed by its Durable Object over a WebSocket. */
function useClicks(code: string, initial: number) {
  const [clicks, setClicks] = useState(initial);
  useEffect(() => {
    const socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/links/${code}/live`);
    socket.onmessage = (event) => setClicks(JSON.parse(event.data).clicks);
    return () => socket.close();
  }, [code]);
  return clicks;
}

function LinkRow({ link }: { link: LinkView }) {
  const clicks = useClicks(link.code, link.clicks);
  const short = `${API_URL}/${link.code}`;
  return (
    <li className="flex items-center gap-6 rounded-2xl border border-white/10 bg-white/5 px-6 py-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-lg font-medium text-stone-100">
          {link.preview?.title ?? <span className="text-stone-500">Fetching preview…</span>}
        </p>
        <p className="truncate text-sm text-stone-400">{link.url}</p>
      </div>
      <a
        href={short}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-sm text-lime-300 hover:underline"
      >
        /{link.code}
      </a>
      <p className="w-20 text-right font-mono text-2xl tabular-nums text-stone-100">{clicks}</p>
    </li>
  );
}

function App() {
  const [links, setLinks] = useState<readonly LinkView[]>([]);
  const [url, setUrl] = useState("");

  const refresh = () => call((client) => client.links.list()).then(setLinks);

  useEffect(() => {
    refresh();
    // Previews arrive from the background job; poll until every link has one.
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!url) return;
    await call((client) => client.links.create({ payload: { url } }));
    setUrl("");
    refresh();
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-sm tracking-[0.3em] text-lime-300 uppercase">Shorty</p>
      <h1 className="mt-3 font-serif text-5xl font-semibold text-stone-50">Your links</h1>
      <form onSubmit={create} className="mt-10 flex gap-3">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-stone-100 outline-none focus:border-lime-300/60"
        />
        <button className="rounded-xl bg-lime-300 px-5 py-3 font-medium text-stone-900">
          Shorten
        </button>
      </form>
      <ul className="mt-8 space-y-3">
        {links.map((link) => (
          <LinkRow key={link.code} link={link} />
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
