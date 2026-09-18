/**
 * Scripted terminal demo of the Alchemy CLI, recorded with tcut
 * (https://github.com/AmanVarshney01/tcut).
 *
 *   tcut demo.video.ts                 # record + render out/alchemy-cli.mp4
 *   tcut test demo.video.ts            # replay fast, assertions only (no video)
 *   tcut render out/alchemy-cli.cast … # re-render the last recording, no shell
 *
 * The run never touches your real `~/.alchemy`: it starts from an EMPTY
 * throwaway `ALCHEMY_HOME` and follows a brand-new user in order, one title
 * card (`t.slide`, tcut ≥ 1.3) and mp4 chapter per step: connect Cloudflare
 * through the `alchemy profile` TUI (OAuth,
 * granted in tcut's browser pane), `alchemy dev`, `alchemy deploy`, an
 * out-of-band edit caught and fixed by `alchemy drift`, and `alchemy destroy`.
 * Stack state stays in this directory's `.alchemy/`; everything the demo
 * deploys is destroyed at the end.
 *
 * Inputs (environment):
 *   CLOUDFLARE_ACCOUNT_NAME  (env or ./.env, optional)
 *       The account to arrow down to in the picker when the login sees
 *       several accounts; defaults to the account id.
 *   CLOUDFLARE_LOGIN_EMAIL / CLOUDFLARE_LOGIN_PASSWORD  (env or ./.env)
 *       Dashboard login for the Cloudflare account used on camera. If unset,
 *       the script waits (up to 4 min) for you to sign in by hand in the
 *       browser window; either way it clicks through the consent page.
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 *       API token for the OFF-camera pre-flight that destroys anything a
 *       previous take left behind. Falls back to the token stored in the
 *       real `testing` profile. Written to a gitignored `demo.env` that only
 *       `--env-file demo.env` reads, so the value never lands in the `.cast`.
 *
 * The CLI opens the OAuth URL with `open`; a shim on the recorded shell's
 * PATH captures that URL for tcut's browser instead of your real browser.
 *
 * `alchemy dev` never returns on its own — the script drives it like a user
 * would (edit a file, watch the reload) and then sends Ctrl+C.
 */
import { defineVideo } from "tcut";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const realHome = path.join(os.homedir(), ".alchemy");
const demoHome = path.join(os.tmpdir(), "alchemy-cli-demo-home");
const shimDir = path.join(os.tmpdir(), "alchemy-cli-demo-bin");
const oauthUrlFile = path.join(shimDir, "oauth-url");
const apiFile = path.join(here, "src", "Api.ts");
const envFile = path.join(here, "demo.env");
/**
 * `KEY=value` lines from this directory's gitignored `.env`, if present.
 *
 * Bun auto-loads the same file into `process.env`, but with shell semantics:
 * `$WORD` gets expanded and `#` starts a comment, which silently mangles a
 * password containing either. Values are read verbatim here and take
 * precedence over `process.env` for exactly the keys the file defines.
 */
