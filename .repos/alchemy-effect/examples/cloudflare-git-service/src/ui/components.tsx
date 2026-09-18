/** Shared UI atoms — GitHub-flavored. */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cLang from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "./client.ts";
import { useTheme } from "./theme.tsx";

// ── markdown rendering ──────────────────────────────────────────────────────

for (const [name, language] of Object.entries({
  bash,
  c: cLang,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(["ts", "tsx", "mts", "cts"], {
  languageName: "typescript",
});
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], {
  languageName: "javascript",
});
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["md"], { languageName: "markdown" });

const escapeHtml = (code: string): string =>
  code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const highlightExtension = markedHighlight({
  langPrefix: "hljs language-",
  highlight(code, lang) {
    const language = lang.split(/\s/)[0] ?? "";
    // Always return HTML we produced: either highlighted tokens or the
    // escaped source — never the raw code string.
    return hljs.getLanguage(language) !== undefined
      ? hljs.highlight(code, { language }).value
      : escapeHtml(code);
  },
});

const renderer = new Marked(highlightExtension);

/**
 * Resolves a README-relative asset path against the repo's raw-file
 * endpoint, so `![](./docs/logo.png)` renders. Handles `./`, `../`, and
 * root-relative (`/images/x.png`) forms; absolute URLs pass through.
 */
export const makeAssetResolver =
  (options: {
    /** Base URL of the file endpoint for the browsed repo. */
    readonly fileUrl: (path: string) => string;
    /** Directory (path segments) the markdown file lives in. */
    readonly dir: ReadonlyArray<string>;
  }) =>
  (href: string): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
    const root = href.startsWith("/");
    const segments: Array<string> = root ? [] : [...options.dir];
    for (const part of href.replace(/^\//, "").split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segments.pop();
      else segments.push(part);
    }
    return options.fileUrl(segments.join("/"));
  };

// ── icons (Octicon paths, MIT) ──────────────────────────────────────────────

const Icon = ({ d, className }: { d: string; className?: string }) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

export const RepoIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"
  />
);

export const FolderIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    className={`fill-folder ${className ?? ""}`}
    aria-hidden="true"
  >
    <path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z" />
  </svg>
);

export const FileIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"
  />
);

export const BranchIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
  />
);

export const TagIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
  />
);

export const CommitIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"
  />
);

export const ForkIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"
  />
);

export const PullRequestIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
  />
);

export const GitMergeIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.5-4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"
  />
);

export const PullClosedIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
  />
);

export const GearIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"
  />
);

export const CopyIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
  />
);

export const SunIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"
  />
);

export const MoonIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"
  />
);

export const DeviceIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M14.25 1c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.727c.099 1.041.52 1.872 1.292 2.757A.752.752 0 0 1 11.25 16h-6.5a.75.75 0 0 1-.565-1.243c.772-.885 1.192-1.716 1.292-2.757H1.75A1.75 1.75 0 0 1 0 10.25v-7.5C0 1.784.784 1 1.75 1ZM1.75 2.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25ZM9.018 12H6.982a5.72 5.72 0 0 1-.765 2.5h3.566a5.72 5.72 0 0 1-.765-2.5Z"
  />
);

// ── atoms ───────────────────────────────────────────────────────────────────

/** Cycles light → dark → system. Icon shows the current preference. */
export const ThemeToggle = () => {
  const { preference, setPreference } = useTheme();
  const next =
    preference === "light"
      ? "dark"
      : preference === "dark"
        ? "system"
        : "light";
  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      title={`Theme: ${preference} (click for ${next})`}
      aria-label={`Theme: ${preference}. Switch to ${next}.`}
      className="cursor-pointer rounded-md border border-border-muted p-1.5 text-fg-muted hover:text-fg-default"
    >
      {preference === "light" ? (
        <SunIcon />
      ) : preference === "dark" ? (
        <MoonIcon />
      ) : (
        <DeviceIcon />
      )}
    </button>
  );
};

export const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="size-6 animate-spin rounded-full border-2 border-border-muted border-t-accent" />
  </div>
);

export const ErrorBox = ({ error }: { error: unknown }) => {
  const message =
    error instanceof ApiError
      ? `${error.tag}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <div className="my-4 rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
      {message}
    </div>
  );
};

export const Badge = ({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "attention" | "danger";
}) => (
  <span
    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
      tone === "attention"
        ? "border-attention/40 text-attention"
        : tone === "danger"
          ? "border-danger/40 text-danger"
          : "border-border-muted text-fg-muted"
    }`}
  >
    {children}
  </span>
);

export const Button = ({
  children,
  onClick,
  kind = "default",
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "default" | "primary" | "danger";
  disabled?: boolean;
  type?: "submit" | "button";
}) => (
  <button
    type={type ?? "button"}
    onClick={onClick}
    disabled={disabled}
    className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      kind === "primary"
        ? "border-transparent bg-success-emphasis text-fg-on-emphasis hover:bg-success-emphasis-hover"
        : kind === "danger"
          ? "border-border-muted text-danger hover:border-transparent hover:bg-danger-emphasis hover:text-fg-on-emphasis"
          : "border-border-muted bg-canvas-subtle hover:bg-border-muted/30"
    }`}
  >
    {children}
  </button>
);

export const Input = ({
  value,
  onChange,
  placeholder,
  type,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) => (
  <input
    type={type ?? "text"}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    placeholder={placeholder}
    className={`w-full rounded-md border border-border-muted bg-canvas px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 ${mono ? "font-mono" : ""}`}
  />
);

/** One-click copy affordance for remotes, oids, and tokens. */
export const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
      }}
      className="cursor-pointer rounded p-1 text-fg-muted hover:text-accent"
      title="Copy"
    >
      {copied ? <span className="text-xs text-success">✓</span> : <CopyIcon />}
    </button>
  );
};

/**
 * README / markdown rendering: code blocks are syntax-highlighted
 * (highlight.js over marked) and relative image paths resolve through
 * `resolveAsset` to the repo's raw-file endpoint. Repo content is the
 * same trust model as an IDE preview, so `marked` output is injected
 * without a sanitizer pass.
 */
export const Markdown = ({
  source,
  resolveAsset,
}: {
  source: string;
  /** Maps a relative image/link target to a fetchable URL. */
  resolveAsset?: ((href: string) => string) | undefined;
}) => {
  const html = useMemo(() => {
    const walked =
      resolveAsset === undefined
        ? renderer
        : new Marked(highlightExtension, {
            walkTokens(token) {
              if (token.type === "image" && typeof token.href === "string") {
                token.href = resolveAsset(token.href);
              }
              // READMEs routinely use raw `<img>` HTML (centered heroes,
              // width attributes) — rewrite those src values too.
              if (
                (token.type === "html" || token.type === "text") &&
                typeof token.text === "string" &&
                token.text.includes("<img")
              ) {
                token.text = token.text.replace(
                  /(<img\b[^>]*?\bsrc=)("([^"]*)"|'([^']*)')/gi,
                  (
                    _match,
                    prefix: string,
                    _quoted,
                    doubleQuoted,
                    singleQuoted,
                  ) => {
                    const href = (doubleQuoted ?? singleQuoted) as string;
                    return `${prefix}"${resolveAsset(href)}"`;
                  },
                );
              }
            },
          });
    return walked.parse(source, { async: false });
  }, [source, resolveAsset]);
  return (
    <div
      className="markdown-body"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
