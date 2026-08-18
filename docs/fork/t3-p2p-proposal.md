# A peer fabric for T3 Code

> **Fork-local proposal.** Specific to the `s243a/t3code` fork, not proposed for
> upstream. Deliberately written at the level of *what it should do*; the
> implementation section offers options rather than a decision.

## The problem, stated honestly

Earlier in this project I argued against adding P2P to T3, and I stand by the
reasoning as far as it went: T3 already expresses remoteness at the connection
layer, Tailscale already solves NAT traversal, and mesh *routing* would buy
nothing because every hub is directly reachable once an overlay exists.

But that argument was about **transport**, and transport is not the gap.

The gap is **provisioning**. Before a client can connect to a machine, something
has to be *running* on that machine. Today that means: open a shell there,
install T3 or the broker, start it, note the address, configure it. T3 has one
productized escape from this — desktop SSH launch, which starts a remote T3
server and pairs it — but it is desktop-only, SSH-only, and T3-server-only.
Nothing general exists for "make this machine start doing something for me."

That is the real friction, and it is worth naming precisely, because a fabric
that solves it looks nothing like a fabric that solves routing.

## What it should do

**Machines should offer themselves, not be configured.** Owning a machine and
wanting to use it should be enough. The act of installing the agent on a box is
the act of making it available; there should be no second step where a human
transcribes an address into a settings pane. Addresses are an implementation
detail that leaks today.

**Names should outlive addresses.** A laptop that moves between home, office,
and tether is the same laptop. Anything a user has named, approved, or scripted
against must survive the address changing underneath it. If a user ever has to
re-pair because they changed networks, the design has failed.

**A peer offers capabilities, not access.** This is the load-bearing principle
and the one most easily lost. "This machine will run a broker for you" is a
categorically different grant from "this machine will run whatever you send."
The fabric should carry *specific offers* — run a broker, run a T3 server, run
this named agent — each independently grantable and revocable. A peer that can
be asked to run arbitrary commands is a remote shell wearing a fabric costume,
and every safeguard built above it is theatre.

This mirrors a decision already made well elsewhere in this project:
`BROKER_TERM_CMDS=agy` is narrow *because naming the command is the security
boundary*. The fabric should inherit that instinct rather than re-open the
question.

**Trust should be explicit, per-machine, and revocable.** Adding a peer is a
deliberate act with a visible moment of consent. Removing one is equally
deliberate and takes effect everywhere, promptly — a revoked machine should
lose its grant even if it is currently offline and comes back later. Trust
should never be transitive: peer A vouching for B must not silently admit B.

**Lifecycle should be owned, not improvised.** If the fabric starts a broker, it
knows that broker is running, can report its health, can restart it, and can
stop it. The failure mode to design out is the orphan: a process the user
started through the fabric and can now only kill by hand. Anything the fabric
can start, it must be able to see and stop.

**Failure should be legible.** "Peer unreachable" is not an answer. The user
needs to know whether the machine is asleep, the credential expired, the
capability was revoked, the process crashed on startup, or the network path is
down — because those have four different remedies. Most distributed-system
frustration is diagnostic poverty, not genuine complexity.

**It should degrade to what already works.** The fabric is an accelerant for
existing paths, never a new dependency. Every machine reachable through it must
remain reachable without it — by direct pairing, by SSH, by hand. If the fabric
is down and the user is locked out of their own machine, it has made things
worse. This also gives an honest migration story: the fabric is a convenience
layer over primitives that keep working.

## What it should not do

The negative space matters as much as the goal.

- **Not a router.** Peers do not relay for one another. If A cannot reach B,
  that is a network problem to fix at the network layer, not to paper over with
  application-level forwarding. Relaying re-introduces the second runtime
  boundary T3's architecture deliberately avoids, and it makes trust transitive
  through the back door.
- **Not a scheduler.** No placement decisions, no "run this wherever is free."
  The user names the machine. Choosing for them requires a model of their
  machines the fabric will not have and should not pretend to.
- **Not a new identity system.** It should ride whatever the user already
  authenticates with. A fresh credential store is a fresh thing to leak, rotate,
  and lose.
- **Not a broadcast medium.** An earlier idea in this project was addressing
  peers by having every machine attempt decryption of every message. That buys
  recipient anonymity — a property with no value among machines one person owns
  — at the cost of O(N) traffic and crypto per message. For a PTY stream it
  would be pathological. Unicast to a named peer is correct.

## Implementation options

Three shapes, cheapest first. All satisfy the principles; they differ in what
they assume.

**1. Tailscale-native.** Treat the tailnet as the fabric. Discovery is the
device list, identity is the node key, reachability is solved. A small agent on
each machine advertises its capabilities and starts them on request. T3 already
has the seam: `remote.md` §Endpoint providers exists so contributors can supply
endpoints without touching the core model, and
`apps/desktop/src/backend/tailscaleEndpointProvider.ts` is the worked example.

*Assumes:* everything is on one tailnet. *Gets:* almost all the value for a
fraction of the work, and it composes with what ships today. **This is where I
would start**, and it may be where it ends.

**2. Broker-mediated.** Extend SciREPL-MCP's reverse-worker idea: machines dial
out to a coordination point and receive capability requests. Solves the case
where a machine can reach the network but nothing can reach it, without any
overlay.

*Assumes:* a coordination point exists and is trusted. *Costs:* that point is
now infrastructure to run, and it sees metadata about every machine.

**3. Direct peer links.** Explicit pairwise links, each established once and
remembered — closest to "P2P" in the usual sense, and the most work: NAT
traversal, key management, liveness, all owned rather than borrowed.

*Worth it only if* the fabric must work for machines that will never share an
overlay, which is a requirement worth confirming before paying for it.

## How to know it worked

The honest test is not a feature list. It is: **a user with a new machine can
make it run a broker for them without ever typing an address, and can revoke
that a week later from a phone, and can explain what went wrong when it
fails.** If all three hold, the fabric earned its complexity.

A useful smaller milestone: replace the current manual broker startup for a
single already-tailnetted machine. If it does not clearly beat `ssh box 'start
the broker'` for that case, the larger version will not beat it either.

## Relationship to the rest of this fork

- [mcp-acp-bridge](https://github.com/s243a/mcp-acp-bridge) is what gets *run*.
  The fabric is how it gets started somewhere else.
- [agy-broker-pty.md](./agy-broker-pty.md) — the PTY transport, shelved because
  T3 already covers cross-host connection. The fabric does not revive it; they
  address different layers.
- Command allow/block lists belong to the thing being started, not the fabric.
  A capability grant says *what may run*; the broker's own list says *what that
  thing may then do*. Keeping those separate keeps both comprehensible.
