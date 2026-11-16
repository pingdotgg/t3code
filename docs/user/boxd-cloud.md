# boxd cloud

boxd cloud runs threads on [boxd](https://boxd.sh) machines instead of your machine. It works like
[Boat cloud](boat-cloud.md): each machine runs its own T3 Code server, and a cloud thread streams,
keeps its history, and can be followed from any client. You can turn on Boat, boxd, both, or
neither.

## Set it up

1. Create an API key at [app.boxd.sh/keys](https://app.boxd.sh/keys).
2. Open **Settings → Cloud**, paste the key under **boxd**, and choose **Connect**. The key stays
   on the machine you are connected to. The mobile app gives it to a connected machine and never
   keeps it on the phone.
3. Setup then starts by itself. T3 Code creates a machine, installs the T3 Code server, clones your
   most used repositories, and saves a boxd snapshot named `t3-code-<version>`. Choose **Rebuild
   snapshot** after you update T3 Code.

## Start a cloud thread

In a new thread, open the machine picker and choose **boxd cloud**, or use the command palette:
**New boxd cloud thread** on web and desktop, **Run on boxd cloud** on mobile. On web and desktop,
picking it starts a machine right away, so it is usually ready before you send. On mobile it starts
when you send.

T3 Code keeps one spare machine asleep with T3 Code already running. A start takes it and your
client connects in about a second. A new spare is prepared in the background for the next start.
Machines go to sleep after 15 minutes without traffic and wake when a client connects.

## Things to know

- boxd machines come with Claude Code and Codex installed, but T3 Code does not sign them in yet.
  A machine's agents need signing in before a thread on it can run.
- Private repositories need GitHub access on the machine. Public ones clone as is.
