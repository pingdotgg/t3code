import * as Backfill from "@alchemy.run/domain/Backfill";
import type { Routed } from "@alchemy.run/domain/CatchUp";
import type { Delivery } from "@alchemy.run/domain/Platform";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * A deterministic simulation of the backfill protocol: every role runs its
 * real code over in-process storage, jobs and network, driven by a seeded
 * scheduler that injects failures, crashes and stale code.
 */

/** A seeded PRNG (mulberry32): the same seed explores the same interleaving. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

class Crash extends Error {
  override readonly name = "Crash";
}

export interface Faults {
  /** Chance a call fails before it reaches its object. */
  readonly callBefore: number;
  /** Chance a call runs but its answer is lost. */
  readonly callAfter: number;
  /** Chance an exclusive section crashes before it commits (its writes roll back). */
  readonly crash: number;
}

export const noFaults: Faults = { callBefore: 0, callAfter: 0, crash: 0 };

/** What one object did: Durable Object requests (calls in, and alarms), and rows read and written. */
export interface Stats {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
}

/** One durable object: sorted storage, an exclusive lock, and its scheduled jobs. */
class SimObject {
  readonly data = new Map<string, unknown>();
  overlay: Map<string, unknown> | undefined;
  /** Pending jobs by id: when due, and a version so a replaced job's queue entry is skipped. */
  readonly jobs = new Map<string, { readonly due: number; readonly version: number }>();
  readonly stats: Stats = { requests: 0, rowsRead: 0, rowsWritten: 0 };
  /** Requests by call or job, to see what makes an object hot. */
  readonly methods = new Map<string, number>();
  /**
   * In the wall-time model: the milliseconds this object spends running events,
   * one at a time. An event runs in the first free one at or after it arrives;
   * awaiting its own outgoing calls doesn't keep the object busy.
   */
  busy = new Set<number>();
  /** Run an event that arrives at `at`: when it ends. */
  occupy(at: number, service: number) {
    let slot = Math.ceil(at);
    while (this.busy.has(slot)) slot++;
    this.busy.add(slot);
    return slot + service;
  }
  private sorted: Array<string> = [];
  private dirty = false;
  constructor(
    readonly address: string,
    readonly sim: Sim,
    /** Runs a job of this object by id. */
    readonly run: (id: string) => Effect.Effect<void>,
  ) {}

  private read(key: string) {
    if (this.overlay?.has(key)) return this.overlay.get(key);
    return this.data.get(key);
  }

  private write(key: string, value: unknown) {
    // A delete leaves the key in the sorted list, skipped when read: only new keys re-sort.
    if (value === undefined) this.data.delete(key);
    else {
      if (!this.data.has(key)) this.dirty = true;
      this.data.set(key, value);
    }
  }

