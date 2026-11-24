import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Code2,
  Folder,
  GitBranch,
  MessageCircle,
  MessageSquare,
  MoreVertical,
  PanelLeft,
  Paperclip,
  PenLine,
  Plus,
  ScanFace,
  SlidersHorizontal,
  Square,
  Terminal,
  User,
  X,
} from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { generatePortrait } from "./portraits/generatePortrait";
import { blank, initialLetters, labels, newArea, newThread, readStudio, savedArt, saveArt, storeKey } from "./model";
import type { Activity, Area, Art, Snapshot, StepItem, Studio } from "./model";
import Trial from "./Trial";
import "./studio.css";

type Portrait = { state: "ready"; art: Art } | { state: "busy" | "error" };

const seedArt = (slug: string): Portrait => ({
  state: "ready",
  art: { normal: `/art/${slug}.webp`, expressive: `/art/${slug}-active.webp` },
});

const prompts: Record<string, string[]> = {
  po: ["Refinar uma ideia", "Definir critérios de aceite"],
  web: ["Revisar o formulário de cadastro", "Explicar a validação de e-mail"],
  api: ["Revisar o contrato da API", "Inspecionar a integração"],
  qa: ["Listar cenários de teste", "Verificar o cadastro"],
};

function branchSlug(name: string) {
  const clean = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "geral";
}

function emoteFor(status: Activity): string | null {
  if (status === "pending") return "!?";
  if (status === "working") return "✧";
  if (status === "responding") return "♪";
  return null;
}

