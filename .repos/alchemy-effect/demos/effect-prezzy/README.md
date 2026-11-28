# Alchemy walkthrough presentation

A presentation that builds and deploys a real app with Alchemy. Every scene
is recorded from a real run, then drawn as a macOS desktop (VS Code, a
terminal and Chrome) with Remotion and played back in tcut's presenter.

```sh
pnpm capture     # run every scene for real, then `alchemy destroy` (--keep to leave it up)
pnpm studio      # preview and tweak compositions in Remotion Studio
pnpm render      # render every deck item to out/presentation
pnpm present     # open the presenter (Space plays/advances, N notes, F fullscreen)
```

Needs `git submodule update --init --checkout -- submodules/tcut` and
`bunx bun@1.4.2 install` inside it. Deploys use the `ALCHEMY_PROFILE` profile
(default `testing`).

| Path | What it is |
| --- | --- |
| `deck.ts` | The presentation, in order: React slides and recorded scenes |
| `scenes/<id>.ts` | One scene script: edit files, run commands, open pages |
| `template/` | The app as it exists before the first scene |
| `capture/` | Runs the scenes against `work/my-app` and writes `out/capture/` |
| `shared/types.ts` | The capture format and the desktop layout constants |
| `remotion/` | Slides and the desktop scene (editor, terminal, browser, Cmd-Tab) |
| `render.ts` | Renders the deck and writes the presenter's `presentation.json` |

A scene script drives real work, and each call becomes a beat in the video:

```ts
await s.editor.edit("alchemy.run.ts", (code) => code.replace(before, after)); // written to disk, typed on screen
const url = await s.terminal(async (t) => { /* tcut session in the project folder */ });
await s.browser.open(url); // real page capture
s.pause(2);
```
