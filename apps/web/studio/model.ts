export type Activity = "idle" | "working" | "responding" | "pending" | "error";
export type Pending = { id: string; kind: "approval" | "question"; text: string; options: string[] };
export type StepItem = { id: string; label: string; done: boolean };
export type Snapshot = {
  id: string;
  messages: { id: string; role: "user" | "assistant"; text: string }[];
  status: Activity;
  detail: string;
  steps?: StepItem[];
  pending: Pending | null;
  revision: number;
};
export type Thread = { id: string; title: string; sent: boolean };
export type Area = {
  id: string;
  role: string;
  original: string;
  description: string;
  persona: string;
  color: string;
  threads: Thread[];
  preset?: string;
};

export const labels: Record<Activity, string> = {
  idle: "Disponível",
  working: "Trabalhando",
  responding: "Respondendo",
  pending: "Precisa de você",
  error: "Falha na execução",
};

const identities: Record<string, [string, string]> = {
  po: ["Sol", "#ffa044"],
  web: ["Mika", "#ff92b5"],
  api: ["Yuna", "#65baff"],
  qa: ["Íris", "#68cfb5"],
  infra: ["Nori", "#ffc53c"],
  docs: ["Rei", "#fc8a75"],
};

export const newThread = (): Thread => ({ id: crypto.randomUUID(), title: "Nova conversa", sent: false });

export function newArea(role: string, description: string, initial = false): Area {
  const slug = role.toLocaleLowerCase("pt-BR");
  const hash = Array.from(role + description).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
  const [persona, color] = identities[slug] ?? [
    ["Lume", "Zuri", "Lua", "Mavi", "Aya", "Vega", "Cora"][hash % 7]!,
    ["#bba1ec", "#8cd1d7", "#f7bd7c", "#e39bca"][hash % 4]!,
  ];
  return {
    id: crypto.randomUUID(),
    role,
    original: role,
    description,
    persona,
    color,
    threads: [newThread()],
    ...(initial ? { preset: slug } : {}),
  };
}

export type Studio = { areas: Area[]; selected: string; mode: "compact" | "expressive" };
export const storeKey = "nanquim.studio.v1";

export function readStudio(): Studio {
  try {
    const data = JSON.parse(localStorage.getItem(storeKey) ?? "null");
    if (
      data?.areas?.length &&
      data.areas.every((a: Area) => a.id && a.threads?.length) &&
      data.areas.some((a: Area) => a.threads.some((t) => t.id === data.selected))
    ) {
      return data;
    }
  } catch {}
  const areas = [
    newArea("PO", "Produto e prioridades", true),
    newArea("Web", "Interfaces e experiência", true),
    newArea("API", "Serviços e integrações", true),
    newArea("QA", "Testes e qualidade", true),
  ];
  return { areas, selected: areas[1]!.threads[0]!.id, mode: "compact" };
}

export function blank(id: string): Snapshot {
  return { id, messages: [], status: "idle", detail: "", steps: [], pending: null, revision: 0 };
}

export type Art = { normal: string; expressive: string };
let connection: Promise<IDBDatabase> | undefined;

function gallery() {
  return (connection ??= new Promise((ok, fail) => {
    const req = indexedDB.open("nanquim.galeria", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("retratos");
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  }));
}

export async function savedArt(id: string): Promise<Art | undefined> {
  const db = await gallery();
  return new Promise((ok, fail) => {
    const req = db.transaction("retratos").objectStore("retratos").get(id);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

export async function saveArt(id: string, art: Art) {
  const db = await gallery();
  return new Promise<void>((ok, fail) => {
    const tx = db.transaction("retratos", "readwrite");
    tx.objectStore("retratos").put(art, id);
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

export const initialLetters = (name: string) =>
  name.trim().split(/\s+/).map((t) => t[0]).join("").slice(0, 2).toUpperCase() || "?";