function ScribbleUnderline({ className = "markerLine" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 180 12" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M2 7.5 C46 5.2, 128 3.8, 178 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="M14 10.2 C66 8.6, 134 7.4, 169 7.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}

function InkBlotLogo() {
  return (
    <span className="brandBlot">
      <svg className="blotSvg" viewBox="0 0 144 40" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M8 9 C18 4, 52 3, 94 4 C118 4, 132 5, 138 9 C142 13, 141 28, 136 33 C128 37, 92 36, 50 36 C24 36, 10 35, 6 30 C2 24, 3 13, 8 9 Z"
          fill="var(--ink)"
          filter="url(#scribble-ink)"
        />
        <path
          d="M4 16 L10 14 M136 13 L142 15 M6 27 L12 29 M134 29 L141 27"
          stroke="var(--ink)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="brandText">
        <em>T3</em> Code
      </span>
    </span>
  );
}

function BubbleTail({ align = "bottom" }: { align?: "top" | "bottom" }) {
  return (
    <svg
      className={`bubbleTail ${align}`}
      width="14"
      height="16"
      viewBox="0 0 14 16"
      aria-hidden="true"
    >
      <path d="M14 1 L2 11.5 L14 14.2 Z" fill="var(--paper-bright)" />
      <path
        d="M13.6 1.4 L1.8 11.5 L13.6 14"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#scribble-ink)"
      />
    </svg>
  );
}

function Status({ status, detail, underline = false }: { status: Activity; detail?: string; underline?: boolean }) {
  const label = detail || labels[status];
  if (status === "responding") {
    return (
      <span className={`status s-responding ${underline ? "withMarker" : ""}`}>
        <MessageCircle size={15} strokeWidth={2} aria-hidden />
        <span className="statusLabel">
          {label}
          {underline && <ScribbleUnderline className="statusMarker" />}
        </span>
      </span>
    );
  }
  if (status === "working" || status === "idle") {
    return (
      <span className={`status s-${status}`}>
        <i className="dotMark green" aria-hidden />
        <span className="statusLabel">{label}</span>
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="status s-pending">
        <i className="dotMark amber" aria-hidden />
        <span className="statusLabel">{label}</span>
      </span>
    );
  }
  return (
    <span className="status s-error">
      <CircleAlert size={14} aria-hidden />
      <span className="statusLabel">{label}</span>
    </span>
  );
}

function Face({ area, portrait, active = false }: { area: Area; portrait: Portrait; active?: boolean }) {
  return portrait.state === "ready" ? (
    <img
      className="face"
      src={active ? portrait.art.expressive : portrait.art.normal}
      alt={`Retrato de ${area.persona}`}
    />
  ) : (
    <span className="initials">{initialLetters(area.role)}</span>
  );
}

function HeroPanel({
  area,
  portrait,
  status,
  hot,
  run,
  brokenPanels,
  onPanelError,
}: {
  area: Area;
  portrait: Portrait;
  status: Activity;
  hot: boolean;
  run: boolean;
  brokenPanels: Record<string, boolean>;
  onPanelError: (preset: string) => void;
}) {
  const usePresetPanel = Boolean(area.preset && !(hot && run) && !brokenPanels[area.preset]);
  const emote = hot && run ? emoteFor(status) : null;

  return (
    <div
      className={`heroPanel ${hot && run ? "expressiveRun" : ""}`}
      data-status={status}
      key={`${area.id}-${hot && run ? status : "rest"}`}
    >
      {usePresetPanel && area.preset ? (
        <img
          className="heroPanelImg"
          src={`/art/${area.preset}-panel.webp`}
          alt={`Painel de ${area.persona}`}
          onError={() => onPanelError(area.preset!)}
        />
      ) : (
        <div className="heroScene">
          <div className="heroHalftone" aria-hidden="true" />
          <svg className="heroLaptop" viewBox="0 0 240 170" aria-hidden="true">
            <path
              d="M-8 168 L-8 82 L148 56 C155 55, 161 60, 163 67 L186 168 Z"
              fill="#1d191a"
              stroke="#1d191a"
              strokeWidth="2.5"
              strokeLinejoin="round"
              filter="url(#scribble-ink)"
            />
            <path
              d="M6 94 L145 70 L166 164 L6 164 Z"
              fill="none"
              stroke="#443c3d"
              strokeWidth="1.2"
              strokeDasharray="3 4"
            />
            <g transform="translate(88 124) rotate(-10)">
              <rect
                x="-28"
                y="-20"
                width="56"
                height="40"
                rx="4"
                fill="none"
                stroke="#fbf6ee"
                strokeWidth="2.4"
              />
              <path
                d="M-11 -7 L-19 0 L-11 7 M11 -7 L19 0 L11 7 M3 -9 L-3 9"
                fill="none"
                stroke="#fbf6ee"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          </svg>
          <svg className="heroTicks" viewBox="0 0 64 70" aria-hidden="true">
            <path
              d="M42 8 L50 30 M16 26 L36 39 M12 52 L32 54"
              fill="none"
              stroke="#1d191a"
              strokeWidth="5.2"
              strokeLinecap="round"
              filter="url(#scribble-ink)"
            />
          </svg>
          <div className={`heroStage ${portrait.state !== "ready" ? "provisional" : ""}`}>
            <Face area={area} portrait={portrait} active={hot && run} />
            {portrait.state === "busy" && (
              <span className="heroDrawingTag">
                <PenLine size={12} /> Gerando retrato
              </span>
            )}
          </div>
          {emote && (
            <span className="heroEmote" aria-hidden="true">
              {emote}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StepStrip({
  steps,
  working,
  detail,
}: {
  steps: StepItem[];
  working: boolean;
  detail: string;
}) {
  const [open, setOpen] = useState(false);

  if (steps.length > 0) {
    const activeStep = [...steps].reverse().find((s) => !s.done) ?? steps[steps.length - 1]!;
    const hasMore = steps.length > 1;
    return (
      <div className="steps">
        <div className="stepsBar">
          <div className="stepMain">
            {activeStep.done ? (
              <Check size={15} strokeWidth={2.3} className="stepIcon done" aria-hidden />
            ) : (
              <Terminal size={15} strokeWidth={2.2} className="stepIcon live" aria-hidden />
            )}
            <span className="stepText">{activeStep.label}</span>
            {!activeStep.done && detail && detail !== activeStep.label && (
              <span className="stepDetail">{detail}</span>
            )}
          </div>
          {hasMore ? (
            <button
              type="button"
              className="stepToggle"
              aria-expanded={open}
              aria-label={open ? "Recolher passos" : "Expandir passos"}
              onClick={() => setOpen((v) => !v)}
            >
              <span>{steps.length}</span>
              {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          ) : (
            <span className="stepChevronStatic" aria-hidden="true">
              <ChevronDown size={15} />
            </span>
          )}
        </div>
        {open && hasMore && (
          <ul className="stepsList">
            {steps.map((s) => (
              <li key={s.id} className={s.done ? "done" : "live"}>
                {s.done ? (
                  <Check size={14} strokeWidth={2.3} aria-hidden />
                ) : (
                  <Terminal size={14} strokeWidth={2.2} aria-hidden />
                )}
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (working) {
    return (
      <div className="op">
        <Terminal size={15} strokeWidth={2.2} aria-hidden />
        <strong>Trabalhando</strong>
        {detail && <span className="opDetail">{detail}</span>}
      </div>
    );
  }

  return null;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="modal"
    >
      <header>
        <h2>{title}</h2>
        <button type="button" className="iconBtn" aria-label="Fechar" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function App() {
  const [studio, setStudio] = useState<Studio>(readStudio);
  const [pictures, setPictures] = useState<Record<string, Portrait>>({});
  const jobs = useRef(new Set<string>());
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>({});
  const [offline, setOffline] = useState<string[]>([]);
  const [form, setForm] = useState<"area" | "rename" | "trial" | null>(null);
  const [name, setName] = useState("");
  const [descr, setDescr] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [storageError, setStorageError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState("");
  const [brokenPanels, setBrokenPanels] = useState<Record<string, boolean>>({});
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const requestBox = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  const area = studio.areas.find((a) => a.threads.some((t) => t.id === studio.selected)) || studio.areas[0]!;
  const thread = area.threads.find((t) => t.id === studio.selected) || area.threads[0]!;
  const snap = snaps[thread.id] || blank(thread.id);
  const getPicture = (a: Area): Portrait => (a.preset ? seedArt(a.preset) : pictures[a.id] || { state: "busy" });
  const hot = studio.mode === "expressive";
  const ignoreStale = useRef(new Map<string, number>());
  const reqOrder = useRef(0);

  function publish(data: Snapshot, order: number) {
    if (order < (ignoreStale.current.get(data.id) ?? 0)) return;
    ignoreStale.current.set(data.id, order);
    setSnaps((prev) => ({ ...prev, [data.id]: data }));
  }

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(studio));
    } catch {
      setStorageError("O navegador não conseguiu salvar as áreas neste dispositivo.");
    }
  }, [studio]);

  async function renderArt(a: Area) {
    if (jobs.current.has(a.id)) return;
    jobs.current.add(a.id);
    setPictures((p) => ({ ...p, [a.id]: { state: "busy" } }));
    try {
      let art = await savedArt(a.id);
      if (!art) {
        art = await generatePortrait({ id: a.id, name: a.original, description: a.description });
        await saveArt(a.id, art);
      }
      setPictures((p) => ({ ...p, [a.id]: { state: "ready", art } }));
    } catch {
      setPictures((p) => ({ ...p, [a.id]: { state: "error" } }));
    } finally {
      jobs.current.delete(a.id);
    }
  }

  useEffect(() => {
    for (const a of studio.areas) {
      if (!a.preset && !pictures[a.id]) void renderArt(a);
    }
  }, [studio.areas, pictures]);

  const watched = studio.areas.flatMap((a) => a.threads.filter((t) => t.sent).map((t) => t.id)).join(",");
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: number;
    async function tick() {
      const ids = watched ? watched.split(",") : [];
      const failed: string[] = [];
      let ok = false;
      await Promise.all(
        (ids.length ? ids : [""]).map(async (id) => {
          const order = ++reqOrder.current;
          try {
            const r = await fetch(id ? `/api/threads/${id}` : "/api/status", {
              signal: ctrl.signal,
              cache: "no-store",
            });
            if (!r.ok) throw Error();
            const data = await r.json();
            if (ctrl.signal.aborted) return;
            if (id) publish(data, order);
            ok = true;
          } catch {
            if (id) failed.push(id);
          }
        }),
      );
      if (!ctrl.signal.aborted) {
        setConnected(ok);
        setOffline(failed);
        timer = window.setTimeout(tick, ids.length ? 500 : 3500);
      }
    }
    void tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [watched]);

  useEffect(() => {
    if (focusRequest === thread.id && snap.pending) {
      requestBox.current?.focus();
      requestBox.current?.scrollIntoView({ block: "nearest" });
      setFocusRequest("");
    }
  }, [focusRequest, thread.id, snap.pending]);

  const last = snap.messages.at(-1);
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
  }, [thread.id]);
  useEffect(() => {
    if (scroll.current && follow.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [thread.id, last?.text, snap.pending?.id, snap.steps?.length]);

  function select(id: string, request = false) {
    setStudio((s) => ({ ...s, selected: id }));
    setDrawer(false);
    if (request) setFocusRequest(id);
  }

  function addThread(a: Area) {
    const t = newThread();
    setStudio((s) => ({
      ...s,
      selected: t.id,
      areas: s.areas.map((x) => (x.id === a.id ? { ...x, threads: [...x.threads, t] } : x)),
    }));
    setDrawer(false);
  }

  const allPending = studio.areas.flatMap((a) => a.threads).filter((t) => snaps[t.id]?.pending);

  function openForm(type: "area" | "rename") {
    setName(type === "rename" ? area.role : "");
    setDescr("");
    setForm(type);
  }

  function submitArea(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (form === "rename") {
      setStudio((s) => ({
        ...s,
        areas: s.areas.map((a) => (a.id === area.id ? { ...a, role: name.trim() } : a)),
      }));
    } else {
      const a = newArea(name.trim(), descr.trim());
      setStudio((s) => ({ ...s, areas: [...s.areas, a], selected: a.threads[0]!.id }));
      setDrawer(false);
    }
    setForm(null);
  }

  async function act(action: "send" | "interrupt" | "answer", value?: string) {
    const id = thread.id;
    if (busy[id]) return;
    const text = (drafts[id] ?? "").trim();
    if (action === "send" && !text) return;
    setBusy((p) => ({ ...p, [id]: true }));
    setErrors((p) => ({ ...p, [id]: "" }));
    const order = ++reqOrder.current;
    try {
      const body =
        action === "send"
          ? { action, text, title: `${area.role} · ${text.slice(0, 75)}` }
          : action === "answer"
            ? { action, requestId: snap.pending?.id, value }
            : { action };
      const r = await fetch(`/api/threads/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "O T3 recusou o pedido.");
      if (data.id === id) publish(data, order);
      if (action === "send") {
        setDrafts((p) => ({ ...p, [id]: "" }));
        setStudio((s) => ({
          ...s,
          areas: s.areas.map((a) => ({
            ...a,
            threads: a.threads.map((t) =>
              t.id === id ? { ...t, sent: true, title: t.sent ? t.title : text.slice(0, 64) } : t,
            ),
          })),
        }));
      }
    } catch (e) {
      setErrors((p) => ({ ...p, [id]: e instanceof Error ? e.message : "Falha de conexão. Tente novamente." }));
    } finally {
      setBusy((p) => ({ ...p, [id]: false }));
    }
  }

  const activePic = getPicture(area);
  const run = ["working", "responding", "pending"].includes(snap.status);
  const displayTitle = thread.sent ? thread.title : `Conversa com ${area.persona}`;
  const statusOffline = offline.includes(thread.id);
  const steps = snap.steps ?? [];
  const lastAssistantIndex = snap.messages.reduce((idx, m, i) => (m.role === "assistant" ? i : idx), -1);

  const heroElement = (
    <HeroPanel
      area={area}
      portrait={activePic}
      status={snap.status}
      hot={hot}
      run={run}
      brokenPanels={brokenPanels}
      onPanelError={(preset) => setBrokenPanels((prev) => ({ ...prev, [preset]: true }))}
    />
  );

  return (
    <div className={`app ${hot ? "expressive" : "compact"}`} style={{ "--accent": area.color } as CSSProperties}>
      <svg width="0" height="0" aria-hidden="true" className="svgDefs">
        <defs>
          <filter id="scribble-ink" x="-6%" y="-6%" width="112%" height="112%">
            <feTurbulence type="fractalNoise" baseFrequency="0.032" numOctaves="2" seed="4" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      <header className="mast">
        <div className="mastLeft">
          <div className="brand">
            <InkBlotLogo />
          </div>
          <span className="mastRule" aria-hidden="true" />
          <div className="crumb">
            <Folder size={17} strokeWidth={2} aria-hidden />
            <span>
              estúdio <em>/</em> equipe
            </span>
          </div>
        </div>

        <div className="mastRight">
          <span className={`connect ${connected ? "up" : ""}`}>
            <i aria-hidden="true" />
            {connected ? "T3 conectado" : "T3 desconectado"}
          </span>
          <button type="button" className="compare" onClick={() => setForm("trial")}>
            <BookOpen size={15} strokeWidth={2} aria-hidden />
            <span>Comparar modos</span>
          </button>
          <span className="mastRule" aria-hidden="true" />
          <button
            type="button"
            className={`iconBtn bellBtn ${allPending.length > 0 ? "hasPending" : ""}`}
            aria-label={
              allPending.length > 0
                ? `${allPending.length} ${allPending.length === 1 ? "pendência" : "pendências"} aguardando`
                : "Sem pendências"
            }
            title={allPending.length > 0 ? "Ir para a próxima pendência" : "Sem pendências"}
            onClick={() => {
              if (allPending.length > 0) select(allPending[0]!.id, true);
            }}
          >
            <Bell size={18} strokeWidth={2} />
            {allPending.length > 0 && <span className="bellBadge" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`iconBtn modeToggle ${hot ? "on" : ""}`}
            aria-label={hot ? "Usar apresentação compacta" : "Usar apresentação expressiva"}
            aria-pressed={hot}
            title={hot ? "Apresentação expressiva ativa" : "Apresentação compacta ativa"}
            onClick={() => setStudio((s) => ({ ...s, mode: s.mode === "compact" ? "expressive" : "compact" }))}
          >
            {hot ? <ScanFace size={18} strokeWidth={2} /> : <SlidersHorizontal size={18} strokeWidth={2} />}
          </button>
        </div>
      </header>

      <div className="columns">
        <nav className="rail" aria-label="Navegação do estúdio">
          <button
            type="button"
            className="railBtn activeCode"
            aria-label="Estúdio de código"
            title="Estúdio"
            onClick={() => {
              setDrawer(false);
              promptBox.current?.focus();
            }}
          >
            <Code2 size={20} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="railBtn"
            aria-label="Conversa ativa"
            title="Conversa ativa"
            onClick={() => {
              setDrawer(false);
              promptBox.current?.focus();
            }}
          >
            <MessageSquare size={19} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="railBtn"
            aria-label="Nova área"
            title="Criar nova área"
            onClick={() => openForm("area")}
          >
            <GitBranch size={19} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="railBtn"
            aria-label="Comparar modos"
            title="Comparar modos"
            onClick={() => setForm("trial")}
          >
            <BookOpen size={19} strokeWidth={1.9} />
          </button>
        </nav>

        {drawer && <button type="button" className="drawerScrim" aria-label="Fechar equipe" onClick={() => setDrawer(false)} />}

        <aside className={drawer ? "sidebar opened" : "sidebar"} aria-label="Equipe">
          <div className="sideHead">
            <div className="sideTitleWrap">
              <h2>
                <span>Equipe</span>
                <ScribbleUnderline className="headMarker" />
              </h2>
            </div>
            <div className="sideActions">
              <button
                type="button"
                className="add"
                title="Criar área"
                aria-label="Criar área"
                onClick={() => openForm("area")}
              >
                <Plus size={18} strokeWidth={2.3} />
              </button>
              <button
                type="button"
                className="iconBtn sideMenuBtn"
                title="Renomear área atual"
                aria-label="Renomear área atual"
                onClick={() => openForm("rename")}
              >
                <MoreVertical size={18} strokeWidth={2.1} />
              </button>
              <button
                type="button"
                className="mobileClose iconBtn"
                aria-label="Fechar equipe"
                onClick={() => setDrawer(false)}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="roster">
            {studio.areas.map((a) => {
              const selected = a.id === area.id;
              const items = a.threads.map((t) => snaps[t.id] || blank(t.id));
              const waiting = a.threads.filter((t) => snaps[t.id]?.status === "pending");
              const active = items.filter((s) => s.status === "working" || s.status === "responding");
              const primary =
                items.find((s) => s.status === "pending") ||
                active[0] ||
                items.find((s) => s.status === "error") ||
                items[0]!;
              const portrait = getPicture(a);
              const open = expanded[a.id] ?? selected;
              const memberEmote = hot && primary.status !== "idle" ? emoteFor(primary.status) : null;

              return (
                <article
                  key={a.id}
                  style={{ "--member": a.color } as CSSProperties}
                  className={`member ${selected ? "selected" : ""} ${primary.status === "pending" ? "waiting" : ""}`}
                >
                  <button
                    type="button"
                    className={`avatarBtn ${hot && primary.status !== "idle" ? "activity" : ""} ${
                      portrait.state !== "ready" ? "provisional" : ""
                    }`}
                    aria-label={`Selecionar ${a.persona}, ${a.role}`}
                    onClick={() => {
                      select(selected ? thread.id : a.threads[0]!.id);
                      setExpanded((p) => ({ ...p, [a.id]: true }));
                    }}
                  >
                    <Face area={a} portrait={portrait} active={hot && primary.status !== "idle"} />
                    {memberEmote && (
                      <span className="avatarEmote" aria-hidden="true">
                        {memberEmote}
                      </span>
                    )}
                  </button>

                  <div className="memberCol">
                    <div className="memberTop">
                      <button
                        type="button"
                        className="memberPick"
                        onClick={() => {
                          select(selected ? thread.id : a.threads[0]!.id);
                          setExpanded((p) => ({ ...p, [a.id]: true }));
                        }}
                      >
                        <strong>
                          {a.persona} <span>· {a.role}</span>
                        </strong>
                      </button>
                      <button
                        type="button"
                        className="disclose"
                        aria-label={(open ? "Recolher " : "Expandir ") + a.role}
                        aria-expanded={open}
                        onClick={() => setExpanded((p) => ({ ...p, [a.id]: !open }))}
                      >
                        {open ? <ChevronDown size={17} strokeWidth={2.1} /> : <ChevronRight size={17} strokeWidth={2.1} />}
                      </button>
                    </div>

                    <div className="memberMeta">
                      {waiting.length > 0 ? (
                        <button
                          type="button"
                          className="waitLink"
                          onClick={() => select(waiting[0]!.id, true)}
                        >
                          <i className="dotMark amber" aria-hidden />
                          <span>
                            {a.threads.length > 1 ? `${waiting.length} precisa de você` : "Precisa de você"}
                            {active.length > 0 ? ` · ${active.length} em execução` : ""}
                          </span>
                        </button>
                      ) : active.length > 1 ? (
                        <Status status="working" detail={`${active.length} em execução`} />
                      ) : (
                        <>
                          <Status status={primary.status} underline={primary.status === "responding"} />
                          {primary.status === "working" && primary.detail && (
                            <small className="memberDetail">{primary.detail}</small>
                          )}
                        </>
                      )}

                      {portrait.state === "busy" && (
                        <small className="drawing">
                          <PenLine size={12} aria-hidden /> Gerando retrato
                        </small>
                      )}
                      {portrait.state === "error" && (
                        <button type="button" className="retry" onClick={() => void renderArt(a)}>
                          Tentar gerar novamente
                        </button>
                      )}
                      {a.threads.some((t) => offline.includes(t.id)) && (
                        <small className="reconnecting">Reconectando…</small>
                      )}
                    </div>

                    {open && (
                      <div className="threadList">
                        {a.threads.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={`threadItem ${t.id === thread.id ? "current" : ""}`}
                            onClick={() => select(t.id, Boolean(snaps[t.id]?.pending))}
                          >
                            <MessageSquare size={13} strokeWidth={2} aria-hidden />
                            <span className="threadTitle">{t.title}</span>
                            {snaps[t.id]?.pending && <i className="dotMark amber tinyDot" aria-hidden />}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="newThread"
                          aria-label={`Nova conversa em ${a.role}`}
                          onClick={() => addThread(a)}
                        >
                          <Plus size={13} strokeWidth={2.2} aria-hidden />
                          <span>Conversa</span>
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="sideFoot">
            <div className="eyebrow">
              <SlidersHorizontal size={12} aria-hidden /> APRESENTAÇÃO
            </div>
            <div className="switch">
              {(["compact", "expressive"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={studio.mode === m}
                  className={studio.mode === m ? "on" : ""}
                  onClick={() => setStudio((s) => ({ ...s, mode: m }))}
                >
                  {m === "compact" ? <PanelLeft size={14} aria-hidden /> : <ScanFace size={15} aria-hidden />}
                  <span>{m === "compact" ? "Compacta" : "Expressiva"}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main>
          <div className="chatTop">
            <div className="chatHeadLeft">
              <button
                type="button"
                className="iconBtn mobileOpen"
                aria-label="Abrir equipe"
                onClick={() => setDrawer(true)}
              >
                <PanelLeft size={19} />
              </button>
              <div className="chatTitleBlock">
                <h1>
                  <span>{displayTitle}</span>
                  <ScribbleUnderline className="headMarker" />
                </h1>
              </div>
              <span className="chatRule" aria-hidden="true" />
              <span className="branchTag">
                <GitBranch size={15} strokeWidth={2} aria-hidden />
                <span className="branchPill">feat/{branchSlug(area.original)}</span>
              </span>
            </div>

            <div className="chatTools">
              <button
                type="button"
                className="iconBtn toolFrame"
                title="Renomear área"
                aria-label="Renomear área"
                onClick={() => openForm("rename")}
              >
                <PenLine size={16} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="iconBtn toolFrame"
                title="Nova conversa"
                aria-label="Nova conversa"
                onClick={() => addThread(area)}
              >
                <MessageSquare size={16} strokeWidth={2} />
                <Plus className="tinyPlus" size={10} strokeWidth={2.8} />
              </button>
            </div>
          </div>

          <div
            className="chatBody"
            ref={scroll}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 70;
            }}
          >
            <div className="feed">
              {!snap.messages.length && (
                <>
                  {heroElement}
                  <div className="welcome">
                    <div className="byline">
                      <span className="miniFace">
                        <Face area={area} portrait={activePic} active={hot && run} />
                      </span>
                      <strong>{area.persona}</strong>
                      <span className="bylineRole">{area.role}</span>
                      <Status status={snap.status} underline={snap.status === "responding"} />
                    </div>
                    <h2>Por onde começamos?</h2>
                    <div className="chips">
                      {(prompts[area.original.toLowerCase()] || [
                        "Rodar os testes de cadastro",
                        "Revisar a documentação",
                      ]).map((x) => (
                        <button
                          key={x}
                          type="button"
                          onClick={() => {
                            setDrafts((p) => ({ ...p, [thread.id]: x }));
                            promptBox.current?.focus();
                          }}
                        >
                          <span>{x}</span>
                          <ArrowDownLeft size={14} aria-hidden />
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {snap.messages.map((m, i) => {
                const isLatestAssistant = m.role === "assistant" && i === lastAssistantIndex;
                const isLastMessage = i === snap.messages.length - 1;
                return (
                  <React.Fragment key={m.id}>
                    {isLatestAssistant && heroElement}
                    {m.role === "user" ? (
                      <section className="msg user">
                        <span className="userSquare" aria-hidden="true">
                          <User size={21} strokeWidth={2.2} />
                        </span>
                        <div className="bubble userBubble">
                          <BubbleTail align="top" />
                          <span className="bubbleText">{m.text}</span>
                        </div>
                      </section>
                    ) : (
                      <section className="msg assistant">
                        <div className="byline">
                          <span className="miniFace">
                            <Face area={area} portrait={activePic} active={hot && run} />
                          </span>
                          <strong>{area.persona}</strong>
                          {isLatestAssistant && (snap.status === "responding" || snap.status === "working" || snap.status === "pending") && (
                            <Status status={snap.status} underline={snap.status === "responding"} />
                          )}
                        </div>
                        {isLatestAssistant && (steps.length > 0 || snap.status === "working") && (
                          <StepStrip steps={steps} working={snap.status === "working"} detail={snap.detail} />
                        )}
                        <div className="bubble assistantBubble">
                          <BubbleTail align="bottom" />
                          <span className="bubbleText">
                            {m.text}
                            {isLastMessage && snap.status === "responding" && (
                              <i className="caret" aria-hidden="true" />
                            )}
                          </span>
                        </div>
                      </section>
                    )}
                  </React.Fragment>
                );
              })}

              {snap.messages.length > 0 && lastAssistantIndex === -1 && (
                <>
                  {heroElement}
                  {(run || steps.length > 0) && (
                    <div className="msg assistant pendingTurn">
                      <div className="byline">
                        <span className="miniFace">
                          <Face area={area} portrait={activePic} active={hot && run} />
                        </span>
                        <strong>{area.persona}</strong>
                        <Status status={snap.status} underline={snap.status === "responding"} />
                      </div>
                      {(steps.length > 0 || snap.status === "working") && (
                        <StepStrip steps={steps} working={snap.status === "working"} detail={snap.detail} />
                      )}
                    </div>
                  )}
                </>
              )}

              {snap.pending && (
                <div className="request" ref={requestBox} tabIndex={-1}>
                  <div className="requestEyebrow">
                    <i className="dotMark amber" aria-hidden />
                    <span>PRECISA DE VOCÊ</span>
                  </div>
                  <h3>{snap.pending.kind === "approval" ? "Aprovação pendente" : "Pergunta da agente"}</h3>
                  <p>{snap.pending.text}</p>
                  {snap.pending.kind === "approval" ? (
                    <div className="requestActions">
                      <button
                        type="button"
                        className="solid"
                        disabled={busy[thread.id]}
                        onClick={() => void act("answer", "approve")}
                      >
                        <Check size={15} /> Aprovar
                      </button>
                      <button
                        type="button"
                        className="paperBtn"
                        disabled={busy[thread.id]}
                        onClick={() => void act("answer", "decline")}
                      >
                        Recusar
                      </button>
                    </div>
                  ) : (
                    <form
                      className="questionForm"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act("answer", answers[snap.pending!.id]);
                      }}
                    >
                      {snap.pending.options.length > 0 && (
                        <div className="optionRow">
                          {snap.pending.options.map((o) => (
                            <button
                              key={o}
                              type="button"
                              className="paperBtn"
                              disabled={busy[thread.id]}
                              onClick={() => void act("answer", o)}
                            >
                              {o}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="answerRow">
                        <input
                          aria-label="Resposta à pergunta"
                          placeholder="Escreva sua resposta…"
                          required
                          value={answers[snap.pending.id] || ""}
                          onChange={(e) => setAnswers({ ...answers, [snap.pending!.id]: e.target.value })}
                        />
                        <button className="solid" disabled={busy[thread.id]}>
                          Responder
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {snap.status === "error" && (
                <p className="feedError" role="alert">
                  <CircleAlert size={16} aria-hidden />
                  <span>{snap.detail || "Falha na execução."}</span>
                </p>
              )}
            </div>
          </div>

          <div className="composeWrap">
            {(errors[thread.id] || storageError || statusOffline) && (
              <div className="notice" role="alert">
                <CircleAlert size={15} aria-hidden />
                <span>{errors[thread.id] || storageError || "Reconectando ao T3. Último estado recebido em exibição."}</span>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void act("send");
              }}
            >
              <span className="clipIcon" aria-hidden="true">
                <Paperclip size={18} strokeWidth={2} />
              </span>
              <textarea
                rows={1}
                ref={promptBox}
                aria-label={`Mensagem para ${area.persona}`}
                placeholder={`Mensagem para ${area.persona}…`}
                value={drafts[thread.id] || ""}
                onChange={(e) => setDrafts((p) => ({ ...p, [thread.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!run) void act("send");
                  }
                }}
              />
              {run ? (
                <button
                  type="button"
                  className="send stop"
                  aria-label="Interromper execução"
                  disabled={busy[thread.id]}
                  onClick={() => void act("interrupt")}
                >
                  <Square size={14} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="Enviar mensagem"
                  disabled={!drafts[thread.id]?.trim() || busy[thread.id]}
                >
                  <ArrowUp size={19} strokeWidth={2.4} />
                </button>
              )}
            </form>
          </div>
        </main>
      </div>

      <footer className="bottom">
        <span>
          <span className="inkDot" aria-hidden="true" />
          {studio.areas.length} {studio.areas.length === 1 ? "área" : "áreas"} no estúdio
        </span>
        {allPending.length ? (
          <button type="button" className="bottomPending" onClick={() => select(allPending[0]!.id, true)}>
            <i className="dotMark amber tinyDot" aria-hidden />
            <span>
              {allPending.length} {allPending.length === 1 ? "pendência" : "pendências"}
            </span>
            <ArrowRight size={13} aria-hidden />
          </button>
        ) : (
          <span className="bottomClear">
            <Check size={13} aria-hidden /> Sem pendências
          </span>
        )}
      </footer>

      {(form === "area" || form === "rename") && (
        <Modal title={form === "area" ? "Nova área" : "Renomear área"} onClose={() => setForm(null)}>
          <form className="modalForm" onSubmit={submitArea}>
            <label>
              <span>Nome da área</span>
              <input
                autoFocus
                required
                maxLength={50}
                placeholder="Ex.: Infra"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {form === "area" && (
              <label>
                <span>
                  Descrição <small>(opcional)</small>
                </span>
                <textarea
                  rows={3}
                  maxLength={250}
                  placeholder="O que essa agente vai cuidar?"
                  value={descr}
                  onChange={(e) => setDescr(e.target.value)}
                />
              </label>
            )}
            <div className="modalActions">
              <button type="button" className="paperBtn" onClick={() => setForm(null)}>
                Cancelar
              </button>
              <button className="solid" disabled={!name.trim()}>
                {form === "area" ? "Criar área" : "Salvar nome"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}

      {form === "trial" && <Trial onClose={() => setForm(null)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