  /** The first index in the sorted keys at or after `key`. */
  private seek(key: string) {
    if (this.dirty) {
      this.sorted = [...this.data.keys()].sort();
      this.dirty = false;
    }
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  readonly storage: Backfill.Storage = {
    get: <A>(key: string) =>
      Effect.sync(() => {
        this.stats.rowsRead += 1;
        return this.read(key) as A | undefined;
      }),
    put: (entries) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(entries)) {
          this.stats.rowsWritten += 1;
          if (this.overlay) this.overlay.set(key, value);
          else this.write(key, value);
        }
      }),
    delete: (keys) =>
      Effect.sync(() => {
        for (const key of keys) {
          this.stats.rowsWritten += 1;
          if (this.overlay) this.overlay.set(key, undefined);
          else this.write(key, undefined);
        }
      }),
    list: <A>(options: { prefix: string; startAfter?: string; limit?: number }) =>
      Effect.sync(() => {
        const after = options.startAfter;
        const inRange = (key: string) =>
          key.startsWith(options.prefix) && (after === undefined || key > after);
        // Stored keys from the first in range, merged with the open section's new keys.
        const stored: Array<string> = [];
        const limit = options.limit ?? Number.POSITIVE_INFINITY;
        for (
          let i = this.seek(after !== undefined && after > options.prefix ? after : options.prefix);
          i < this.sorted.length;
          i++
        ) {
          const key = this.sorted[i]!;
          if (!key.startsWith(options.prefix)) break;
          if (!inRange(key) || !this.data.has(key)) continue;
          stored.push(key);
          if (stored.length >= limit + (this.overlay?.size ?? 0)) break;
        }
        const added = [...(this.overlay?.keys() ?? [])].filter(
          (key) => inRange(key) && !this.data.has(key),
        );
        const keys = added.length > 0 ? [...stored, ...added].sort() : stored;
        const out: Array<readonly [string, A]> = [];
        for (const key of keys) {
          const value = this.read(key);
          if (value === undefined) continue;
          out.push([key, value as A]);
          if (out.length >= limit) break;
        }
        this.stats.rowsRead += Math.max(1, out.length);
        return out;
      }),
    exclusive: <A, E>(effect: Effect.Effect<A, E>) => this.section(effect, true),
  };

  private readonly lock = Semaphore.makeUnsafe(1);

  /**
   * One exclusive section: its writes commit together, or, when it crashes
   * before committing, not at all. Client commits pass `crashes: false`.
   */
  section<A, E>(effect: Effect.Effect<A, E>, crashes: boolean): Effect.Effect<A, E> {
    return this.lock.withPermits(1)(
      Effect.suspend(() => {
        this.overlay = new Map();
        return effect.pipe(
          Effect.tap(() =>
            crashes && this.sim.chance(this.sim.faults.crash)
              ? Effect.die(new Crash(`${this.address} crashed before committing`))
              : Effect.void,
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              for (const [key, value] of this.overlay!) this.write(key, value);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.overlay = undefined;
            }),
          ),
        );
      }),
    );
  }

  readonly jobsApi: Backfill.Jobs = {
    schedule: (id, afterMillis) => Effect.sync(() => this.sim.schedule(this, id, afterMillis)),
  };
}

/** A simulated source instance: an event log with routing, like an aggregate. */
interface SourceData {
  readonly ref: Backfill.SourceRef;
  readonly object: SimObject;
  readonly events: Array<{
    readonly seq: number;
    readonly at: number;
    readonly keys: ReadonlyArray<string>;
  }>;
  /** Runs code that knows the target only from this time on. */
  staleUntil: number;
  role: Backfill.Source;
}

/** A simulated consumer key: applies deliveries, deduping by source seq, like a view key. */
interface KeyData {
  readonly key: string;
  readonly object: SimObject;
  readonly applied: Array<{ readonly delivery: Delivery; readonly backfilling: boolean }>;
  readonly checkpoints: Map<string, number>;
  /** Runs code from before the target's generation until this time. */
  staleUntil: number;
  role: Backfill.Consumer;
}

export class Sim {
  readonly random: () => number;
  now = 1_000_000;
  readonly nodes = new Map<string, { object: SimObject; role: Backfill.Node }>();
  readonly sources = new Map<string, SourceData>();
  readonly keys = new Map<string, KeyData>();
  /** Live deliveries waiting to be sent, in order per source (its outbox): retried until they land. */
  readonly outbox = new Map<string, Array<Delivery>>();
  /** Every consumer deployed together. */
  get targets(): ReadonlyArray<string> {
    return [this.target, ...this.others];
  }

  /** A key of `target`: the primary target's keys are plain, the others' are prefixed. */
  keyOf(target: string, key: string) {
    return target === this.target ? key : `${target}|${key}`;
  }

  /** The target a key belongs to. */
  targetOfKey(key: string) {
    const bar = key.indexOf("|");
    return bar < 0 ? this.target : key.slice(0, bar);
  }

  /** Run something just before a run lists `path`: work that lands while it lists the directory. */
  interject: ((path: string) => Effect.Effect<void>) | undefined = undefined;

  /**
   * The consumer is keyed by its source: each key hears only from the instance
   * with its own id (commit each instance's events to a key named after it).
   */
  singleSource = false;

