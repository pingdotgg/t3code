import type { ListingEntry } from "./HostFiles.ts";

export const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const PAGE_STYLE =
  ":root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}h1{font-size:1.15rem;font-weight:600}ul{list-style:none;padding:0;max-width:48rem}li{display:flex;gap:16px;justify-content:space-between;padding:2px 0}span{opacity:.6;white-space:nowrap}";
const FRAME_STYLE =
  "html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);

const page = (title: string, body: string, style = PAGE_STYLE) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`;

const formatSize = (bytes: bigint) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

export const framePage = (input: { readonly title: string; readonly src: string }) =>
  page(
    input.title,
    `<iframe src="${escapeHtml(input.src)}" sandbox="${FRAME_SANDBOX}" title="${escapeHtml(input.title)}"></iframe>`,
    FRAME_STYLE,
  );

export const openPage = (input: { readonly title: string; readonly href: string }) =>
  page(
    input.title,
    `<p>This link may have come from another site.</p><p><a href="${escapeHtml(input.href)}">Open ${escapeHtml(input.title)}</a></p>`,
  );

export const listingPage = (input: {
  readonly title: string;
  readonly entries: ReadonlyArray<ListingEntry>;
  readonly hasParent: boolean;
  readonly omitted: number;
}) => {
  const rows = input.entries.map((entry) => {
    const suffix = entry.isDirectory ? "/" : "";
    const href = `./${encodeURIComponent(entry.name.toWellFormed())}${suffix}`;
    const size = entry.isDirectory ? "" : `<span>${formatSize(entry.size)}</span>`;
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name + suffix)}</a>${size}</li>`;
  });
  const parent = input.hasParent ? `<li><a href="../">../</a></li>` : "";
  const omitted = input.omitted > 0 ? `<p>${input.omitted} more entries are not shown.</p>` : "";
  return page(
    input.title,
    `<h1>${escapeHtml(input.title)}</h1><ul>${parent}${rows.join("")}</ul>${omitted}`,
  );
};

export const signInPage = page(
  "Sign in to open this file",
  `<p>Sign in to T3 Code in this browser to open this file.</p><p><a href="/">Sign in</a>, then reload this page.</p>`,
);
