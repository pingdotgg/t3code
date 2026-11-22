# Annotate the fork in desktop dev mode

The design rules in this skill came from a loop: the user clicks an element in
the running app, says what to change, and an agent picks the note up, fixes
it, and marks it done. Running that loop inside the **desktop** dev app (not
only the web dev server) is what made the integrated browser tweakable: the
browser panel's page, its chrome row and the Laravel toolbar only exist in
Electron, because the web build has no `desktopBridge.preview`.

The annotator is the native `@nckrtl/annotator` app. It lives outside this
repo and is independent of T3, Orbit and Commander. T3 Code has no in-page
annotator of its own: the dev window loads no annotation script and shows no
annotation pill.

## 1. Start the annotation server

One local store that both the web and desktop dev apps post to. The native
annotator app posts to it; to run the server by hand:

```bash
npx @nckrtl/annotator serve --port 29703 --store ~/.t3/dev/annotations
```

API on `http://127.0.0.1:29703/annotations`: `GET` lists records, `POST
/claim {id}`, `POST /complete {id, summary}`, `POST /release {id}`. Claim
before you complete: a complete on an unclaimed record does not stick.

## 2. Web dev server (shared components, measuring)

```bash
cd ~/apps/conn && vp run dev     # web on 5733 against ~/.t3/dev
```

The web view is where an agent can measure: the Browser pane tools run
JavaScript against it, so compare computed colors, radii and positions there
for anything the web and desktop share.

## 3. Desktop dev app with its own state

Two backends must never share one SQLite file, so the desktop dev app gets its
own home seeded from the web dev state:

```bash
D=~/.t3/desktop-dev/userdata; mkdir -p "$D"; rm -f "$D"/state.sqlite*
cd ~/apps/conn
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/dev/state.sqlite', { readonly: true }).run(\"VACUUM INTO '$D/state.sqlite'\")"
cp ~/.t3/dev/settings.json ~/.t3/dev/keybindings.json "$D"/ && cp -R ~/.t3/dev/themes "$D"/
vp run dev:desktop --home-dir ~/.t3/desktop-dev
```

Do not copy `environment-id`, `secrets` or `server-runtime.json`: the desktop
dev app keeps its own server identity. The runner picks shifted ports (web
5734, server 13774) and opens **Conn (Dev)**. Annotations from
its window go to the same store; their records show `conn-dev://app/...`
URLs.

## 4. Process the queue

- Watch `GET /annotations` for `status: "todo"` (a poll every few seconds;
  report "unreachable" only after a few failed polls, the store holds
  screenshots and can answer slowly).
- Per record: read `comment`, `element`, `elementPath`, `react` and
  `components` (the React component chain finds the file fast), claim it, fix
  it, lint the touched files, commit, then complete with a summary that names
  the commit.
- Apply each note to every sibling surface, not only the clicked one.
- Experiments go behind one token or one commit; tell the user how to revert.

## 5. Verify

- Web view: measure with JavaScript in the Browser pane.
- Desktop dev window: screen tools cannot target the dev Electron app, and its
  DOM is not reachable without remote debugging. Either restart it with
  `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=<port>` and inspect over CDP, or treat
  the user's next annotation on the changed element as visual confirmation
  (its `appearance.classes` show what rendered).
- Web HMR context errors (`SettingsScopeProvider`, sidebar provider) need a
  full reload.

## Gotchas

- Changes under `apps/desktop/src` rebuild the main process and restart the
  dev window. A browser tab may then fail to restore (`ERR_FAILED (-2)`,
  `Invalid guestInstanceId`), which also hides the Laravel toolbar; reload the
  tab.
- Stop only processes you started, by PID.