  /** The sources each consumer reads; unset, the root sweeps every subtree. */
  sourcesOf: ((target: string) => ReadonlyArray<string> | undefined) | undefined = undefined;

  /** What the deployed code knows of a consumer. */
  planOf(target: string): Backfill.Plan {
    const sources = this.sourcesOf?.(target);
    return { ...(sources === undefined ? {} : { sources }), singleSource: this.singleSource };
  }

  /** Every plan, as a deploy announces them. */
  plans(targets: ReadonlyArray<string> = this.targets) {
    return Object.fromEntries(targets.map((target) => [target, this.planOf(target)]));
  }

  /** Whether instances of `source` feed `target`. */
  feeds(source: string, target: string) {
    return this.sourcesOf?.(target)?.includes(source) ?? true;
  }

  /** The target exists (the consumer is deployed). */
  deployed = false;
  calls = 0;
  failures = 0;

  constructor(
    seed: number,
    readonly target: string,
    readonly faults: Faults = noFaults,
    readonly limits: Backfill.Limits = {
      ...Backfill.defaultLimits,
      page: 3,
      nodePage: 2,
      apply: 4,
      leafSize: 3,
      // Few, shallow leaves: they fill and split all the time.
      depth: 1,
    },
    /** More consumers deployed at the same time: they share the directory and the sources. */
    readonly others: ReadonlyArray<string> = [],
  ) {
    this.random = rng(seed);
  }

  chance(p: number) {
    return p > 0 && this.random() < p;
  }

  /**
   * A Durable Object keeps the code it started with while calls keep it busy:
   * a call to one still on older code holds it there for another 20 seconds.
   */
  busy<O extends { staleUntil: number }>(object: O): O {
    if (this.now < object.staleUntil)
      object.staleUntil = Math.max(object.staleUntil, this.now + 20_000);
    return object;
  }

  /**
   * Latencies of the wall-time model, in milliseconds: a call's round trip, the
   * time an object spends on one event, and how long an alarm takes to fire.
   */
  latency = { rpc: 10, service: 1, alarm: 50 };
  /**
   * Run work due at the same time in wall-time order, as a real system would,
   * rather than in a random order (which explores interleavings, but makes a
   * busy object's queue hold work that started later).
   */
  timed = false;
  /** In the wall-time model: the time of the work running now, and the latest time anything ended. */
  vt = 0;
  makespan = 0;
  /** In the wall-time model: when the root marked the target's history complete. */
  completedAt: number | undefined = undefined;

