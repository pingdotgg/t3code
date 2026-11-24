import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./trial.css";

const crew = [
  { area: "PO", art: "po" },
  { area: "Web", art: "web" },
  { area: "API", art: "api" },
  { area: "QA", art: "qa" },
] as const;
type Area = (typeof crew)[number]["area"];
type Mode = "compact" | "expressive";
const titles: Record<Mode, string> = { compact: "Compacta", expressive: "Expressiva" };
type Status = "idle" | "writing" | "working" | "pending";
const signals: Record<Status, { text: string; symbol: string }> = {
  idle: { text: "Disponível", symbol: "○" },
  writing: { text: "Respondendo", symbol: "✎" },
  working: { text: "Trabalhando", symbol: "⚙" },
  pending: { text: "Precisa de você", symbol: "!" },
};
const sequence = [
  { ms: 440, area: "Web", status: "writing", detail: "Validação de e-mail" },
  { ms: 860, area: "API", status: "working", detail: "Rodando testes de cadastro" },
  { ms: 1440, area: "QA", status: "pending", detail: "Aprovar teste de integração" },
] as const;
type Measurement = { mode: Mode; ms: number };

const seconds = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatTime = (ms: number) => `${seconds.format(ms / 1000)} s`;
const otherMode = (mode: Mode): Mode => mode === "compact" ? "expressive" : "compact";

function Run({ mode, onFound, onRestart }: {
  mode: Mode; onFound: (ms: number) => void; onRestart: () => void;
}) {
  const [count, setCount] = useState(0);
  const shown = useRef<number | null>(null);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const timers = sequence.map((event, i) => window.setTimeout(() => setCount(i + 1), event.ms));
    const visibility = () => { if (document.hidden) onRestart(); };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      timers.forEach(window.clearTimeout);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [onRestart]);
  // The clock starts only when React commits the visible request, including delayed renders.
  useLayoutEffect(() => {
    if (count === sequence.length && shown.current === null) shown.current = performance.now();
  }, [count]);
  const events = sequence.slice(0, count);
  function inspect(area: Area) {
    const event = events.find((item) => item.area === area);
    if (event?.status === "pending" && shown.current !== null) {
      const elapsed = performance.now() - shown.current;
      shown.current = null;
      onFound(elapsed);
    } else {
      setFeedback(`${area} está sem pedido de aprovação.`);
    }
  }
  return <>
    <p className="trial-challenge">Abra o pedido de aprovação assim que ele aparecer.</p>
    <div className="trial-roster" data-presentation={mode}>
      {crew.map(({ area, art }) => {
        const event = events.find((item) => item.area === area);
        const status = event?.status ?? "idle";
        const signal = signals[status];
        const expressed = mode === "expressive" && status !== "idle";
        return <button key={area} type="button" className="trial-row" data-status={status}
          onClick={() => inspect(area)} aria-label={`${area}, ${signal.text}${event ? ", " + event.detail : ""}`}>
          <span className="trial-face">
            <img src={`/art/${art}${expressed ? "-active" : ""}.webp`} alt="" />
            {expressed && <span className="trial-emote" aria-hidden="true">{status === "pending" ? "!?" : status === "working" ? "✧" : "♪"}</span>}
          </span>
          <span className="trial-row-copy"><b>{area}</b><span>{event?.detail ?? "Nenhuma atividade"}</span></span>
          <span className="trial-signal"><i aria-hidden="true">{signal.symbol}</i>{signal.text}</span>
        </button>;
      })}
    </div>
    <span className="trial-sr" role="status">{events.at(-1)?.detail || "Aguardando a equipe."}</span>
    <p className="trial-feedback" role="status">{feedback}</p>
  </>;
}

export default function Trial({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const [first] = useState<Mode>(() => crypto.getRandomValues(new Uint8Array(1))[0]! % 2 ? "compact" : "expressive");
  const [results, setResults] = useState<Measurement[]>([]);
  const [running, setRunning] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [ready, setReady] = useState(false);
  const finished = results.length === 2;
  const mode = results.length === 0 ? first : otherMode(first);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    let mounted = true;
    const images = crew.flatMap(({ art }) => ["", "-active"].map((suffix) => {
      const image = new Image();
      image.src = `/art/${art}${suffix}.webp`;
      return image.decode();
    }));
    void Promise.allSettled(images).then(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => { if (!running && results.length > 0) primary.current?.focus(); }, [running, results.length]);
  const restart = useRef(() => {
    setRunning(false);
    setInterrupted(true);
  }).current;
  const compact = results.find((item) => item.mode === "compact");
  const expressive = results.find((item) => item.mode === "expressive");
  const difference = compact && expressive ? Math.round(compact.ms / 10) - Math.round(expressive.ms / 10) : 0;
  return <dialog ref={dialog} className="studio-trial" aria-labelledby="trial-title"
    onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="trial-sheet">
      <header className="trial-head"><span>Apresentações da equipe</span><button type="button" className="trial-close" onClick={onClose} aria-label="Fechar comparação">×</button></header>
      <main className="trial-body">
        <h2 id="trial-title">{finished ? "Sua comparação" : "Encontre a aprovação"}</h2>
        {finished && compact && expressive ? <>
          <p>Tempo entre a aparição do pedido e a sua abertura.</p>
          <dl className="trial-scores">{results.map((entry) =>
            <div key={entry.mode}><dt>{titles[entry.mode]}</dt><dd>{formatTime(entry.ms)}</dd></div>
          )}</dl>
          <p className="trial-observation">{difference === 0 ? "Os tempos coincidiram nesta tentativa." :
            `Nesta tentativa, você abriu o pedido mais rápido na apresentação ${difference > 0 ? "expressiva" : "compacta"}.`}</p>
          <p className="trial-note">Você viu a mesma sequência duas vezes. Reconhecer a posição do pedido pode ajudar na segunda rodada.</p>
          <button ref={primary} type="button" className="trial-primary" onClick={onClose}>Voltar à equipe</button>
        </> : <>
          <div className="trial-round"><span>Rodada {results.length + 1} de 2</span><b>{titles[mode]}</b></div>
          {running ? <Run mode={mode} onRestart={restart}
            onFound={(ms) => { setResults((prev) => [...prev, { mode, ms }]); setRunning(false); }} /> : <>
            {results[0] && <p className="trial-last">Você abriu a aprovação de QA em <b>{formatTime(results[0].ms)}</b>.</p>}
            <p>Duas apresentações, a mesma equipe e os mesmos eventos. Em cada rodada, abra a área que pedir sua aprovação.</p>
            {interrupted && <p className="trial-note">A aba ficou em segundo plano. Reinicie esta rodada para medir seu tempo.</p>}
            <button ref={primary} type="button" className="trial-primary" disabled={!ready} onClick={() => { setInterrupted(false); setRunning(true); }}>
              {ready ? "Começar rodada" : "Preparando retratos…"} <span aria-hidden="true">→</span>
            </button>
          </>}
        </>}
      </main>
    </div>
  </dialog>;
}
