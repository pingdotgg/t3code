import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

interface ChatMarkdownDesktopBridge {
  readonly openPath: (path: string) => Promise<void>;
}

interface OpenChatMarkdownFileInput {
  readonly filePath: string;
  readonly desktopBridge: ChatMarkdownDesktopBridge | undefined;
  readonly openInEditor: () => Promise<void>;
  readonly openInBrowser?: (() => Promise<void>) | undefined;
}

const EDITOR_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bat",
  "c",
  "cc",
  "cfg",
  "cjs",
  "clj",
  "cljs",
  "cljc",
  "cmake",
  "cmd",
  "conf",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "env",
  "erl",
  "ex",
  "exs",
  "fish",
  "fs",
  "fsx",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hcl",
  "hh",
  "hpp",
  "hrl",
  "hs",
  "hxx",
  "ini",
  "inl",
  "ipynb",
  "java",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lhs",
  "lock",
  "lua",
  "m",
  "md",
  "mdx",
  "mjs",
  "mod",
  "ml",
  "mli",
  "mm",
  "mts",
  "php",
  "pl",
  "pm",
  "properties",
  "proto",
  "ps1",
  "py",
  "pyi",
  "pyw",
  "pyx",
  "r",
  "rb",
  "rake",
  "rs",
  "rst",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "styl",
  "sum",
  "svelte",
  "swift",
  "tex",
  "tf",
  "tfstate",
  "tfvars",
  "toml",
  "ts",
  "tsx",
  "vue",
  "work",
  "xml",
  "xsl",
  "xslt",
  "yaml",
  "yml",
  "zig",
  "zsh",
]);

const EDITOR_FILE_NAMES = new Set([
  ".babelrc",
  ".bash_profile",
  ".bashrc",
  ".browserslistrc",
  ".dockerignore",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".gitkeep",
  ".gitmodules",
  ".postcssrc",
  ".prettierignore",
  ".prettierrc",
  ".stylelintignore",
  ".stylelintrc",
  ".zprofile",
  ".zshenv",
  ".zshrc",
  "dockerfile",
  "gemfile",
  "makefile",
  "procfile",
  "rakefile",
]);

const EDITOR_FILE_PREFIXES = [".env.", ".eslintrc.", ".prettierrc.", ".stylelintrc."];

function fileName(path: string): string {
  return (path.replaceAll("\\", "/").split("/").pop() ?? "").toLowerCase();
}

export function shouldOpenChatFileNatively(path: string): boolean {
  const name = fileName(path);
  if (
    EDITOR_FILE_NAMES.has(name) ||
    EDITOR_FILE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    name.startsWith("dockerfile.")
  ) {
    return false;
  }
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) return false;
  return !EDITOR_FILE_EXTENSIONS.has(name.slice(extensionIndex + 1));
}

/** A primary target shares the Electron host filesystem; remote and WSL targets do not. */
export function isHostFilesystemConnectionTarget(target: ConnectionTarget): boolean {
  return target._tag === "PrimaryConnectionTarget";
}

export async function openChatMarkdownFile(input: OpenChatMarkdownFileInput): Promise<void> {
  if (input.desktopBridge !== undefined && shouldOpenChatFileNatively(input.filePath)) {
    await input.desktopBridge.openPath(input.filePath);
    return;
  }

  if (input.openInBrowser !== undefined) {
    await input.openInBrowser();
    return;
  }

  await input.openInEditor();
}