  /**
   * Every call crosses the network: it may fail before it runs, or after. In the
   * wall-time model it waits for its object to be free, which is how a hot
   * object's queue shows up.
   */
  private call<A>(
    target: SimObject,
    effect: () => Effect.Effect<A>,
    method = "call",
  ): Effect.Effect<A> {
    return Effect.suspend(() => {
      this.calls += 1;
      target.stats.requests += 1;
      target.methods.set(method, (target.methods.get(method) ?? 0) + 1);
      if (this.chance(this.faults.callBefore)) {
        this.failures += 1;
        return Effect.die(new Crash("call failed in transit"));
      }
      const caller = this.vt;
      this.vt = target.occupy(caller + this.latency.rpc / 2, this.latency.service);
      return effect().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.vt += this.latency.rpc / 2;
            this.makespan = Math.max(this.makespan, this.vt);
          }),
        ),
        Effect.tap(() => {
          if (!this.chance(this.faults.callAfter)) return Effect.void;
          this.failures += 1;
          return Effect.die(new Crash("answer lost in transit"));
        }),
      );
    });
  }

  // ------------------------------------------------------------ scheduler

  /** Due jobs and sends, as a binary heap by time (ties in random order). */
  private readonly queue: Array<{
    readonly due: number;
    readonly tie: number;
    readonly vt: number;
    readonly run: () => Effect.Effect<void>;
  }> = [];
  private versions = 0;

  private push(entry: (typeof this.queue)[number]) {
    const q = this.queue;
    q.push(entry);
    let i = q.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.before(q[parent]!, q[i]!)) break;
      [q[parent], q[i]] = [q[i]!, q[parent]!];
      i = parent;
    }
  }
  private before(a: (typeof this.queue)[number], b: (typeof this.queue)[number]) {
    if (a.due !== b.due) return a.due < b.due;
    if (this.timed && a.vt !== b.vt) return a.vt < b.vt;
    return a.tie <= b.tie;
  }
  private pop() {
    const q = this.queue;
    const top = q[0];
    const last = q.pop()!;
    if (q.length > 0) {
      q[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < q.length && !this.before(q[m]!, q[l]!)) m = l;
        if (r < q.length && !this.before(q[m]!, q[r]!)) m = r;
        if (m === i) break;
        [q[m], q[i]] = [q[i]!, q[m]!];
        i = m;
      }
    }
    return top;
  }

  /** Schedule a job on an object; a job with the same id replaces a pending one. */
  schedule(object: SimObject, id: string, afterMillis: number) {
    // The earliest request wins: a job already due sooner isn't postponed.
    const pending = object.jobs.get(id);
    if (pending !== undefined && pending.due <= this.now + afterMillis) return;
    const version = ++this.versions;
    object.jobs.set(id, { due: this.now + afterMillis, version });
    const vt = this.vt + afterMillis + this.latency.alarm;
    this.push({
      due: this.now + afterMillis,
      tie: this.random(),
      vt,
      run: () =>
        Effect.suspend(() => {
          if (object.jobs.get(id)?.version !== version) return Effect.void;
          object.jobs.delete(id);
          object.stats.requests += 1;
          const job = `job:${id.split(":")[0]}`;
          object.methods.set(job, (object.methods.get(job) ?? 0) + 1);
          this.vt = object.occupy(vt, this.latency.service);
          return object.run(id).pipe(
            // A failed job is retried, like a durable callback.
            Effect.catchCause(() =>
              Effect.sync(() => {
                if (!object.jobs.has(id)) this.schedule(object, id, 1_000);
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                this.makespan = Math.max(this.makespan, this.vt);
              }),
            ),
          );
        }),
    });
  }

  /** Queue the next send of a source's outbox, unless one is queued already. */
  private sending = new Set<string>();
  private queueSend(stream: string) {
    if (this.sending.has(stream)) return;
    this.sending.add(stream);
    const vt = this.vt;
    this.push({
      due: this.now,
      tie: this.random(),
      vt,
      run: () =>
        Effect.suspend(() => {
          this.sending.delete(stream);
          const queue = this.outbox.get(stream) ?? [];
          if (queue.length === 0) return Effect.void;
          this.vt = vt;
          return this.sendOne(queue[0]!).pipe(
            Effect.tap(() => Effect.sync(() => queue.shift())),
            // A failed send stays at the head.
            Effect.catchCause(() => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                if (queue.length > 0) this.queueSend(stream);
              }),
            ),
          );
        }),
    });
  }

  readonly net: Backfill.Network = {
    node: {
      register: (path, ref) =>
        this.call(
          this.node(path).object,
          () => this.node(path).role.register(path, ref),
          "register",
        ),
      child: (path, child) =>
        this.call(this.node(path).object, () => this.node(path).role.child(path, child), "child"),
      list: (path, after) =>
        Effect.andThen(this.interject?.(path) ?? Effect.void, () =>
          this.call(this.node(path).object, () => this.node(path).role.list(path, after), "list"),
        ),
    },
    source: {
      read: (ref, target, key, after, limit) =>
        this.call(
          this.source(ref).object,
          () => this.busy(this.source(ref)).role.read(target, key, after, limit),
          "read",
        ),
      cursor: (ref, target) =>
        this.call(
          this.source(ref).object,
          () => this.busy(this.source(ref)).role.cursor(target),
          "cursor",
        ),
      log: (ref, after, limit) =>
        this.call(
          this.source(ref).object,
          () => this.busy(this.source(ref)).role.log(after, limit),
          "log",
        ),
      handoff: (ref, target, key, through) =>
        this.call(
          this.source(ref).object,
          () => this.busy(this.source(ref)).role.handoff(target, key, through),
          "handoff",
        ),
    },
    consumer: {
      push: (target, key, deliveries) =>
        this.call(
          this.key(key).object,
          () => this.busy(this.key(key)).role.push(target, deliveries),
          "push",
        ),
      ready: (target, key, waitMillis) =>
        this.call(
          this.key(key).object,
          () => this.busy(this.key(key)).role.ready(target, waitMillis),
          "ready",
        ),
      start: (target, key, ref, waitMillis) =>
        this.call(
          this.key(key).object,
          () => this.busy(this.key(key)).role.start(target, ref, waitMillis),
          "start",
        ),
    },
    scanner: {
      scan: (target, ref, waitMillis) =>
        this.call(
          this.scanner(target, ref).object,
          () => this.scanner(target, ref).role.scan(target, ref, waitMillis),
          "scan",
        ),
      ready: (target, ref, waitMillis) =>
        this.call(
          this.scanner(target, ref).object,
          () => this.scanner(target, ref).role.ready(target, waitMillis),
          "scanner-ready",
        ),
      kick: (target, ref) =>
        this.call(
          this.scanner(target, ref).object,
          () => this.scanner(target, ref).role.kick(target, ref),
          "kick",
        ),
    },
    relay: {
      run: (name, run, items) =>
        this.call(this.relay(name), () => this.relays.run(name, run, items), "relay"),
    },
    run: {
      begin: (target, plan) =>
        this.call(
          this.run_(target).object,
          () => this.run_(target).role.begin(target, plan),
          "begin",
        ),
      phase: (target) =>
        this.call(this.run_(target).object, () => this.run_(target).role.phase(target), "phase"),
      progress: (target) =>
        this.call(
          this.run_(target).object,
          () => this.run_(target).role.progress(target),
          "progress",
        ),
    },
  };

  /** The relays of runs: stateless, one object each. */
  readonly relayObjects = new Map<string, SimObject>();
  private readonly relays = Backfill.makeRelay(this.net);
  relay(name: string) {
    let object = this.relayObjects.get(name);
    if (!object) {
      object = new SimObject(`relay:${name}`, this, () => Effect.void);
      this.relayObjects.set(name, object);
    }
    return object;
  }

  /** Each source instance's scanner, per target: an object of the consumer's class. */
  readonly scanners = new Map<string, { object: SimObject; role: Backfill.Scanner }>();
  scanner(target: string, ref: Backfill.SourceRef) {
    const name = `${target}|${ref.source}/${ref.id}`;
    let found = this.scanners.get(name);
    if (!found) {
      const object = new SimObject(`scanner:${name}`, this, (id) =>
        this.scanners.get(name)!.role.run(id),
      );
      found = {
        object,
        role: Backfill.makeScanner(
          object.storage,
          object.jobsApi,
          this.net,
          {
            // The consumer's own code routes the rows it reads from a source's log.
            route: (target, ref, rows) =>
              Effect.sync(() =>
                (rows as SourceData["events"]).map((event) => ({
                  seq: event.seq,
                  deliveries: this.deliveries(this.source(ref), event, true, target),
                })),
              ),
          },
          this.limits,
        ),
      };
      this.scanners.set(name, found);
    }
    return found;
  }

  /**
   * Each consumer's run root. Like the deploy's Workflow, it makes one pass at a
   * time (each one try at everything), again a second later until done.
   */
  readonly runs = new Map<string, { object: SimObject; role: Backfill.Run }>();
  run_(target: string) {
    let found = this.runs.get(target);
    if (!found) {
      const object = new SimObject(`run:${target}`, this, (id) =>
        this.runs.get(target)!.role.run(id),
      );
      found = {
        object,
        role: Backfill.makeRun(object.storage, object.jobsApi, this.net, {
          waitMillis: 0,
          againMillis: 1_000,
        }),
      };
      this.runs.set(target, found);
    }
    return found;
  }

  /** The targets whose run is complete. */
  completed() {
    return this.targets.filter(
      (target) =>
        (
          this.runs.get(target)?.object.data.get(`run:${encodeURIComponent(target)}`) as
            | { phase: string }
            | undefined
        )?.phase === "complete",
    );
  }

  node(path: string) {
    let node = this.nodes.get(path);
    if (!node) {
      const object = new SimObject(`node:${path}`, this, (id) => this.node(path).role.run(id));
      node = {
        object,
        role: Backfill.makeNode(object.storage, object.jobsApi, this.net, this.limits),
      };
      this.nodes.set(path, node);
    }
    return node;
  }

  private streamOf(ref: Backfill.SourceRef) {
    return `${ref.source}/${ref.id}`;
  }

  /** An event's deliveries to one target (or every target). */
  private deliveries(
    source: SourceData,
    event: SourceData["events"][number],
    history = false,
    only?: string,
  ): Array<Delivery> {
    const stream = this.streamOf(source.ref);
    return this.targets
      .filter((target) => only === undefined || target === only)
      .flatMap((target) => {
        const [, rest] = target.split(":") as [string, string];
        const [name, generation] = rest.split("#") as [string, string | undefined];
        return event.keys.map((key) => ({
          target: {
            kind: "view" as const,
            name,
            ...(generation ? { generation: Number(generation) } : {}),
          },
          key: this.keyOf(target, key),
          source: stream,
          seq: event.seq,
          origin: source.ref.source,
          tag: "E",
          event: { _tag: "E", seq: event.seq },
          envelope: { id: source.ref.id, stream, seq: event.seq, at: event.at, commandId: "" },
          ...(history ? { history } : {}),
        }));
      });
  }

  source(ref: Backfill.SourceRef): SourceData {
    const id = this.streamOf(ref);
    let source = this.sources.get(id);
    if (!source) {
      const object = new SimObject(`source:${id}`, this, () => this.sources.get(id)!.role.flush);
      const data: SourceData = {
        ref,
        object,
        events: [],
        staleUntil: 0,
        role: undefined as never,
      };
      const knows = () => this.deployed && this.now >= data.staleUntil;
      data.role = Backfill.makeSource(
        object.storage,
        object.jobsApi,
        this.net,
        {
          ref,
          model: () => (knows() ? this.targets : []),
          singleSource: () => this.singleSource,
          log: (after, limit) =>
            Effect.sync(() => data.events.filter((event) => event.seq > after).slice(0, limit)),
          version: Effect.sync(() => data.events.length),
          // Kept in the object's storage, so a crashed step rolls it back with the rest.
          routed: object.storage.get<Routed>("routed"),
          markLive: (target) =>
            Effect.flatMap(object.storage.get<Routed>("routed"), (routed) =>
              object.storage.put({ routed: { ...routed, [target]: data.events.length } }),
            ),
        },
        this.limits,
      );
      source = data;
      this.sources.set(id, source);
    }
    return source;
  }

  key(key: string): KeyData {
    let data = this.keys.get(key);
    if (!data) {
      const object = new SimObject(`key:${key}`, this, (id) =>
        this.keys.get(key)!.role.merge(id.slice("bf-merge:".length)),
      );
      const keyData: KeyData = {
        key,
        object,
        applied: [],
        checkpoints: new Map(),
        staleUntil: this.keyStaleUntil(key),
        role: undefined as never,
      };
      keyData.role = Backfill.makeConsumer(
        object.storage,
        object.jobsApi,
        this.net,
        {
          key,
          // Older code runs the previous generation of the consumer.
          target: () => {
            const target = this.targetOfKey(key);
            return this.now >= keyData.staleUntil ? target : target.replace(/#\d+$/, "");
          },
          singleSource: () => this.singleSource,
          // The key's own code routes the rows it reads from its source's log.
          history: (ref, rows) =>
            Effect.sync(() =>
              (rows as SourceData["events"]).map((event) => ({
                seq: event.seq,
                deliveries: this.deliveries(this.source(ref), event, true, this.targetOfKey(key)),
              })),
            ),
          apply: (deliveries) => Effect.sync(() => this.apply(keyData, deliveries, true)),
        },
        this.limits,
      );
      data = keyData;
      this.keys.set(key, data);
    }
    return data;
  }

  private apply(key: KeyData, deliveries: ReadonlyArray<Delivery>, backfilling: boolean) {
    for (const delivery of deliveries) {
      if ((key.checkpoints.get(delivery.source) ?? 0) >= delivery.seq) continue;
      key.checkpoints.set(delivery.source, delivery.seq);
      key.applied.push({ delivery, backfilling });
    }
  }

  /**
   * Commit an event on a source, as an aggregate does: decide routing under its
   * lock, then send what goes out live. The first commit lists it in the directory.
   */
  commit(sourceId: string, keys: ReadonlyArray<string>, staleUntil = 0) {
    const [name, id] = sourceId.split("/") as [string, string];
    const source = this.source({ source: name, id });
    if (source.events.length === 0) source.staleUntil = staleUntil;
    this.busy(source);
    const knows = this.deployed && this.now >= source.staleUntil;
    // The first commit lists the instance in the directory before it persists.
    const register =
      source.events.length === 0
        ? this.retry(
            this.net.node.register(Backfill.leafOf(source.ref, this.limits.depth), source.ref),
          )
        : Effect.void;
    return register.pipe(
      Effect.andThen(
        source.object
          .section(
            Effect.gen({ self: this }, function* () {
              const before = source.events.length;
              const event = { seq: before + 1, at: this.now, keys };
              source.events.push(event);
              const storage = source.object.storage;
              const routed = yield* storage.get<Routed>("routed");
              if (!knows) {
                // Code without the targets: it routes nothing to them, and its cursors stay.
                yield* storage.put({ routed: { ...routed } });
                return [] as ReadonlyArray<Delivery>;
              }
              let next: Record<string, number> = {
                ...(routed ?? Object.fromEntries(this.targets.map((t) => [t, before]))),
              };
              const send: Array<Delivery> = [];
              for (const target of this.targets) {
                const deliveries = this.deliveries(source, event, false, target);
                if ((next[target] ?? 0) === before) {
                  next = { ...next, [target]: before + 1 };
                  send.push(...deliveries);
                } else {
                  // Behind here: withheld, for its reader to read from the log.
                  yield* source.role.onCommit(target);
                }
              }
              yield* storage.put({ routed: next });
              return send as ReadonlyArray<Delivery>;
            }),
            // A client's command: it is retried by the client, never lost halfway.
            false,
          )
          .pipe(
            Effect.tap((send) =>
              Effect.sync(() => {
                for (const delivery of send) {
                  const queue = this.outbox.get(delivery.source) ?? [];
                  queue.push(delivery);
                  this.outbox.set(delivery.source, queue);
                  this.queueSend(delivery.source);
                }
              }),
            ),
          ),
      ),
    );
  }

  /** Retry a call until it lands (a durable outbox would). */
  retry<A>(effect: Effect.Effect<A>): Effect.Effect<A> {
    return Effect.suspend(function loop(): Effect.Effect<A> {
      return effect.pipe(Effect.catchCause(() => Effect.suspend(loop)));
    });
  }

  /** Keys that run older code for a while: by key, until when. */
  readonly staleKeys = new Map<string, number>();
  private keyStaleUntil(key: string) {
    return this.staleKeys.get(key) ?? 0;
  }

  /** Deliver one queued live delivery. */
  private sendOne(delivery: Delivery) {
    const key = this.key(delivery.key);
    key.object.stats.requests += 1;
    this.vt = key.object.occupy(this.vt + this.latency.rpc / 2, this.latency.service);
    // Older code refuses a newer generation's delivery (its apply dies); the sender retries.
    if (this.now < this.busy(key).staleUntil)
      return Effect.die(new Crash("key still on older code"));
    return key.role.admit(this.targetOfKey(delivery.key), [delivery]).pipe(
      Effect.flatMap((apply) =>
        apply
          ? key.object.storage.exclusive(Effect.sync(() => this.apply(key, [delivery], false)))
          : Effect.void,
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.makespan = Math.max(this.makespan, this.vt);
        }),
      ),
    );
  }

  /** Run the next due job or send (ties in random order), or move the clock to it. `false` when idle. */
  step(): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const head = this.queue[0];
      if (head === undefined) return Effect.succeed(false);
      if (head.due > this.now) {
        this.now = head.due;
        return Effect.succeed(true);
      }
      return this.pop()!.run().pipe(Effect.as(true));
    });
  }

  /** Requests, rows read and rows written, by kind of object and in total. */
  totals() {
    const sum = (objects: Iterable<SimObject>) => {
      const total: Stats = { requests: 0, rowsRead: 0, rowsWritten: 0 };
      let hottest = 0;
      for (const object of objects) {
        total.requests += object.stats.requests;
        total.rowsRead += object.stats.rowsRead;
        total.rowsWritten += object.stats.rowsWritten;
        hottest = Math.max(hottest, object.stats.requests);
      }
      return { ...total, hottest };
    };
    const nodes = sum([...this.nodes.values()].map((n) => n.object));
    const sources = sum([...this.sources.values()].map((n) => n.object));
    const keys = sum([...this.keys.values()].map((n) => n.object));
    return {
      nodes,
      sources,
      keys,
      total: {
        requests: nodes.requests + sources.requests + keys.requests,
        rowsRead: nodes.rowsRead + sources.rowsRead + keys.rowsRead,
        rowsWritten: nodes.rowsWritten + sources.rowsWritten + keys.rowsWritten,
      },
      directory: {
        nodes: this.nodes.size,
        // Hash digits below a source's subtree root (`A:3f` is 2 deep).
        depth: Math.max(
          0,
          ...[...this.nodes.keys()].map((path) => path.slice(path.indexOf(":") + 1).length),
        ),
      },
    };
  }

  /** Reset every counter and the wall-time model (after seeding, before the deploy). */
  resetMeasures() {
    for (const object of [
      ...[...this.nodes.values()].map((n) => n.object),
      ...[...this.sources.values()].map((n) => n.object),
      ...[...this.keys.values()].map((n) => n.object),
    ]) {
      object.stats.requests = 0;
      object.stats.rowsRead = 0;
      object.stats.rowsWritten = 0;
      object.methods.clear();
      object.busy.clear();
    }
    this.vt = 0;
    this.makespan = 0;
    this.completedAt = undefined;
  }

  /**
   * Deploy the consumer: code that knows it, and the news of it. Instances
   * running at the time keep their older code until they have been idle.
   */
  deploy(options: { readonly running?: boolean } = {}) {
    this.deployed = true;
    if (options.running)
      for (const source of this.sources.values())
        source.staleUntil = Math.max(source.staleUntil, this.now + 20_000);
    return Effect.forEach(
      this.targets,
      (target) => this.retry(this.net.run.begin(target, this.planOf(target))),
      { discard: true },
    );
  }

  /** Run until nothing is left to do, interleaving `actions` (client commits). */
  run(
    actions: Array<() => Effect.Effect<unknown>> = [],
    options: { readonly maxSteps?: number } = {},
  ) {
    return Effect.gen({ self: this }, function* () {
      const pending = [...actions];
      for (let steps = 0; steps < (options.maxSteps ?? 200_000); steps++) {
        if (pending.length > 0 && this.random() < 0.2) {
          this.now += 1;
          yield* pending.shift()!();
          continue;
        }
        const busy = yield* this.step();
        if (this.completedAt === undefined && this.completed().includes(this.target))
          this.completedAt = this.vt;
        if (!busy && pending.length === 0) return steps;
        if (!busy) {
          this.now += 1;
          yield* pending.shift()!();
        }
      }
      return yield* Effect.die(new Error("the simulation did not settle"));
    });
  }

  /** Which targets' runs are complete. */
  status() {
    return Effect.sync(() => ({ complete: this.completed() }));
  }
}
