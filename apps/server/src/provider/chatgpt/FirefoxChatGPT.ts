import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// Firefox BiDi and its SQLite cookie store are native browser interfaces.
// Timers belong to native socket/process callbacks and are explicitly cancelled.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeTimers from "node:timers";

const COMPOSER = '[contenteditable="true"][role="textbox"], #prompt-textarea';
const Cookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  host: Schema.String,
  path: Schema.String,
  expiry: Schema.Number,
  isSecure: Schema.Number,
  isHttpOnly: Schema.Number,
  sameSite: Schema.Number,
});
const decodeCookies = Schema.decodeUnknownSync(Schema.Array(Cookie));
const BidiReply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  type: Schema.String,
  result: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
});
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(BidiReply));
const Evaluation = Schema.Struct({
  type: Schema.String,
  result: Schema.optional(
    Schema.Struct({ type: Schema.String, value: Schema.optional(Schema.String) }),
  ),
});

const decodeEvaluation = Schema.decodeUnknownSync(Evaluation);
const decodeTree = Schema.decodeUnknownSync(
  Schema.Struct({ contexts: Schema.Array(Schema.Struct({ context: Schema.String })) }),
);
const decodeOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ text: Schema.optional(Schema.String), error: Schema.optional(Schema.Boolean) }),
  ),
);
const decodePoint = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number }))),
);

