import { drawCharacter, drawInsignia, ink, paper } from "./inkPortrait";

export interface PortraitBrief {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface PortraitPair {
  readonly normal: string;
  readonly expressive: string;
}

const atlas = new Map([
  ["po", "po"], ["web", "web"], ["api", "api"], ["qa", "qa"],
  ["infra", "infra"], ["infraestrutura", "infra"],
  ["docs", "docs"], ["documentacao", "docs"],
]);

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function hash(value: string) {
  let result = 2166136261;
  for (const letter of value) {
    result = Math.imul(result ^ letter.charCodeAt(0), 16777619);
  }
  return result >>> 0;
}

const motifs = [
  /infra|nuvem|cloud|deploy|rede|servidor|operaç|operac/,
  /docs|document|texto|editora|redac|escrita/,
  /web|design|interface|produto|visual|arte/,
  /api|dados|banco|consulta|integra/,
  /teste|qa|revis|qualid|pesquisa|investig/,
];

function canvas() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("O navegador não conseguiu desenhar a personagem.");
  ctx.scale(canvas.width / 256, canvas.height / 256);
  ctx.lineCap = ctx.lineJoin = "round";
  return { canvas, ctx };
}

async function loadArt(filename: string) {
  const image = new Image();
  image.src = new URL(`art/${filename}.webp`, document.baseURI).href;
  await image.decode();
  return image;
}

function print(ctx: CanvasRenderingContext2D) {
  const url = ctx.canvas.toDataURL("image/webp", 0.88);
  if (url === "data:,") throw new Error("O retrato não pôde ser salvo.");
  return url;
}

export async function generatePortrait(brief: PortraitBrief): Promise<PortraitPair> {
  const name = normalize(brief.name);
  if (!name) throw new Error("A área precisa de um nome.");
  const env = globalThis as {
    __NANQUIM_PORTRAIT_DELAY_MS?: number;
    __NANQUIM_FAIL_ONCE?: Set<string>;
  };
  if (env.__NANQUIM_FAIL_ONCE?.delete(name)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    throw new Error("Falha ao ilustrar a personagem.");
  }
  const description = normalize(brief.description ?? "");
  const seed = hash(`${name}\0${description}\0${brief.id}`);
  const descriptionMotif = motifs.findIndex((pattern) => pattern.test(description));
  const areaMotif = motifs.findIndex((pattern) => pattern.test(name));
  const motif = descriptionMotif >= 0 ? descriptionMotif : areaMotif >= 0 ? areaMotif : seed % 6;
  const file = atlas.get(name);
  const delayMs = typeof env.__NANQUIM_PORTRAIT_DELAY_MS === "number" ? env.__NANQUIM_PORTRAIT_DELAY_MS : 2400;
  // Hold uncached generation briefly so provisional initials and concurrent work remain observable.
  const [images] = await Promise.all([
    file ? Promise.all([loadArt(file), loadArt(file + "-active")]) : Promise.resolve(undefined),
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  ]);
  function render(expressive: boolean) {
    const { ctx } = canvas();
    if (images && file) {
      ctx.drawImage(images[expressive ? 1 : 0], 0, 0, 256, 256);
      if (description || file === "docs" || file === "infra") {
        ctx.save();
        ctx.translate(228, 226);
        ctx.rotate(((seed % 15) - 7) * Math.PI / 180);
        ctx.fillStyle = paper;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 15, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        drawInsignia(ctx, motif);
        ctx.restore();
      }
    } else {
      drawCharacter(ctx, seed, motif, expressive);
    }
    return print(ctx);
  }
  return { normal: render(false), expressive: render(true) };
}
