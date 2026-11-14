import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-sm tracking-[0.3em] text-lime-300 uppercase">Shorty</p>
      <h1 className="mt-3 font-serif text-5xl font-semibold text-stone-50">Your links</h1>
      <form className="mt-10 flex gap-3" onSubmit={(event) => event.preventDefault()}>
        <input
          disabled
          placeholder="https://…"
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-stone-100 outline-none"
        />
        <button disabled className="rounded-xl bg-lime-300/40 px-5 py-3 font-medium text-stone-900">
          Shorten
        </button>
      </form>
      <p className="mt-8 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center text-stone-500">
        API offline
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