const dotenv: Record<string, string> = Object.fromEntries(
  (existsSync(path.join(here, ".env"))
    ? readFileSync(path.join(here, ".env"), "utf8").split("\n")
    : []
  )
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, key, value]) => [key, value!.replace(/^(["'])(.*)\1$/, "$2")]),
);
const env = (key: string) => dotenv[key] ?? process.env[key];
const login = {
  email: env("CLOUDFLARE_LOGIN_EMAIL"),
  password: env("CLOUDFLARE_LOGIN_PASSWORD"),
};
/** Matches the local provider's ready line; group 1 is the served URL. */
const STARTED = /Started in \d+ms → (http:\/\/localhost:\d+\/)/;

/**
 * Resolves once `url` (our worker's favicon route) answers with the worker's
 * own empty 404 three times in a row. Cloudflare's "not provisioned yet" page
 * is also a 404, but carries an `error code: 1042` body.
 */
const waitForWorker = async (url: string, attempts = 90) => {
  let streak = 0;
  for (let i = 0; i < attempts; i++) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then(async (r) => r.status === 404 && (await r.text()) === "")
      .catch(() => false);
    streak = ok ? streak + 1 : 0;
    if (streak === 3) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not come up after ${attempts}s`);
};

/**
 * Write `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` to `demo.env`
 * (gitignored, removed after the take). The on-camera setup command reads
 * them through `--env-file demo.env`, so the value is never typed and never
 * lands in the `.cast`; no other command loads the file, so deploy/dev
 * authenticate through the profile rather than the environment.
 *
 * Returns the credentials for the script's own out-of-band API call (the
 * drift step).
 */
const writeCredentialEnvFile = () => {
  let token = env("CLOUDFLARE_API_TOKEN");
  let accountId = env("CLOUDFLARE_ACCOUNT_ID");
  if (!token || !accountId) {
    const stored = JSON.parse(
      readFileSync(
        path.join(realHome, "profiles", "testing", "cloudflare.json"),
        "utf8",
      ),
    ).values as Record<string, string>;
    if (stored.credentialType !== "apiToken") {
      throw new Error(
        "set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the 'testing' profile has no stored API token to fall back on)",
      );
    }
    token = stored.apiToken!;
    accountId = stored.accountId!;
  }
  // The account id is also how the script picks the account if the OAuth
  // login can see more than one; it is public enough (the dashboard prints it).
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  writeFileSync(
    envFile,
    `CLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`,
    { mode: 0o600 },
  );
  return { token, accountId };
};

const connectCloudflare = (profile: string) =>
  `alchemy profile edit --profile ${profile} --add Cloudflare --method stored --set apiToken=env:CLOUDFLARE_API_TOKEN --set accountId=env:CLOUDFLARE_ACCOUNT_ID --env-file demo.env`;

/**
 * The deployed `Visits` KV namespace, read from the stack's local state
 * (`alchemy deploy` targets the `live_<user>` stage).
 */
const deployedVisitsNamespace = () => {
  const stackDir = path.join(here, ".alchemy", "state", "Demo");
  const stage = readdirSync(stackDir).find((name) => name.startsWith("live_"));
  if (stage === undefined) {
    throw new Error(`no live stage under ${stackDir}`);
  }
  const state = JSON.parse(
    readFileSync(path.join(stackDir, stage, "Visits.json"), "utf8"),
  ) as { attr: { title: string; namespaceId: string; accountId: string } };
  return state.attr;
};

/** Direct Cloudflare API access to one KV namespace, bypassing alchemy. */
const kvNamespaceApi = (
  credentials: { token: string; accountId: string },
  namespaceId: string,
) => {
  const call = async (init: RequestInit) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/storage/kv/namespaces/${namespaceId}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
      },
    );
    const body = (await response.json()) as { result: { title: string } };
    if (!response.ok) {
      throw new Error(
        `KV namespace ${namespaceId}: ${init.method} failed with ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body.result;
  };
  return {
    title: async () => (await call({ method: "GET" })).title,
    /**
     * Rename the namespace behind alchemy's back — what a teammate clicking
     * around the dashboard would do. This is the drift the demo detects and
     * repairs.
     */
    rename: (title: string) =>
      call({ method: "PUT", body: JSON.stringify({ title }) }),
  };
};

/** Fresh, empty `ALCHEMY_HOME`. */
const seedDemoHome = () => {
  rmSync(demoHome, { recursive: true, force: true });
  mkdirSync(demoHome, { recursive: true });
};

/**
 * `open` shim: instead of launching the system browser, record the URL so the
 * script can hand it to tcut's browser pane.
 */
const seedOpenShim = () => {
  rmSync(shimDir, { recursive: true, force: true });
  mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, "open");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s' "$1" > ${oauthUrlFile}\n`);
  chmodSync(shim, 0o755);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The authorization URL the CLI asked `open` to launch. */
const waitForOAuthUrl = async (attempts = 240) => {
  for (let i = 0; i < attempts; i++) {
    if (existsSync(oauthUrlFile)) return readFileSync(oauthUrlFile, "utf8");
    await sleep(250);
  }
  throw new Error("the CLI never opened the OAuth URL");
};

/**
 * Cloudflare's login page is a React form; set the controlled inputs through
 * the native value setter (so React sees the change) and submit.
 */
const signInScript = (email: string, password: string) => `(() => {
  const set = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  return set("#email", ${JSON.stringify(email)}) && set("#password", ${JSON.stringify(password)});
})()`;

/** True once both controlled inputs actually hold the values we set. */
const signInFilledScript = (email: string, password: string) =>
  `document.querySelector("#email")?.value === ${JSON.stringify(email)} &&
   document.querySelector("#password")?.value === ${JSON.stringify(password)}`;

/**
 * True once the login page's Turnstile widget has produced its token. Without
 * it Cloudflare answers a perfectly good password with "Incorrect email or
 * password", so the submit has to wait for it. (`login_challenge` is a
 * different, always-populated field — don't match on `*challenge*`.)
 */
const turnstileReadyScript = `[...document.querySelectorAll(
  'input[name="cf_challenge_response"], input[name="cf-turnstile-response"]'
)].some((el) => el.value.length > 0)`;

/**
 * The account row to pick on the consent screen's "Select account(s)" step:
 * the configured account name, or whichever row comes first.
 */
const accountButtonPattern = (() => {
  const name = env("CLOUDFLARE_ACCOUNT_NAME");
  return name
    ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
    : /^(?!Review permissions$|Cancel$).+/;
})();

/** Click the first button whose text matches (consent pages vary in markup). */
const clickButtonScript = (pattern: RegExp) => `(() => {
  const el = [...document.querySelectorAll("button, input[type=submit], a[role=button]")]
    .find((b) => ${pattern}.test((b.innerText || b.value || "").trim()));
  if (!el) return false;
  el.click();
  return true;
})()`;

/** Logical frame size (rendered at 2x); the 110x32 grid is centred inside. */
const VIDEO = { width: 1368, height: 816 };

export default defineVideo(
  {
    output: ["out/alchemy-cli.mp4"],
    shell: "zsh",
    cols: 110,
    rows: 32,
    width: VIDEO.width,
    height: VIDEO.height,
    theme: "catppuccin-mocha",
    typingSpeed: "15ms",
    typingJitter: 0.3,
    waitTimeout: "180s",
    endPause: "2s",
    requires: ["curl"],
    // A real browser window, composited over the terminal only while
    // focused — used for the OAuth grant and to show the local dev server.
    // Sized to the video so it takes the whole frame when it is in front.
    browser: { position: "overlay", ...VIDEO, offset: { x: 0, y: 0 } },
  },
  async (t) => {
    seedDemoHome();
    seedOpenShim();
    const credentials = writeCredentialEnvFile();
    const originalApi = readFileSync(apiFile, "utf8");

    /**
     * A full-screen transition card between steps (`t.slide`, tcut ≥ 1.3),
     * drawn at render time in real typography and faded in and out. It also
     * records an mp4 chapter of the same name (`--chapters`,
     * `--split-chapters`), and the screen is cleared behind the card so the
     * next step starts fresh.
     */
    let step = 0;
    const slide = async (heading: string, subtitle: string) => {
      step += 1;
      await t.caption(null);
      await t.slide(heading, {
        eyebrow: String(step),
        subtitle,
        duration: "2.2s",
        fade: "400ms",
        during: async () => {
          // `run` waits for a fresh prompt, which never comes when the screen
          // is already just a prompt (clear redraws nothing new).
          const lines = t
            .screen()
            .split("\n")
            .filter((l) => l.trim());
          if (lines.length > 1) await t.run("clear");
        },
      });
    };

    /**
     * A subtitle over the bottom of the terminal (`t.caption`, tcut ≥ 1.4) for
     * the moments where the screen alone doesn't say what is happening. Drawn
     * at render time, never typed into the PTY; stays up until the next
     * caption, `caption(null)`, or the next slide.
     */
    const caption = (text: string, duration?: string) =>
      t.caption(text, { style: "classic", fontSize: 26, duration });

    try {
      // Off-camera: point the CLI at the empty home, put the `open` shim and
      // the workspace `alchemy` bin on PATH, and make sure nothing is left
      // from a previous take.
      await t.hide(async () => {
        await t.run(
          `export ALCHEMY_HOME=${JSON.stringify(demoHome)} PATH="${shimDir}:$PWD/node_modules/.bin:$PATH"`,
        );
        // The CLI falls back to plain output when it detects a coding agent
        // (CURSOR_AGENT, CLAUDECODE, …) or CI in the environment, and drops
        // colors under NO_COLOR; the demo is about the TUI, so force both on
        // regardless of who launched tcut.
        await t.run(
          "unset CI CURSOR_AGENT CLAUDECODE CLAUDE_CODE NO_COLOR FORCE_COLOR; export ALCHEMY_TUI=1",
        );
        // tcut's pty has no TERM_PROGRAM, so terminal-capability detection
        // assumes OSC 8 hyperlinks are unsupported and the CLI falls back to
        // printing every URL in full after its label (the OAuth URL is ~1KB).
        // Real terminals (Ghostty, iTerm2, kitty, …) render the link inline.
        await t.run("export FORCE_HYPERLINK=1");
        // A previous take may have left a live stack behind: tear it down with
        // a temporary profile before the home is wiped for the on-camera setup.
        await t.run(`${connectCloudflare("default")} --no-input`);
        await t.run("alchemy destroy --yes --no-input >/dev/null 2>&1 || true");
        // Local state (including the dev stage's emulated resources) and the
        // demo home start from scratch so every take plays out the same way.
        const home = JSON.stringify(demoHome);
        await t.run(`rm -rf .alchemy ${home} && mkdir -p ${home}`);
        await t.run("clear");
      });

      // ── 1. Connect to Cloudflare ─────────────────────────────────────────
      await slide("Connect Cloudflare", "alchemy profile · sign in with OAuth");
      await t.type("alchemy profile");
      await t.enter();
      await t.wait(/e edit/, { scope: "screen" });
      await caption(
        "A fresh machine: one empty profile, no providers connected yet",
      );
      await t.sleep("2.5s");

      // Nothing is connected yet — add Cloudflare from the edit screen.
      await caption("e edits the profile — space marks a provider to add");
      await t.type("e");
      await t.wait(/esc back/, { scope: "screen" });
      await t.sleep("2s");
      await t.down(2);
      await t.sleep("600ms");
      await t.type(" ");
      await t.wait(/Cloudflare\s+add/, { scope: "screen" });
      await t.sleep("1.2s");
      await t.enter();

      // OAuth (the recommended method), basic scopes.
      await t.wait(/Cloudflare authentication method/, { scope: "screen" });
      await caption("OAuth is the recommended method — no API token to paste");
      await t.sleep("2s");
      await t.enter();
      await t.wait(/Cloudflare OAuth scopes/, { scope: "screen" });
      await caption("Pick the scopes the token should have");
      await t.sleep("1.5s");
      await t.down();
      await t.sleep("600ms");
      await t.enter();

      // The CLI hands the grant URL to `open` — our shim catches it and the
      // grant happens in the browser pane, exactly as it would in a real tab.
      await t.wait(/waiting for browser authorization/, { scope: "screen" });
      await caption("The CLI opens Cloudflare's consent page in the browser");
      const oauthUrl = await waitForOAuthUrl().catch((error) => {
        throw new Error(`${error.message}\n--- screen ---\n${t.screen()}`);
      });
      await t.sleep("2s");
      await caption(
        "Sign in and authorize — the grant is handed back to the CLI",
      );
      await t.browser.goto(oauthUrl);
      await t.focus("browser");
      const consentPage = /Select account\(s\)|Authorize/i;
      await t.browser.waitFor(
        new RegExp(`Sign in to Cloudflare|${consentPage.source}`, "i"),
        { timeout: "60s" },
      );
      const pageText = async () =>
        String(
          await t.browser.evaluate("document.body.innerText").catch(() => ""),
        );
      if (/Sign in to Cloudflare/i.test(await pageText())) {
        if (login.email && login.password) {
          // The form is React-controlled and re-renders while it hydrates and
          // while Turnstile runs, so a fill can be dropped: verify the inputs
          // hold our values and the challenge token exists before submitting,
          // and retry if Cloudflare rejects a half-filled submission.
          for (let attempt = 1; attempt <= 3; attempt++) {
            await t.sleep("1.5s");
            for (let i = 0; i < 10; i++) {
              await t.browser.evaluate(
                signInScript(login.email, login.password),
              );
              await t.sleep("400ms");
              if (
                (await t.browser.evaluate(
                  signInFilledScript(login.email, login.password),
                )) === true
              )
                break;
            }
            let turnstile = false;
            for (let i = 0; i < 60 && !turnstile; i++) {
              turnstile =
                (await t.browser.evaluate(turnstileReadyScript)) === true;
              if (!turnstile) await t.sleep("500ms");
            }
            if (!turnstile)
              console.error(
                "turnstile token never appeared; submitting anyway",
              );
            await t.sleep("500ms");
            await t.browser.click('[data-testid="login-submit-button"]');
            let rejected = false;
            for (let i = 0; i < 40; i++) {
              await t.sleep("500ms");
              const text = await pageText();
              if (/Incorrect email or password/i.test(text)) {
                rejected = true;
                break;
              }
              if (text.trim() !== "" && !/Sign in to Cloudflare/i.test(text))
                break;
            }
            if (!rejected) break;
            console.error(
              `cloudflare rejected the sign-in (attempt ${attempt}); retrying`,
              `\n  url: ${t.browser.url}`,
              `\n  hidden inputs: ${await t.browser.evaluate(
                `JSON.stringify([...document.querySelectorAll("input[type=hidden]")].map((i) => [i.name, i.value.length]))`,
              )}`,
              `\n  page: ${(await pageText()).replace(/\s+/g, " ").slice(0, 400)}`,
            );
          }
        }
        // Either the credentials just submitted, or a human signs in now.
        await t.browser.waitFor(consentPage, { timeout: "240s" });
      }
      // Cloudflare's consent has two steps when the login can see several
      // accounts: pick the account the grant covers, review the permissions,
      // then authorize. With a single account it opens on the review step.
      if (/Select account\(s\)/i.test(await pageText())) {
        await t.sleep("2s");
        await t.browser.evaluate(clickButtonScript(accountButtonPattern));
        await t.sleep("1.2s");
        await t.browser.evaluate(clickButtonScript(/^Review permissions$/i));
        await t.browser.waitFor(/^Authorize$/im, { timeout: "60s" });
      }
      await t.sleep("2.5s");
      await t.browser.evaluate(clickButtonScript(/^Authorize$/i));
      // Cloudflare redirects to alchemy.run/auth/callback, which relays the
      // code to the CLI's localhost listener and lands on the success page.
      // The relay pings localhost with a cross-scheme fetch first; when the
      // embedded browser refuses that, the page offers a plain link to the
      // local callback instead — take it.
      await t.browser.waitFor(
        /Authentication Complete|Authentication Error|Couldn't connect to your local|Cloudflare did not authorize/i,
        { timeout: "60s" },
      );
      if (/Couldn't connect to your local/i.test(await pageText())) {
        await t.browser.click("#relay-local");
        await t.browser.waitFor(
          /Authentication Complete|Authentication Error/i,
          {
            timeout: "60s",
          },
        );
      }
      await t.sleep("2s");
      await t.focus("terminal");

      // Back in the terminal the callback has landed and the account is bound.
      await t.wait(/Cloudflare added|Select a Cloudflare account/, {
        scope: "screen",
      });
      if (/Select a Cloudflare account/.test(t.screen())) {
        await caption(
          "The login can see several accounts — pick the one this profile is for",
        );
        await t.sleep("1.5s");
        // Arrow down to the configured account (the focused row starts with
        // ❯) instead of typing into the filter; the first row is the default.
        const wanted =
          env("CLOUDFLARE_ACCOUNT_NAME") ?? process.env.CLOUDFLARE_ACCOUNT_ID;
        const focused = () =>
          t
            .screen()
            .split("\n")
            .find((line) => /^\s*❯/.test(line)) ?? "";
        for (let i = 0; i < 8 && wanted && !focused().includes(wanted); i++) {
          await t.down();
          await t.sleep("400ms");
        }
        await t.sleep("600ms");
        await t.enter();
        await t.wait(/Cloudflare added/, { scope: "screen" });
      }
      // Hold on the dashboard: one profile, one connected provider.
      await caption(
        "Connected — auth method, token expiry and account id, stored under ~/.alchemy/profiles",
      );
      await t.sleep("3.5s");
      await t.type("q");
      await t.wait();
      await t.sleep("1s");

      // ── 2. Launch alchemy dev ────────────────────────────────────────────
      await slide(
        "Launch alchemy dev",
        "local emulation · plan view · live reload",
      );
      await t.type("alchemy dev");
      await t.enter();
      await t.wait(STARTED, { scope: "screen" });
      await caption(
        "The Worker, KV and R2 all run locally — the widget shows the stack's outputs",
      );
      await t.sleep("2s");

      // The widget opens on the stack's output; ←/→ flips it to the plan
      // that was just applied. Show the plan — three local resources, all
      // created — then come back to the output.
      const showDevPlan = async (pattern: RegExp, text: string) => {
        await caption("→ flips the widget to the plan that was just applied");
        await t.sleep("1s");
        await t.right();
        await t.wait(/show output/, { scope: "screen" });
        await t.expect(pattern, { scope: "screen" });
        await caption(text);
        await t.sleep("4s");
        await caption("← back to the outputs");
        await t.sleep("800ms");
        await t.left();
        await t.wait(/show plan/, { scope: "screen" });
        await t.sleep("1.5s");
      };
      await showDevPlan(
        /Cloudflare\.KV\.Namespace\).*created/,
        "Three resources created, all emulated locally",
      );

      // Hit the local worker in a browser — at the URL the CLI actually
      // printed, never a guess (another dev server may own the default port).
      const devUrl = t.screen().match(STARTED)?.[1];
      if (devUrl === undefined) {
        throw new Error("local dev URL not found in the terminal output");
      }
      await caption("Open the local URL");
      await t.sleep("800ms");
      await t.browser.goto(devUrl);
      await t.focus("browser");
      await t.sleep("3s");
      await t.focus("terminal");
      await t.sleep("1s");

      // Change the greeting while dev is running — the stack reloads and the
      // worker restarts.
      await caption(
        "Editing src/Api.ts while dev runs — the stack reloads and the Worker restarts",
      );
      await t.sleep("1.2s");
      writeFileSync(
        apiFile,
        originalApi.replace(
          'const GREETING = "Hello from Alchemy";',
          'const GREETING = "Hello from alchemy dev";',
        ),
      );
      await t.wait(/restarting instance/, { scope: "screen" });
      await t.wait(/Started in \d+ms[^]*Started in \d+ms/, {
        scope: "screen",
      });
      if (!t.screen().split("Started in").pop()!.includes(devUrl)) {
        throw new Error("worker restarted on a different URL");
      }
      await t.sleep("1.5s");
      // The reload's plan: only the Worker changed, KV and R2 untouched.
      await showDevPlan(
        /Cloudflare\.Worker\)/,
        "Only the Worker was updated — KV and R2 untouched",
      );

      await caption("Reload the page: the new greeting");
      await t.sleep("800ms");
      await t.browser.reload();
      await t.focus("browser");
      await t.sleep("3s");
      await t.focus("terminal");
      await t.sleep("1.5s");

      // alchemy dev parks forever — Ctrl+C shuts it down.
      await caption("Ctrl+C stops dev and tears the local resources down");
      await t.sleep("800ms");
      await t.ctrl("c");
      await t.wait();
      // Put the source back so the deploy ships the original greeting.
      writeFileSync(apiFile, originalApi);
      await t.sleep("1s");

      // ── 3. Deploy to the cloud ───────────────────────────────────────────
      await slide(
        "Deploy to the cloud",
        "alchemy deploy · review the plan · confirm",
      );
      await t.type("alchemy deploy");
      await t.enter();
      await t.wait(/Deploy\?/, { scope: "screen" });
      await caption(
        "The same stack, now against the real Cloudflare account — review the plan, Enter to confirm",
      );
      await t.sleep("3.5s");
      await t.enter();
      await caption(
        "Creating the Worker, the KV namespace and the R2 bucket for real",
      );
      await t.wait();
      await t.expect(/Stack deployed/, { scope: "scrollback" });
      await caption(
        "Deployed — the outputs are the live workers.dev URL and the bucket name",
      );
      await t.sleep("2.5s");

      const url = t
        .scrollback()
        .match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
      if (url === undefined) {
        throw new Error("deployed URL not found in the terminal output");
      }
      // A fresh workers.dev subdomain takes a few seconds to start serving
      // (Cloudflare error 1042 until then). Poll from the script — not the
      // recorded shell — on a route that leaves the visit counter alone, so
      // the visible curls read 1 and 2.
      await waitForWorker(`${url}/favicon.ico`);
      await caption("Hit the live Worker — the visit counter is backed by KV");
      await t.run(`curl -s ${url}`);
      await t.expect(/"visits":1/);
      await t.sleep("1s");
      await t.run(`curl -s ${url}`);
      await t.expect(/"visits":2/);
      await t.sleep("2s");

      // ── 4. Detect and repair drift ───────────────────────────────────────
      // Off camera, "someone" renames the KV namespace in the dashboard.
      const visits = deployedVisitsNamespace();
      const visitsApi = kvNamespaceApi(credentials, visits.namespaceId);
      await visitsApi.rename("renamed-in-the-dashboard");
      await slide(
        "Detect and repair drift",
        "alchemy drift · a namespace renamed in the dashboard",
      );
      await caption(
        "Meanwhile, someone renamed the KV namespace in the Cloudflare dashboard…",
      );
      await t.sleep("2.5s");
      await t.type("alchemy drift");
      await t.enter();
      await t.wait(/Drift detected/, { scope: "screen" });
      await t.expect(/renamed-in-the-dashboard/, { scope: "screen" });
      await caption(
        "drift re-reads the cloud and diffs it against the stack: the title changed",
      );
      await t.sleep("4s");
      // Cancel is preselected; ← moves to Repair.
      await caption(
        "Repair puts the resource back the way the code declares it",
      );
      await t.left();
      await t.sleep("1s");
      await t.enter();
      await caption("Applying the repair");
      await t.wait();
      await t.expect(/Stack deployed/, { scope: "screen" });
      await caption("Repaired — one update, nothing else touched");
      await t.sleep("2.5s");
      if ((await visitsApi.title()) !== visits.title) {
        throw new Error("drift repair did not restore the namespace title");
      }

      // ── 5. Tear down ─────────────────────────────────────────────────────
      await slide("Tear it down", "alchemy destroy");
      await t.type("alchemy destroy");
      await t.enter();
      await t.wait(/Destroy\?/, { scope: "screen" });
      await caption(
        "destroy shows everything it is about to delete before asking",
      );
      await t.sleep("2.5s");
      await t.type("y");
      await caption("Deleting the Worker, the KV namespace and the R2 bucket");
      await t.wait();
      await t.expect(/Stack destroyed/, { scope: "scrollback" });
      await caption("All gone — the account is back to where it started");
      await t.sleep("2s");
    } finally {
      writeFileSync(apiFile, originalApi);
      rmSync(envFile, { force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  },
);