export async function resolveFirefoxProfile(
  configured: string,
  platform: NodeJS.Platform = HostProcessPlatform.defaultValue(),
): Promise<string> {
  if (configured) return NodeFSP.realpath(configured.replace(/^~(?=[/\\]|$)/, NodeOS.homedir()));
  const roots =
    platform === "darwin"
      ? [NodePath.join(NodeOS.homedir(), "Library/Application Support/Firefox")]
      : platform === "win32"
        ? [NodePath.join(process.env.APPDATA ?? NodeOS.homedir(), "Mozilla/Firefox")]
        : [
            NodePath.join(NodeOS.homedir(), "snap/firefox/common/.mozilla/firefox"),
            NodePath.join(NodeOS.homedir(), ".mozilla/firefox"),
          ];
  for (const root of roots) {
    const ini = await NodeFSP.readFile(NodePath.join(root, "profiles.ini"), "utf8").catch(() => "");
    const sections = ini.split(/\r?\n(?=\[)/).map((section) =>
      Object.fromEntries(
        section
          .split(/\r?\n/)
          .filter((line) => line.includes("="))
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      ),
    );
    const profile =
      sections.find((section) => section.Default === "1" && section.Path) ??
      sections.find((section) => section.Path);
    if (profile?.Path)
      return NodeFSP.realpath(
        profile.IsRelative === "0" ? profile.Path : NodePath.join(root, profile.Path),
      );
  }
  throw new Error("Firefox profile not found. Set its folder in ChatGPT Web provider settings.");
}

/** Firefox may hold an exclusive lock. Read a stable, private copy; never modify its live database. */
export async function readChatGPTCookies(profile: string, destination?: string) {
  const source = NodePath.join(profile, "cookies.sqlite");
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-cookies-"));
  try {
    const signature = async () =>
      Promise.all(
        ["", "-wal"].map(async (suffix) => {
          const stat = await NodeFSP.stat(source + suffix).catch(() => null);
          return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
        }),
      );
    const before = await signature();
    for (const suffix of ["", "-wal"]) {
      await NodeFSP.copyFile(source + suffix, NodePath.join(dir, "cookies.sqlite") + suffix).catch(
        (error: unknown) => {
          if (
            suffix === "" ||
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        },
      );
    }
    if (JSON.stringify(before) !== JSON.stringify(await signature())) {
      throw new Error("Firefox cookies changed during import. Try connecting again.");
    }
    const snapshot = NodePath.join(dir, "cookies.sqlite");
    const db = new NodeSqlite.DatabaseSync(snapshot);
    try {
      const cookies = decodeCookies(
        db
          .prepare(`SELECT name,value,host,path,expiry,isSecure,isHttpOnly,sameSite
        FROM moz_cookies WHERE host IN ('chatgpt.com','.chatgpt.com') AND originAttributes=''
        AND expiry > ?`)
          .all(Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000)),
      );
      if (!cookies.some((cookie) => cookie.name.includes("session-token"))) {
        throw new Error(
          "Sign in to ChatGPT in this Firefox profile first. Container/private-window sessions are not imported.",
        );
      }
      if (destination) {
        db.exec(
          "DELETE FROM moz_cookies WHERE host NOT IN ('chatgpt.com','.chatgpt.com') OR originAttributes <> ''; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;",
        );
        await NodeFSP.copyFile(snapshot, destination);
        await NodeFSP.chmod(destination, 0o600);
      }
      return cookies;
    } finally {
      db.close();
    }
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

/** One standard Firefox process, isolated from the user's live profile. No stealth preferences. */
export class FirefoxChatGPT {
  private child: NodeChildProcess.ChildProcess | undefined;
  private socket: WebSocket | undefined;
  private directory: string | undefined;
  private closing: Promise<void> | undefined;
  private context = "";
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private readonly options: {
    profile: string;
    binary: string;
    headless: boolean;
    platform?: NodeJS.Platform;
  };

  constructor(options: {
    profile: string;
    binary: string;
    headless: boolean;
    platform?: NodeJS.Platform;
  }) {
    this.options = options;
  }

  private command(method: string, params: unknown, timeout = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = NodeTimers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Firefox ${method} timed out.`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          NodeTimers.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          NodeTimers.clearTimeout(timer);
          reject(new Error(`${method}: ${error.message}`));
        },
      });
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.pending.get(id)?.reject(new Error("Firefox connection closed."));
        this.pending.delete(id);
      } else this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private async evaluate(expression: string, timeout = 30_000): Promise<string> {
    const result = decodeEvaluation(
      await this.command(
        "script.evaluate",
        {
          target: { context: this.context },
          expression,
          awaitPromise: true,
        },
        timeout,
      ),
    );
    // Do not forward browser exceptions: they can contain credentials or page data.
    if (result.type !== "success")
      throw new Error("ChatGPT page changed or rejected the browser operation.");
    return result.result?.value ?? "";
  }

  private async start() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await this.close();
    const snapRoot = NodePath.join(NodeOS.homedir(), "snap/firefox/common");
    const root = await NodeFSP.access(snapRoot).then(
      () => snapRoot,
      () => NodeOS.tmpdir(),
    );
    this.directory = await NodeFSP.mkdtemp(NodePath.join(root, "t3-chatgpt-browser-"));
    try {
      const profile = await resolveFirefoxProfile(this.options.profile, this.options.platform);
      await readChatGPTCookies(profile, NodePath.join(this.directory, "cookies.sqlite"));
      this.child = NodeChildProcess.spawn(
        this.options.binary,
        [
          ...(this.options.headless ? ["--headless"] : []),
          "--no-remote",
          "--profile",
          this.directory,
          "--remote-debugging-port",
          "0",
          "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const child = this.child;
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = NodeTimers.setTimeout(
          () => reject(new Error("Firefox did not start within 30 seconds.")),
          30_000,
        );
        let tail = "";
        const read = (chunk: Buffer) => {
          tail = (tail + chunk.toString()).slice(-8192);
          const match = tail.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
          if (match) {
            NodeTimers.clearTimeout(timer);
            resolve(`${match[1]}/session`);
          }
        };
        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
        child.once("error", () => {
          NodeTimers.clearTimeout(timer);
          reject(new Error("Could not launch Firefox. Check the executable in provider settings."));
        });
        child.once("exit", () => {
          NodeTimers.clearTimeout(timer);
          reject(new Error("Firefox exited during startup."));
        });
      });
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      socket.addEventListener("message", ({ data }) => {
        let reply: typeof BidiReply.Type;
        try {
          reply = decodeReply(String(data));
        } catch {
          return;
        }
        if (reply.id === undefined) return;
        const pending = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (reply.type === "error")
          pending?.reject(new Error("Firefox rejected the browser operation."));
        else pending?.resolve(reply.result);
      });
      socket.addEventListener("close", () => {
        for (const request of this.pending.values())
          request.reject(new Error("Firefox connection closed."));
        this.pending.clear();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = NodeTimers.setTimeout(
          () => reject(new Error("Firefox connection timed out.")),
          10_000,
        );
        socket.addEventListener(
          "open",
          () => {
            NodeTimers.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            NodeTimers.clearTimeout(timer);
            reject(new Error("Firefox connection failed."));
          },
          { once: true },
        );
      });
      await this.command("session.new", { capabilities: {} });
      const tree = decodeTree(await this.command("browsingContext.getTree", {}));
      this.context = tree.contexts[0]?.context ?? "";
      if (!this.context) throw new Error("Firefox did not create a browser tab.");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const abort = () => {
      void this.close().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.start();
      signal.throwIfAborted();
      await this.command("browsingContext.navigate", {
        context: this.context,
        url: "https://chatgpt.com/?temporary-chat=true",
        wait: "complete",
      });
      const ready = await this.evaluate(
        `new Promise(resolve => {
        const finish = value => { clearTimeout(timer); observer.disconnect(); resolve(value); };
        const check = () => {
          if (document.querySelector('[data-testid="login-button"]')) return finish('login');
          if (document.querySelector(${JSON.stringify(COMPOSER)})) return finish('ready');
        };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => finish('timeout'), 45000);
        observer.observe(document.documentElement, {childList:true,subtree:true}); check();
      })`,
        50_000,
      );
      if (ready !== "ready")
        throw new Error(
          "ChatGPT needs sign-in or a browser check. Open ChatGPT in Firefox, then reconnect the provider. No request retried.",
        );
      await this.evaluate(`(() => {
        const composer = document.querySelector(${JSON.stringify(COMPOSER)});
        composer.focus(); document.execCommand('insertText', false, ${JSON.stringify(prompt)});
        return 'inserted';
      })()`);
      // Let the editor commit its input and layout before locating the send control.
      await this.evaluate(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('painted'))))`,
      );
      const sendPoint = decodePoint(
        await this.evaluate(`new Promise(resolve => {
        const finish = value => { clearTimeout(timer); observer.disconnect(); resolve(value); };
        const check = () => {
          const send = document.querySelector('[data-testid="send-button"], button[aria-label="Send"], button[aria-label="Send prompt"]');
          if (send && !send.disabled) {
            const rect = send.getBoundingClientRect();
            if (rect.width && rect.height) finish(JSON.stringify({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}));
          }
        };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => finish('null'), 10000);
        observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true}); check();
      })`),
      );
      if (!sendPoint)
        throw new Error("ChatGPT send control is unavailable. The message was not retried.");
      await this.command("input.performActions", {
        context: this.context,
        actions: [
          {
            type: "pointer",
            id: "send",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", x: sendPoint.x, y: sendPoint.y, origin: "viewport" },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
      const submitted = await this.evaluate(`new Promise(resolve => {
        const finish = value => { clearTimeout(timer); observer.disconnect(); resolve(value); };
        const check = () => {
          const composer = document.querySelector(${JSON.stringify(COMPOSER)});
          if (composer && !composer.textContent.trim()) finish('submitted');
        };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => finish('timeout'), 10000);
        observer.observe(document.documentElement, {childList:true,subtree:true,characterData:true}); check();
      })`);
      if (submitted !== "submitted")
        throw new Error(
          "ChatGPT did not accept the message. Check its composer in Firefox. No request retried.",
        );
      const output = await this.evaluate(
        `new Promise(resolve => {
        const finish = value => { clearTimeout(timer); observer.disconnect(); resolve(value); };
        const check = () => {
          const controls = [...document.querySelectorAll('.turn-action-controls')].at(-1);
          const complete = controls?.querySelector('button[aria-label="Regenerate response"]');
          const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
          const message = complete ? controls.parentElement : messages.at(-1);
          const legacyComplete = document.querySelector('[data-testid="copy-turn-action-button"]');
          const stop = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]');
          if ((complete || legacyComplete) && !stop && message?.innerText?.trim()) {
            const content = [...message.querySelectorAll('[class*="MarkdownRoot-"], .markdown, .prose')].at(-1);
            const code = content?.querySelector('pre code, pre');
            const text = code?.innerText ?? content?.innerText;
            if (text?.trim()) finish(JSON.stringify({text}));
          }
          const alerts = [...document.querySelectorAll('[role="alert"]')].map(e => e.innerText).join(' ');
          if (/limit|too many|try again|unusual|something went wrong/i.test(alerts)) finish(JSON.stringify({error:true}));
        };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => finish(JSON.stringify({error:true})), 180000);
        observer.observe(document.documentElement, {childList:true,subtree:true,characterData:true,attributes:true}); check();
      })`,
        190_000,
      );
      const result = decodeOutput(output);
      if (result.error || !result.text)
        throw new Error(
          "ChatGPT did not complete the response. It may have reached a limit or need a browser check. Cooldown started; no automatic retry.",
        );
      return result.text;
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) await this.close();
    }
  }

  close(): Promise<void> {
    this.closing ??= this.dispose().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  private async dispose() {
    this.socket?.close();
    this.socket = undefined;
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = NodeTimers.setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          NodeTimers.clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    const directory = this.directory;
    this.directory = undefined;
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
