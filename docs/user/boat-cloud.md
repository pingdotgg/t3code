# Boat cloud

Boat cloud runs threads on [Boat](https://boat.dev) VMs instead of your machine. Each VM runs its own
T3 Code server, so a cloud thread works like any other thread: it streams, keeps its history, and
you can follow it from any client.

## Set it up

1. Create a Boat API key with these scopes: `sandbox.create`, `sandbox.read`, `sandbox.update`,
   `sandbox.stop`, `sandbox.resume`, `sandbox.delete`, `exec`, `file.read`, `file.write`, `host`,
   `ssh`, `snapshot.read`, `snapshot.write`, `account.read`, `account.admin`, `environment.read`,
   `environment.write`. `account.admin` lets T3 Code see which agent sign-ins you added, never
   their values.
2. Open **Settings → Cloud**, paste the key, and choose **Connect**. The key is saved on every
   connected machine. The mobile app also keeps it on the phone, so the phone can start cloud
   threads with no machine connected.
3. Choose **Set up**. T3 Code creates a VM, installs the T3 Code server so it starts on boot,
   copies your machine's skills, and saves a Boat snapshot named `t3-code`. Every cloud VM starts
   from it. Choose **Rebuild snapshot** after you change your skills or update T3 Code. A phone
   with no machine connected installs the latest T3 Code release and copies no skills.
4. Under **Environment**, choose the Boat environment new VMs start on. It starts on Boat's default.
   Its switches choose what VMs get: GitHub access, Boat credentials, secrets, and agent sign-ins.
   Connect GitHub and add agent sign-ins in the Boat dashboard. Without GitHub access, private
   repositories fail to clone. A VM keeps the environment it started on, even after it stops, so a
   new choice only applies to new VMs.

## Start a cloud thread

In a new thread, open the machine picker and choose **Boat cloud**, or use the command palette:
**New Boat cloud thread** on web and desktop, **Run on Boat cloud** on mobile. Nothing starts until
you send the first message. Then the app lists each step as it runs: finding a VM, starting T3 Code,
cloning or updating the repository, connecting, opening the project, and starting the thread, which
lives on the VM from then on. T3 Code reuses a running VM that is under half its CPU
and memory, preferring one that already has the repository, or starts a new VM from the snapshot. A
VM from the snapshot is usually ready in under 10 seconds.

A cloud thread always works in a new worktree, so several threads can share a VM. You choose only
the base branch. The thread keeps your model and access settings, and its attachments go with it.

The project needs a pushed Git remote: the VM clones it, so local-only branches and commits are not
there. When an agent finishes, it commits and pushes its branch. It opens a pull request only when
you ask. Providers on a VM use the agent sign-ins from its Boat environment, so a cloud thread
only offers the providers those sign-ins cover.

## When VMs stop

A VM turns off once none of its threads has run a turn for 10 minutes. A connected machine
holding the key stops it a minute early and first saves a copy of the VM's threads, provider sessions, and checkouts. A thread on a stopped
VM shows it as sleeping. Your next message turns the same VM back on and the thread continues. If
Boat deleted the VM, a new one starts from the saved copy. A phone keeps no copy, so it can only
turn back on a VM that Boat still has. **Settings → Cloud** lists each VM, its
repositories, and whether it is running. Cloud VMs are not listed under **Settings →
Environments**.
