// @effect-diagnostics nodeBuiltinImport:off globalTimers:off extendsNativeError:off - A small LSP client over the iwes subprocess's stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Talks to IWE's language server (`iwes`) for the editor actions IWE implements itself: link
 * completion and renames that rewrite every reference. One server per workspace, stopped when idle.
 */

interface Position {
  readonly line: number;
  readonly character: number;
}
interface Range {
  readonly start: Position;
  readonly end: Position;
}
interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}
type DocumentChange =
  | { readonly textDocument: { readonly uri: string }; readonly edits: ReadonlyArray<TextEdit> }
  | { readonly kind: "create"; readonly uri: string }
  | { readonly kind: "delete"; readonly uri: string }
  | { readonly kind: "rename"; readonly oldUri: string; readonly newUri: string };
export interface WorkspaceEdit {
  readonly documentChanges?: ReadonlyArray<DocumentChange>;
  readonly changes?: Readonly<Record<string, ReadonlyArray<TextEdit>>>;
}

const IDLE_MS = 5 * 60_000;

class IweLanguageServerError extends Error {}

/** Applies LSP text edits to a string; positions are UTF-16 like JavaScript strings. */
export function applyTextEdits(text: string, edits: ReadonlyArray<TextEdit>): string {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1)
    if (text[index] === "\n") lineStarts.push(index + 1);
  const offset = (position: Position) => {
    if (position.line >= lineStarts.length) return text.length;
    const start = lineStarts[position.line]!;
    const end =
      position.line + 1 < lineStarts.length ? lineStarts[position.line + 1]! - 1 : text.length;
    return Math.min(start + position.character, end);
  };
  const sorted = [...edits].sort(
    (left, right) => offset(right.range.start) - offset(left.range.start),
  );
  let result = text;
  for (const edit of sorted) {
    result =
      result.slice(0, offset(edit.range.start)) +
      edit.newText +
      result.slice(offset(edit.range.end));
  }
  return result;
}

const pathOf = (uri: string) => NodeURL.fileURLToPath(uri);

/** Writes a workspace edit to disk inside `root` and returns the files it touched. */
async function applyWorkspaceEdit(root: string, edit: WorkspaceEdit): Promise<string[]> {
  const touched = new Set<string>();
  const inside = (path: string) => {
    const resolved = NodePath.resolve(path);
    if (!resolved.startsWith(NodePath.resolve(root) + NodePath.sep)) {
      throw new IweLanguageServerError(
        `The language server tried to change ${resolved}, outside the workspace.`,
      );
    }
    return resolved;
  };
  const read = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => "");
  const changes: DocumentChange[] = [
    ...(edit.documentChanges ?? []),
    ...Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ textDocument: { uri }, edits })),
  ];
  for (const change of changes) {
    if ("kind" in change) {
      if (change.kind === "create") {
        const path = inside(pathOf(change.uri));
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        await NodeFSP.writeFile(path, "", { flag: "a" });
        touched.add(path);
      } else if (change.kind === "delete") {
        const path = inside(pathOf(change.uri));
        await NodeFSP.rm(path, { force: true });
        touched.add(path);
      } else {
        const from = inside(pathOf(change.oldUri));
        const to = inside(pathOf(change.newUri));
        await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
        await NodeFSP.rename(from, to);
        touched.add(from).add(to);
      }
      continue;
    }
    const path = inside(pathOf(change.textDocument.uri));
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, applyTextEdits(await read(path), change.edits));
    touched.add(path);
  }
  return [...touched];
}

export class IweLanguageServer {
  readonly #child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #versions = new Map<string, number>();
  readonly #root: string;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #ready: Promise<unknown>;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #onExit: () => void;
  closed = false;

  constructor(executable: string, root: string, onExit: () => void) {
    this.#root = root;
    this.#onExit = onExit;
    this.#child = NodeChildProcess.spawn(executable, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    this.#child.stderr.on("data", () => {});
    this.#child.on("exit", () =>
      this.#shutdown(new IweLanguageServerError("The IWE language server stopped.")),
    );
    this.#child.on("error", (error) =>
      this.#shutdown(new IweLanguageServerError(`Could not start iwes: ${error.message}`)),
    );
    this.#ready = this.#request("initialize", {
      processId: process.pid,
      rootUri: NodeURL.pathToFileURL(root).href,
      capabilities: {
        textDocument: { completion: { completionItem: {} }, rename: { prepareSupport: true } },
        workspace: {
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
      },
    }).then((result) => {
      this.#notify("initialized", {});
      return result;
    });
  }

  #shutdown(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (this.#idle) clearTimeout(this.#idle);
    this.#onExit();
  }

  #read(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const header = this.#buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(this.#buffer.subarray(0, header).toString())?.[1] ?? NaN,
      );
      if (!Number.isFinite(length) || this.#buffer.length < header + 4 + length) return;
      const message = JSON.parse(
        this.#buffer.subarray(header + 4, header + 4 + length).toString("utf8"),
      ) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      this.#buffer = this.#buffer.subarray(header + 4 + length);
      if (message.method !== undefined && message.id !== undefined) {
        // Server-to-client requests (workDoneProgress, configuration): accept with an empty answer.
        this.#send({ jsonrpc: "2.0", id: message.id, result: null });
      } else if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new IweLanguageServerError(message.error.message));
        else pending?.resolve(message.result ?? null);
      }
    }
  }

  #send(message: unknown) {
    const text = JSON.stringify(message);
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new IweLanguageServerError("The IWE language server stopped."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: unknown) {
    if (!this.closed) this.#send({ jsonrpc: "2.0", method, params });
  }

  #touch() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.dispose(), IDLE_MS);
    this.#idle.unref?.();
  }

  /** Syncs the editor's current text so requests see unsaved changes. */
  async #sync(path: string, text: string): Promise<string> {
    await this.#ready;
    this.#touch();
    const uri = NodeURL.pathToFileURL(path).href;
    const version = (this.#versions.get(uri) ?? 0) + 1;
    this.#versions.set(uri, version);
    if (version === 1)
      this.#notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version, text },
      });
    else
      this.#notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    return uri;
  }

  async complete(path: string, text: string, position: Position) {
    const uri = await this.#sync(path, text);
    const result = (await this.#request("textDocument/completion", {
      textDocument: { uri },
      position,
    })) as
      | { items?: Array<{ label: string; textEdit?: TextEdit; insertText?: string }> }
      | Array<{ label: string; textEdit?: TextEdit; insertText?: string }>
      | null;
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return items.map((item) => ({
      label: item.label.replace(/^\p{Extended_Pictographic}\s*/u, ""),
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      replaceFrom: item.textEdit?.range.start.character ?? position.character,
      replaceTo: item.textEdit?.range.end.character ?? position.character,
    }));
  }

  async rename(path: string, text: string, position: Position, newName: string): Promise<string[]> {
    const uri = await this.#sync(path, text);
    const prepared = await this.#request("textDocument/prepareRename", {
      textDocument: { uri },
      position,
    });
    if (prepared === null)
      throw new IweLanguageServerError("Put the cursor on a link to the note you want to rename.");
    const edit = (await this.#request("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    })) as WorkspaceEdit | null;
    if (edit === null) throw new IweLanguageServerError("IWE did not rename anything.");
    return applyWorkspaceEdit(this.#root, edit);
  }

  dispose() {
    if (this.closed) return;
    this.#request("shutdown", null)
      .catch(() => undefined)
      .finally(() => {
        this.#notify("exit", null);
        setTimeout(() => this.#child.kill(), 500).unref?.();
      });
    this.#shutdown(new IweLanguageServerError("The IWE language server was stopped."));
  }
}
