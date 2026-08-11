# Project Mirroring

Use this when your project files live on one machine (say, your laptop) but you want agents to run on another (an always-on desktop or a beefier box). T3 Code keeps a mirror of your working copy on the host and syncs it automatically — no manual copying, rsync, or network mounts.

## How it works

- The host keeps a **mirror** of your project folder and runs agents, terminals, and git against it at full local speed.
- Your machine (the **origin**) keeps the real working copy and syncs with the host in the background: your latest changes are pushed to the host right before each agent turn starts, and the agent's results are applied back to your working copy right after each turn finishes.
- Everything moves through your existing T3 Code connection. The host never needs to reach your machine.

## Requirements

- Both machines run a T3 Code server that supports mirroring (the desktop app counts — it runs one for you).
- The project folder already exists on the other machine. It does not have to be a git repository — mirroring is built on git, so a plain folder gets a repository initialized inside it the first time you mirror it.
- Both servers can run `git` (2.38 or newer recommended).

## Setting it up

1. Connect your client to both environments: the host (where agents should run) and the machine holding the files.
2. Create a project **on the host** and choose the option to keep the files on another machine.
3. Pick the environment that holds the files and select the project folder.
4. T3 Code links the two environments and performs the initial seed — a one-time transfer of your repository and working tree. Large repositories take a moment; the project shows _Seeding_ until it completes.

After seeding, the host has a full clone with your branches, remotes, and uncommitted changes reproduced exactly.

## What syncs (and what doesn't)

- **Synced:** tracked files, uncommitted changes, untracked files that aren't gitignored, your branches, and your remotes.
- **Synced:** submodules and other nested repositories — whether registered in `.gitmodules` or not — as long as a local copy exists on the machine holding the files. Each one is mirrored with its own full history, just like the top-level project.
- **Never synced:** gitignored files — including `node_modules`, build output, and, importantly, files like `.env`.

If your agents need a gitignored file (local secrets, certificates), list it in `t3.json` at the repository root:

```json
{
  "mirror": {
    "include": [".env", "config/local.json"]
  }
}
```

Dependencies are not synced. After the first seed, run your project's setup script on the host (Scripts menu) to install them — the host also needs the runtimes your project uses.

## When it syncs

- **Before every turn:** your working copy is pushed to the mirror. If nothing changed, this is a single round-trip.
- **After every turn:** the agent's changes are applied back to your working copy automatically. If you edited the same files while the turn ran, your version wins on those files, the conflict is flagged on the project, and the agent's version stays safely reachable in your repository's git history.
- **Manually:** use _Sync now_ on the project's mirror status chip.

Edits you make through the T3 Code UI or a host terminal between turns are merged with your next push instead of being overwritten.

## When your machine is offline

If the machine holding the files is unreachable when you send a message, the turn fails with a clear error. Sending the same message again within ten minutes runs the agent against the last-synced state of the mirror — useful when your laptop is asleep and you know the mirror is current. Results queue up and apply back to your working copy when your machine reconnects.

## Git pushes and pull requests

Push and PR actions run on the host against the mirror, so the host needs your git remote credentials for them to work. If you'd rather keep credentials off the host, skip push actions there — the agent's commits reach your machine through the normal sync-back, and you can push from there yourself.

## Terminals

Terminals opened on a mirrored project run on the host, inside the mirror. Files a terminal creates reach your machine with the next sync-back.

## Limits

- One origin per project; the file-owning side must be a T3 Code server (a browser or phone can't hold the files).
- Symbolic-link fidelity is not guaranteed when mirroring between Windows and other systems.
- A submodule path with no local copy on the machine holding the files is skipped with a warning on the project rather than failing the sync — everything else still syncs normally.
- Submodule mirroring requires the origin's T3 Code server to support it; older origins fall back to today's behavior (submodule paths stay empty) without failing the rest of the sync.
