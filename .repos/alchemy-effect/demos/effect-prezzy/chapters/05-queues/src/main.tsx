import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { API_URL, call } from "./client.ts";
import type { Link } from "./Link.ts";
import "./styles.css";

/** Live click count, pushed by the link's Durable Object over a WebSocket. */
function useClicks(code: string) {
  const [clicks, setClicks] = useState<number>();
  useEffect(() => {
    const socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/links/${code}/live`);
    socket.onmessage = (event) => setClicks(JSON.parse(event.data).clicks);
    return () => socket.close();
  }, [code]);
  return clicks;
}

function LinkRow({ link }: { link: Link }) {
  const clicks = useClicks(link.code);
  return (
    <li className="flex items-center gap-6 rounded-2xl border border-white/10 bg-white/5 px-6 py-4">
      <p className="min-w-0 flex-1 truncate text-lg text-stone-100">{link.url}</p>
      <a
        href={`${API_URL}/${link.code}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-sm text-lime-300 hover:underline"
      >
        /{link.code}
      </a>
      <p className="w-16 text-right font-mono text-2xl tabular-nums text-stone-100">
        {clicks ?? "–"}
      </p>
    </li>
  );
}

function App() {
  const [links, setLinks] = useState<readonly Link[]>([]);
  const [url, setUrl] = useState("");

  const refresh = () => call((client) => client.links.list()).then(setLinks);
  useEffect(() => {
    refresh();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!url) return;
    await call((client) => client.links.create({ payload: { url } }));
    setUrl("");
    await refresh();
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-sm tracking-[0.3em] text-lime-300 uppercase">Shorty</p>
      <h1 className="mt-3 font-serif text-5xl font-semibold text-stone-50">Your links</h1>
      <form className="mt-10 flex gap-3" onSubmit={create}>
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
      {links.length === 0 ? (
        <p className="mt-8 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center text-stone-500">
          No links yet
        </p>
      ) : (
        <ul className="mt-8 space-y-3">
          {links.map((link) => (
            <LinkRow key={link.code} link={link} />
          ))}
        </ul>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
