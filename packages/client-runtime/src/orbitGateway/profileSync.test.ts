// @effect-diagnostics globalTimers:off - The profile sync runs on plain promises, outside an Effect runtime.
import { describe, expect, it } from "vite-plus/test";

import {
  OrbitGatewayError,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
} from "./client.ts";
import type { JsonObject } from "./profileDocument.ts";
import {
  createProfileSync,
  type ProfileSyncChannel,
  type ProfileSyncState,
} from "./profileSync.ts";
import { jsonEqual, mergeAppearance, mergeDeviceSection, toGatewayForm } from "./sectionMerge.ts";
import {
  createSidebarHiddenThreadsChannel,
  parseSidebarHiddenThreads,
  SidebarHiddenThreadsCapacityError,
  type SidebarHiddenIntent,
  type SidebarHiddenOp,
} from "./sidebarHiddenThreads.ts";

type Values = Record<string, string | number | boolean>;
const device = (values: Values, schema = 1): JsonObject => ({ schema, values: { ...values } });
const valuesOf = (section: JsonObject | null | undefined): Values =>
  ((section?.values as Values | undefined) ?? {}) as Values;

/** What the real Gateway does to a section: refuses empty maps, trims strings, stores "" as null. */
function storedLikeTheGateway(value: unknown): unknown {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (Array.isArray(value)) return value.map(storedLikeTheGateway);
  if (typeof value === "object" && value !== null) {
    if (Object.keys(value).length === 0) {
      throw new OrbitGatewayError({
        code: "validation.failed",
        message: "empty map",
        status: 422,
        details: {},
      });
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, storedLikeTheGateway(entry)]),
    );
  }
  return value;
}

/**
 * What the real Gateway stores for a thread-refs section: null and an empty list both
 * become an explicit `{schema: 1, threads: []}`; a bare list, blank refs or `threads` as a map are 422.
 */
function storedThreadRefs(value: unknown): JsonObject {
  const refuse = (why: string): never => {
    throw new OrbitGatewayError({
      code: "validation.failed",
      message: why,
      status: 422,
      details: {},
    });
  };
  if (value === null) return { schema: 1, threads: [] };
  if (typeof value !== "object" || Array.isArray(value)) return refuse("not an object");
  const { schema, threads } = value as { schema?: unknown; threads?: unknown };
  if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1 || schema > 1000) {
    return refuse("unknown schema");
  }
  if (!Array.isArray(threads)) return refuse("threads must be a list");
  if (threads.length === 0) return { schema: 1, threads: [] };
  // The Gateway's PHP regexes: ASCII whitespace only, lengths in UTF-8 bytes.
  const ref = (value: unknown, colon: boolean) =>
    typeof value === "string" &&
    (colon ? /^[^ \t\n\v\f\r:]+$/ : /^[^ \t\n\v\f\r]+$/).test(value) &&
    new TextEncoder().encode(value).length <= 255;
  const seen = new Set<string>();
  return {
    schema,
    threads: threads.map((entry: unknown) => {
      const { environmentId, threadId } = (entry ?? {}) as Record<string, unknown>;
      if (!ref(environmentId, true) || !ref(threadId, false)) refuse("bad ref");
      const key = `${environmentId as string}:${threadId as string}`;
      if (seen.has(key)) refuse("duplicate ref");
      seen.add(key);
      return { environmentId, threadId } as JsonObject;
    }),
  };
}

/** An in-memory Gateway that checks section versions the way the real one is specified to. */
function fakeGateway(options: { sections?: boolean; profile?: { id: number; name: string } } = {}) {
  const profile = options.profile ?? { id: 1, name: "Nick" };
  const gateway = {
    version: 1,
    supportsSections: options.sections ?? true,
    patchStatus: null as number | null,
    alwaysConflict: false,
    sections: new Map<string, { version: number; value: JsonObject; updatedBy: string }>(),
    gets: 0,
    patches: [] as Record<string, OrbitGatewaySectionPatch>[],
    caller: "mac",
  };
  const settings = (): OrbitGatewaySettings => {
    const document: Record<string, unknown> = { workspaces: [] };
    const devices: Record<string, unknown> = {};
    const meta: Record<string, { version: number; updatedAt: string | null; updatedBy: string }> =
      {};
    for (const [name, entry] of gateway.sections) {
      if (name === "appearance" || name === "sidebarHiddenThreads") document[name] = entry.value;
      else devices[name.slice("devices.".length)] = entry.value;
      meta[name] = { version: entry.version, updatedAt: "now", updatedBy: entry.updatedBy };
    }
    if (Object.keys(devices).length > 0) document.devices = devices;
    return {
      profileId: profile.id,
      version: gateway.version,
      workspaces: [],
      updatedAt: "",
      document,
      sections: gateway.supportsSections ? meta : null,
    };
  };
  const client = {
    settings: async () => {
      gateway.gets += 1;
      return settings();
    },
    patchSections: async (_id: number, patch: Record<string, OrbitGatewaySectionPatch>) => {
      gateway.patches.push(patch);
      if (gateway.patchStatus !== null) {
        throw new OrbitGatewayError({
          code: "gateway.request_failed",
          message: "no",
          status: gateway.patchStatus,
          details: {},
        });
      }
      const stored = new Map<string, JsonObject | null>();
      for (const [name, section] of Object.entries(patch)) {
        stored.set(
          name,
          name === "sidebarHiddenThreads"
            ? storedThreadRefs(section.value)
            : (storedLikeTheGateway(section.value) as JsonObject | null),
        );
      }
      const stale = Object.entries(patch).filter(
        ([name, section]) =>
          gateway.alwaysConflict || (gateway.sections.get(name)?.version ?? 0) !== section.version,
      );
      if (stale.length > 0) {
        throw new OrbitGatewayError({
          code: "conn.settings_version_conflict",
          message: "stale",
          status: 409,
          details: {
            current_version: gateway.version,
            sections: Object.fromEntries(
              stale.map(([name]) => [name, gateway.sections.get(name)?.version ?? 0]),
            ),
          },
        });
      }
      for (const name of Object.keys(patch)) {
        const current = gateway.sections.get(name);
        const value = stored.get(name) ?? null;
        if (value === null) gateway.sections.delete(name);
        else {
          gateway.sections.set(name, {
            version: (current?.version ?? 0) + 1,
            value,
            updatedBy: gateway.caller,
          });
        }
      }
      gateway.version += 1;
      return settings();
    },
  };
  const me = (): OrbitGatewayNode => ({
    id: 8,
    name: gateway.caller,
    wireguardIp: "10.44.0.6",
    profile: { ...profile, settingsVersion: gateway.version, updatedAt: "" },
  });
  return { gateway, client, me };
}

/** One device with a desktop-settings channel and an appearance channel kept in memory. */
function makeDevice(
  fake: ReturnType<typeof fakeGateway>,
  initial: { settings?: Values; appearance?: JsonObject | null; state?: ProfileSyncState } = {},
  extra: { now?: () => number } = {},
) {
  const memory = {
    settings: { ...(initial.settings ?? { font: "Inter", size: 15 }) } as Values,
    appearance: (initial.appearance ?? { schema: 1, mode: "system", contrast: 100 }) as JsonObject,
    state: (initial.state ?? null) as ProfileSyncState | null,
    writes: [] as string[],
    unreadable: false,
  };
  const channels: ProfileSyncChannel[] = [
    {
      name: "devices.desktop",
      readLocal: () => device(memory.settings),
      applyRemote: (value) => {
        // Applying keeps only the keys this build knows, like the real allowlist.
        const known = valuesOf(value);
        memory.settings = {
          font: String(known.font ?? memory.settings.font),
          size: Number(known.size ?? memory.settings.size),
        };
        memory.writes.push("devices.desktop");
      },
      merge: mergeDeviceSection,
    },
    {
      name: "appearance",
      readLocal: () => (memory.unreadable ? null : { ...memory.appearance }),
      applyRemote: (value) => {
        memory.appearance = {
          schema: 1,
          mode: value.mode ?? "system",
          contrast: value.contrast ?? 100,
        };
        memory.writes.push("appearance");
      },
      merge: mergeAppearance,
    },
  ];
  const engine = createProfileSync({
    client: fake.client,
    channels: () => channels,
    loadState: () => memory.state,
    saveState: (state) => {
      memory.state = state;
    },
    ...(extra.now ? { now: extra.now } : {}),
  });
  const sync = async () => {
    fake.gateway.caller = "device";
    return engine.run(fake.me());
  };
  return { memory, engine, sync };
}

describe("profile sync engine", () => {
  it("seeds an empty profile from the first device and lets a second device adopt it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const first = await mac.sync();
    expect(first).toMatchObject({
      kind: "synced",
      outcomes: { "devices.desktop": "seeded", appearance: "seeded" },
    });
    expect(fake.gateway.patches).toHaveLength(1);
    expect(Object.keys(fake.gateway.patches[0]!).sort()).toEqual(["appearance", "devices.desktop"]);

    const other = makeDevice(fake, { settings: { font: "Menlo", size: 12 } });
    const second = await other.sync();
    expect(second).toMatchObject({
      kind: "synced",
      outcomes: { "devices.desktop": "adopted", appearance: "adopted" },
    });
    expect(other.memory.settings).toEqual({ font: "Inter", size: 15 });
    expect(fake.gateway.patches).toHaveLength(1);
  });

  it("copies the new profile's settings to the device on a switch, and back", async () => {
    const nick = fakeGateway();
    const work = fakeGateway({ profile: { id: 2, name: "Work" } });
    await makeDevice(work, { settings: { font: "Menlo", size: 12 } }).sync();
    const mac = makeDevice(nick, { settings: { font: "Inter", size: 15 } });
    await mac.sync();

    const switched = makeDevice(work, { settings: mac.memory.settings, state: mac.memory.state! });
    expect(await switched.sync()).toMatchObject({
      kind: "synced",
      outcomes: { "devices.desktop": "adopted", appearance: "adopted" },
    });
    expect(switched.memory.settings).toEqual({ font: "Menlo", size: 12 });
    // The profile the device left keeps its own settings; the switch writes to neither profile.
    expect(nick.gateway.patches).toHaveLength(1);
    expect(work.gateway.patches).toHaveLength(1);

    const back = makeDevice(nick, {
      settings: switched.memory.settings,
      state: switched.memory.state!,
    });
    await back.sync();
    expect(back.memory.settings).toEqual({ font: "Inter", size: 15 });
    expect(nick.gateway.patches).toHaveLength(1);
  });

  it("sends nothing after a pull and reads nothing while the profile is unchanged", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    const other = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await other.sync();

    mac.memory.settings.size = 18;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(2);

    const patchesBefore = fake.gateway.patches.length;
    const pulled = await other.sync();
    expect(pulled).toMatchObject({ outcomes: { "devices.desktop": "pulled" } });
    expect(other.memory.settings.size).toBe(18);
    // The write that applied the profile's value is not an edit: no echo, however often it runs.
    await other.sync();
    await other.sync();
    expect(fake.gateway.patches).toHaveLength(patchesBefore);

    const getsBefore = fake.gateway.gets;
    await other.sync();
    expect(fake.gateway.gets).toBe(getsBefore);
  });

  it("does not echo when the device normalises what it was given", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    // Another build wrote a value this one rounds on apply.
    fake.gateway.sections.set("appearance", {
      version: 5,
      value: { schema: 1, mode: "dark", contrast: 120, futureKey: true },
      updatedBy: "phone",
    });
    fake.gateway.version += 1;
    await mac.sync();
    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("converges two devices that edit different keys at the same time", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    await mini.sync();

    mac.memory.settings.font = "Menlo";
    mini.memory.settings.size = 20;
    await mac.sync();
    // The mini holds a stale version: its PATCH conflicts, merges and succeeds.
    const result = await mini.sync();
    expect(result).toMatchObject({ outcomes: { "devices.desktop": "merged" } });
    expect(mini.memory.settings).toEqual({ font: "Menlo", size: 20 });

    await mac.sync();
    expect(mac.memory.settings).toEqual({ font: "Menlo", size: 20 });
    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mini.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("reports a local edit as a change, but not a value it just applied from the profile", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    expect(mac.engine.hasLocalChanges()).toBe(true);
    await mac.sync();
    expect(mac.engine.hasLocalChanges()).toBe(false);
    const appearance = fake.gateway.sections.get("appearance")!;
    fake.gateway.sections.set("appearance", {
      version: appearance.version + 1,
      value: { schema: 1, mode: "dark", contrast: 100 },
      updatedBy: "phone",
    });
    fake.gateway.version += 1;
    await mac.sync();
    expect(mac.memory.appearance).toMatchObject({ mode: "dark" });
    expect(mac.engine.hasLocalChanges()).toBe(false);
    mac.memory.settings.size = 18;
    expect(mac.engine.hasLocalChanges()).toBe(true);
  });

  it("still pulls another section that changed while its own PATCH was in flight", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    const staleMe = fake.me();
    // Another device writes the appearance after the mac read /me.
    const appearance = fake.gateway.sections.get("appearance")!;
    fake.gateway.sections.set("appearance", {
      version: appearance.version + 1,
      value: { schema: 1, mode: "dark", contrast: 100 },
      updatedBy: "phone",
    });
    fake.gateway.version += 1;
    mac.memory.settings.size = 18;
    await mac.engine.run(staleMe);
    expect(fake.gateway.patches.at(-1)).toHaveProperty(["devices.desktop"]);
    await mac.sync();
    expect(mac.memory.appearance).toMatchObject({ mode: "dark" });
  });

  it("pulls a change to a section that was unreadable while the profile was read", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    const appearance = fake.gateway.sections.get("appearance")!;
    fake.gateway.sections.set("appearance", {
      version: appearance.version + 1,
      value: { schema: 1, mode: "dark", contrast: 100 },
      updatedBy: "phone",
    });
    fake.gateway.version += 1;
    // The theme is still loading: appearance reads as null while the desktop settings change.
    mac.memory.unreadable = true;
    mac.memory.settings.size = 18;
    // The run does not count the new document version as applied, so a caller reads again.
    const partial = await mac.sync();
    expect(partial).toMatchObject({ kind: "synced" });
    expect(partial.kind === "synced" && partial.version).toBeLessThan(fake.gateway.version);
    mac.memory.unreadable = false;
    await mac.sync();
    expect(mac.memory.appearance).toMatchObject({ mode: "dark" });
  });

  it("lets the device in front of the user win when both edit the same key", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    await mini.sync();
    mac.memory.settings.size = 16;
    mini.memory.settings.size = 22;
    await mac.sync();
    await mini.sync();
    await mac.sync();
    expect(mini.memory.settings.size).toBe(22);
    expect(mac.memory.settings.size).toBe(22);
  });

  it("keeps keys it does not know when it sends a change", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    fake.gateway.sections.set("devices.desktop", {
      version: 2,
      value: device({ font: "Inter", size: 15, futureSetting: "keep me" }),
      updatedBy: "newer-build",
    });
    fake.gateway.version += 1;
    await mac.sync();

    mac.memory.settings.size = 17;
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value)).toEqual({
      font: "Inter",
      size: 17,
      futureSetting: "keep me",
    });
  });

  it("leaves a section written by a newer schema untouched", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    fake.gateway.sections.set("devices.desktop", {
      version: 2,
      value: device({ font: "Inter", size: 15, newShape: 1 }, 2),
      updatedBy: "newer-build",
    });
    fake.gateway.version += 1;
    mac.memory.settings.size = 30;
    const before = fake.gateway.patches.length;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(before);
    expect(fake.gateway.sections.get("devices.desktop")!.value.schema).toBe(2);
  });

  it("leaves everything alone on a Gateway without sections", async () => {
    const fake = fakeGateway({ sections: false });
    const mac = makeDevice(fake);
    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(0);
  });

  it("treats a PATCH the Gateway does not know as unsupported, and probes again later", async () => {
    const fake = fakeGateway();
    fake.gateway.patchStatus = 404;
    let clock = 1_000;
    const mac = makeDevice(fake, {}, { now: () => clock });
    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(1);

    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(1);

    clock += 11 * 60_000;
    fake.gateway.patchStatus = null;
    expect(await mac.sync()).toMatchObject({ kind: "synced" });
    expect(fake.gateway.sections.has("appearance")).toBe(true);
  });

  it("ignores a failed PATCH from a superseded scope", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const patch = fake.client.patchSections;
    let current = true;
    fake.client.patchSections = async (id, sections) => {
      current = false;
      fake.gateway.patchStatus = 404;
      return patch(id, sections);
    };

    expect(await mac.engine.run(fake.me(), () => current)).toEqual({ kind: "superseded" });

    fake.client.patchSections = patch;
    fake.gateway.patchStatus = null;
    expect(await mac.sync()).toMatchObject({ kind: "synced" });
    expect(fake.gateway.sections.has("appearance")).toBe(true);
  });

  it("gives up after three conflicting attempts", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 99;
    fake.gateway.alwaysConflict = true;
    const before = fake.gateway.patches.length;
    const error = await mac.sync().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrbitGatewayError);
    expect(error).toMatchObject({ code: "conn.settings_version_conflict" });
    expect(fake.gateway.patches.length - before).toBe(3);
  });

  it("does not resend a value the Gateway refused until the device changes it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 99;
    fake.gateway.patchStatus = 422;
    await expect(mac.sync()).rejects.toMatchObject({ status: 422 });
    const attempts = fake.gateway.patches.length;
    expect(mac.engine.hasLocalChanges()).toBe(false);
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(attempts);
    fake.gateway.patchStatus = null;
    mac.memory.settings.size = 98;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(attempts + 1);
  });

  it("keeps an edit made while the PATCH was in flight for the next run", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 40;
    const patch = fake.client.patchSections;
    fake.client.patchSections = async (id, sections) => {
      mac.memory.settings.size = 41;
      return patch(id, sections);
    };
    await mac.sync();
    expect(mac.memory.settings.size).toBe(41);
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).size).toBe(41);
  });

  it("returns who changed what when it read the profile", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const result = await mac.sync();
    expect(result).toMatchObject({
      kind: "synced",
      sections: { appearance: { updatedBy: "device" } },
    });
  });
});

describe("overlapping runs", () => {
  it("sends one PATCH when two runs start back to back", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    fake.gateway.caller = "device";
    const me = fake.me();
    // Both triggers fire before either run has read the profile, as when an effect mounts twice.
    const [first, second] = await Promise.all([mac.engine.run(me), mac.engine.run(me)]);
    expect(fake.gateway.patches).toHaveLength(1);
    expect(Object.keys(fake.gateway.patches[0]!).sort()).toEqual(["appearance", "devices.desktop"]);
    expect(first).toMatchObject({ outcomes: { "devices.desktop": "seeded" } });
    // The second run waited, found nothing dirty and sent nothing; it did not meet a 409.
    expect(second).toMatchObject({ kind: "synced", outcomes: {} });
  });

  it("runs one at a time even when a run is slow", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    let inFlight = 0;
    let overlapped = false;
    const settings = fake.client.settings;
    fake.client.settings = async () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      // Yield long enough for an unserialized run to start its own read.
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      try {
        return await settings();
      } finally {
        inFlight -= 1;
      }
    };
    const me = fake.me();
    await Promise.all([mac.engine.run(me), mac.engine.run(me), mac.engine.run(me)]);
    expect(overlapped).toBe(false);
    expect(fake.gateway.patches).toHaveLength(1);
  });

  it("applies nothing it read after the caller's profile scope changed", async () => {
    const fake = fakeGateway();
    await makeDevice(fake, { settings: { font: "Menlo", size: 12 } }).sync();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    let current = true;
    const settings = fake.client.settings;
    fake.client.settings = async () => {
      const read = await settings();
      // The user switches provider or profile while this read is in flight.
      current = false;
      return read;
    };
    fake.gateway.caller = "device";
    expect(await mac.engine.run(fake.me(), () => current)).toEqual({ kind: "superseded" });
    expect(mac.memory.settings).toEqual({ font: "Inter", size: 15 });
    expect(mac.memory.writes).toEqual([]);
    expect(mac.memory.state).toBeNull();
    // A run queued behind it for the old scope does not even read.
    const gets = fake.gateway.gets;
    expect(await mac.engine.run(fake.me(), () => false)).toEqual({ kind: "superseded" });
    expect(fake.gateway.gets).toBe(gets);
  });
});

describe("what the Gateway does to a section", () => {
  it("never sends an empty map, and still syncs the rest of the section", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, {
      appearance: {
        schema: 1,
        mode: "dark",
        contrast: 100,
        themes: {},
        variants: { light: {}, dark: {} },
        customThemes: [{ id: "a", colors: {} }],
      } as JsonObject,
    });
    await expect(mac.sync()).resolves.toMatchObject({ kind: "synced" });
    expect(fake.gateway.sections.get("appearance")!.value).toEqual({
      schema: 1,
      mode: "dark",
      contrast: 100,
      customThemes: [{ id: "a" }],
    });
  });

  it("does not push again when the Gateway trimmed a string or turned an empty one into null", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "", size: 15 } });
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).font).toBeNull();

    mac.memory.settings.font = "  Inter  ";
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).font).toBe("Inter");

    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("does not read its own normalized write as another device's edit", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "", size: 15 } });
    await mac.sync();
    await mini.sync();
    mac.memory.settings.size = 18;
    mini.memory.settings.font = " ";
    await mac.sync();
    // The mini's edit is blank, which the Gateway stores as null: same as what is there.
    const result = await mini.sync();
    expect(result).toMatchObject({ kind: "synced" });
    expect(mini.memory.settings.size).toBe(18);
    const patches = fake.gateway.patches.length;
    await mini.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("puts values in the Gateway's form", () => {
    expect(
      toGatewayForm({
        a: "  x ",
        b: "   ",
        c: { d: {}, e: [] },
        f: [{}, "", { g: 1 }],
        h: {},
        i: 0,
        j: false,
      }),
    ).toEqual({ a: "x", b: null, c: { e: [] }, f: [null, { g: 1 }], j: false, i: 0 });
  });
});

describe("non-user changes", () => {
  it("does not push a server-pushed default and does not seed the profile with it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100, theme: "server-default" };
    finish();

    await mac.sync();
    expect(fake.gateway.sections.has("appearance")).toBe(false);
    expect(fake.gateway.sections.has("devices.desktop")).toBe(true);
    const patches = fake.gateway.patches.length;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("pushes the user's own pick that comes after a default", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100 };
    finish();
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value.mode).toBe("system");

    mac.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value.mode).toBe("light");
  });

  it("lets the profile replace a default that was not the user's", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const phone = makeDevice(fake);
    await mac.sync();
    await phone.sync();
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100 };
    finish();

    phone.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    await phone.sync();
    await mac.sync();
    expect(mac.memory.appearance.mode).toBe("light");
  });

  it("does not hide unsent user edits behind a later default", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "light", contrast: 130 };
    finish();
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value).toMatchObject({
      mode: "light",
      contrast: 130,
    });
  });
});

describe("section merge", () => {
  const appearance = (overrides: Record<string, unknown> = {}): JsonObject =>
    ({
      schema: 1,
      mode: "system",
      contrast: 100,
      themes: {
        light: { id: "t3-code", source: "stock" },
        dark: { id: "ocean", source: "builtin" },
      },
      customThemes: [],
      ...overrides,
    }) as JsonObject;
  const custom = (id: string, name = id): JsonObject => ({
    id,
    name,
    appearance: "dark",
    colors: { canvas: "#000" },
  });

  it("merges mode, contrast and each slot on their own", () => {
    const base = appearance();
    const local = appearance({ mode: "dark" });
    const remote = appearance({
      contrast: 120,
      themes: {
        light: { id: "grove", source: "builtin" },
        dark: { id: "ocean", source: "builtin" },
      },
    });
    expect(mergeAppearance(base, local, remote)).toEqual(
      appearance({
        mode: "dark",
        contrast: 120,
        themes: {
          light: { id: "grove", source: "builtin" },
          dark: { id: "ocean", source: "builtin" },
        },
      }),
    );
  });

  it("merges the custom theme library by id and lets an edit beat a delete", () => {
    const base = appearance({ customThemes: [custom("a"), custom("b")] });
    const local = appearance({ customThemes: [custom("a", "A local"), custom("b"), custom("c")] });
    const remote = appearance({ customThemes: [custom("a"), custom("b", "B edited")] });
    const merged = mergeAppearance(base, local, remote).customThemes as JsonObject[];
    expect(merged.map((theme) => `${theme.id}:${theme.name}`)).toEqual([
      "a:A local",
      "b:B edited",
      "c:c",
    ]);

    const deletedRemotely = appearance({ customThemes: [custom("b")] });
    const kept = mergeAppearance(
      base,
      appearance({ customThemes: [custom("a", "A local"), custom("b")] }),
      deletedRemotely,
    );
    expect((kept.customThemes as JsonObject[]).map((theme) => theme.id)).toEqual(["a", "b"]);
  });

  it("keeps unknown keys from the profile", () => {
    const merged = mergeAppearance(appearance(), appearance({ mode: "dark" }), {
      ...appearance(),
      accentBoost: 3,
      themes: { ...(appearance().themes as JsonObject), highContrast: { id: "x" } },
    });
    expect(merged.accentBoost).toBe(3);
    expect((merged.themes as JsonObject).highContrast).toEqual({ id: "x" });
    expect(merged.mode).toBe("dark");
  });

  it("compares JSON by content, not by key order", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

/** One device that hides sidebar threads, with the store the web app keeps per profile. */
function makeHidingDevice(fake: ReturnType<typeof fakeGateway>, agreed: string[] = []) {
  const memory = {
    agreed,
    ops: new Map<string, SidebarHiddenOp>(),
    state: null as ProfileSyncState | null,
  };
  let ids = 0;
  const channel = createSidebarHiddenThreadsChannel({
    read: () => memory,
    adopt: (next, done) => {
      memory.agreed = [...next];
      const ops = new Map(memory.ops);
      for (const [key, id] of done) if (ops.get(key)?.id === id) ops.delete(key);
      memory.ops = ops;
    },
  });
  const engine = createProfileSync({
    client: fake.client,
    channels: () => [channel],
    loadState: () => memory.state,
    saveState: (state) => {
      memory.state = state;
    },
  });
  const set = (key: string, intent: SidebarHiddenIntent) => {
    memory.ops = new Map(memory.ops).set(key, { intent, id: `op-${++ids}` });
  };
  return { memory, set, sync: () => engine.run(fake.me()), overflow: channel.overflow };
}

const profileHidden = (fake: ReturnType<typeof fakeGateway>) =>
  parseSidebarHiddenThreads(fake.gateway.sections.get("sidebarHiddenThreads")?.value) ?? [];

describe("sidebar hidden threads sync", () => {
  it("writes nothing for a device that hid nothing", async () => {
    const fake = fakeGateway();
    await makeHidingDevice(fake).sync();
    expect(fake.gateway.patches).toHaveLength(0);
  });

  it("merges a first load into the profile instead of replacing either side", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:t1", "hide");
    await mac.sync();
    expect(profileHidden(fake)).toEqual(["env-a:t1"]);

    // A device with a stale cached copy and its own peek: the cache is not a deletion, the peek joins.
    const other = makeHidingDevice(fake, ["env-a:t0"]);
    other.set("env-b:t2", "hide");
    await other.sync();
    expect(profileHidden(fake)).toEqual(["env-a:t1", "env-b:t2"]);
    expect(other.memory.agreed).toEqual(["env-a:t1", "env-b:t2"]);
    expect(other.memory.ops.size).toBe(0);
  });

  it("brings one client's marks to a second client of the same profile", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    const laptop = makeHidingDevice(fake);
    await laptop.sync();
    mac.set("env-a:t1", "hide");
    await mac.sync();
    await laptop.sync();
    expect(laptop.memory.agreed).toEqual(["env-a:t1"]);

    // The laptop shows it while the mac hides another: both intents survive the version conflict.
    laptop.set("env-a:t1", "show");
    mac.set("env-a:t2", "hide");
    await mac.sync();
    await laptop.sync();
    expect(profileHidden(fake)).toEqual(["env-a:t2"]);
    await mac.sync();
    expect(mac.memory.agreed).toEqual(["env-a:t2"]);
  });

  it("lets an explicit show win over a hide still queued for the same thread", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:t1", "hide");
    mac.set("env-a:t1", "show");
    await mac.sync();
    expect(profileHidden(fake)).toEqual([]);
  });

  it("keeps marks on the device when the Gateway refuses the write", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:t1", "hide");
    fake.gateway.patchStatus = 422;
    await expect(mac.sync()).rejects.toMatchObject({ status: 422 });
    expect(mac.memory.ops.get("env-a:t1")?.intent).toBe("hide");
    fake.gateway.patchStatus = null;
    mac.set("env-a:t2", "hide");
    await mac.sync();
    expect(profileHidden(fake)).toEqual(["env-a:t1", "env-a:t2"]);
  });

  it("sends a show from a stale empty copy, through a version conflict", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    const laptop = makeHidingDevice(fake);
    await laptop.sync();
    mac.set("env-a:x", "hide");
    await mac.sync();
    // The laptop still holds the empty set it read; its show equals that copy, yet must go out.
    laptop.set("env-a:x", "show");
    const fetch = fake.client.settings;
    let raced = false;
    fake.client.settings = async () => {
      const read = await fetch();
      if (!raced) {
        // Another device writes between this read and the laptop's PATCH: a real 409.
        raced = true;
        mac.set("env-a:y", "hide");
        await mac.sync();
      }
      return read;
    };
    const patchesBefore = fake.gateway.patches.length;
    await laptop.sync();
    expect(fake.gateway.patches.length - patchesBefore).toBe(3);
    expect(profileHidden(fake)).toEqual(["env-a:y"]);
    expect(laptop.memory.agreed).toEqual(["env-a:y"]);
    expect(laptop.memory.ops.size).toBe(0);
    // Only this section is in the write: other settings are never sent with it.
    expect(Object.keys(fake.gateway.patches.at(-1)!)).toEqual(["sidebarHiddenThreads"]);
  });

  it("remembers a section observed before an unconfirmed Show", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    const laptop = makeHidingDevice(fake);
    await laptop.sync();
    mac.set("env-a:x", "hide");
    await mac.sync();
    laptop.set("env-a:x", "show");

    const get = fake.client.settings;
    const patch = fake.client.patchSections;
    fake.client.patchSections = async () => ({
      ...(await get()),
      document: {},
      sections: {},
    });
    await expect(laptop.sync()).rejects.toThrow(/did not confirm/);
    expect(laptop.memory.ops.get("env-a:x")?.intent).toBe("show");

    fake.client.settings = async () => ({
      ...(await get()),
      document: {},
      sections: {},
    });
    await expect(laptop.sync()).rejects.toThrow(/did not confirm/);
    expect(laptop.memory.ops.get("env-a:x")?.intent).toBe("show");

    fake.client.settings = get;
    fake.client.patchSections = patch;
    await laptop.sync();
    expect(profileHidden(fake)).toEqual([]);
    expect(laptop.memory.ops.size).toBe(0);
  });

  it("never downgrades a confirmed section when responses omit its version", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    const laptop = makeHidingDevice(fake);
    mac.set("env-a:x", "hide");
    await mac.sync();
    await laptop.sync();
    laptop.set("env-a:x", "show");

    const get = fake.client.settings;
    let reads = 0;
    fake.client.settings = async () => {
      const settings = await get();
      reads += 1;
      return { ...settings, document: reads === 1 ? settings.document : {}, sections: {} };
    };
    // Neither an unversioned value nor an entirely omitted section can acknowledge Show.
    await expect(laptop.sync()).rejects.toThrow(/did not confirm/);
    await expect(laptop.sync()).rejects.toThrow(/did not confirm/);
    expect(laptop.memory.ops.get("env-a:x")?.intent).toBe("show");
    expect(laptop.memory.state?.sections.sidebarHiddenThreads?.version).toBe(1);
    expect(fake.gateway.patches).toHaveLength(1);

    fake.client.settings = get;
    await laptop.sync();
    expect(profileHidden(fake)).toEqual([]);
    expect(laptop.memory.ops.size).toBe(0);
  });

  it("syncs the marks that fit and keeps the rest local instead of dropping them", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    for (let index = 0; index < 501; index += 1) mac.set(`env-a:t${index}`, "hide");
    await mac.sync();
    expect(profileHidden(fake)).toHaveLength(500);
    expect([...mac.memory.ops.keys()]).toEqual(["env-a:t500"]);
    expect(mac.overflow()).toBeInstanceOf(SidebarHiddenThreadsCapacityError);
  });

  it("writes an absent section at version 0 and reads its version from the section, not the document", async () => {
    const fake = fakeGateway();
    // The profile's document version is unrelated to the section's.
    fake.gateway.version = 7;
    const mac = makeHidingDevice(fake);
    mac.set("env-a:t1", "hide");
    await mac.sync();
    expect(fake.gateway.patches[0]?.sidebarHiddenThreads?.version).toBe(0);
    expect(mac.memory.state?.sections.sidebarHiddenThreads?.version).toBe(1);
  });

  it("confirms a Show that clears the set from the explicit empty value the Gateway returns", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:t1", "hide");
    await mac.sync();
    mac.set("env-a:t1", "show");
    await mac.sync();
    expect(fake.gateway.patches[1]?.sidebarHiddenThreads).toEqual({
      version: 1,
      value: { schema: 1, threads: [] },
    });
    expect(fake.gateway.sections.get("sidebarHiddenThreads")).toMatchObject({
      version: 2,
      value: { schema: 1, threads: [] },
    });
    expect(mac.memory.ops.size).toBe(0);
    expect(mac.memory.agreed).toEqual([]);

    // A second client reads the cleared section as an explicit empty set.
    const laptop = makeHidingDevice(fake, ["env-a:t1"]);
    await laptop.sync();
    expect(laptop.memory.agreed).toEqual([]);
    expect(fake.gateway.patches).toHaveLength(2);
  });

  it("re-reads, merges and retries after a 409 that names the stale section", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    const laptop = makeHidingDevice(fake);
    await laptop.sync();
    mac.set("env-a:t1", "hide");
    await mac.sync();
    // The laptop's run reads before the mac's second write lands, so its PATCH is stale.
    const get = fake.client.settings;
    let raced = false;
    fake.client.settings = async () => {
      const read = await get();
      if (!raced) {
        raced = true;
        mac.set("env-a:t2", "hide");
        await mac.sync();
      }
      return read;
    };
    const patch = fake.client.patchSections;
    const conflicts: unknown[] = [];
    fake.client.patchSections = async (id, sections) => {
      try {
        return await patch(id, sections);
      } catch (error) {
        conflicts.push(error);
        throw error;
      }
    };
    laptop.set("env-b:t3", "hide");
    await laptop.sync();
    expect(conflicts).toEqual([
      expect.objectContaining({
        code: "conn.settings_version_conflict",
        details: expect.objectContaining({ sections: { sidebarHiddenThreads: 2 } }),
      }),
    ]);
    expect(profileHidden(fake)).toEqual(["env-a:t1", "env-a:t2", "env-b:t3"]);
    expect(laptop.memory.ops.size).toBe(0);
  });

  it("has a mock Gateway that refuses the shapes the real one refuses", async () => {
    const fake = fakeGateway();
    const ref = (environmentId: string, threadId: string) => ({ environmentId, threadId });
    const write = (value: unknown) =>
      fake.client.patchSections(1, {
        sidebarHiddenThreads: { version: 0, value: value as JsonObject },
      });
    await expect(write([])).rejects.toMatchObject({ status: 422 });
    await expect(write({ schema: 1, threads: {} })).rejects.toMatchObject({ status: 422 });
    await expect(
      write({ schema: 1, threads: [{ environmentId: " ", threadId: "t" }] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      write({ schema: 1, threads: [{ environmentId: "e", threadId: "a b" }] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      write({ schema: 1, threads: [ref("e", "t"), ref("e", "t")] }),
    ).rejects.toMatchObject({ status: 422 });
    const cleared = await write(null);
    expect(cleared.document.sidebarHiddenThreads).toEqual({ schema: 1, threads: [] });
    expect(cleared.sections?.sidebarHiddenThreads?.version).toBe(1);
  });

  it("leaves a mark the Gateway would refuse out of the write, without blocking the others", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a: ", "hide");
    mac.set("env-a:a b", "hide");
    mac.set("env-a:ok", "hide");
    await mac.sync();
    expect(profileHidden(fake)).toEqual(["env-a:ok"]);
    expect(mac.overflow()).toBeNull();
    // The refused marks stay hidden on this device only.
    expect([...mac.memory.ops.keys()]).toEqual(["env-a: ", "env-a:a b"]);
  });

  it("keeps a mark local when the write's trim would change its ref", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:\u00a0x", "hide");
    mac.set("\u00a0env-a:y\u00a0", "hide");
    mac.set("env-a:ok", "hide");
    await mac.sync();
    // Sent trimmed, the first would hide "env-a:x", another thread.
    expect(profileHidden(fake)).toEqual(["env-a:ok"]);
    expect([...mac.memory.ops.keys()]).toEqual(["env-a:\u00a0x", "\u00a0env-a:y\u00a0"]);
  });

  it.each([1, 2])(
    "writes nothing back from a schema %i read whose ref the write would trim",
    async (schema) => {
      const fake = fakeGateway();
      const value = { schema, threads: [{ environmentId: "env-a", threadId: "\u00a0x" }] };
      fake.gateway.sections.set("sidebarHiddenThreads", { version: 1, value, updatedBy: "other" });
      const device = makeHidingDevice(fake);
      await device.sync().catch(() => undefined);
      await device.sync().catch(() => undefined);
      // Neither an unhide (threads: []) nor another thread's ref ("x") goes out.
      expect(fake.gateway.patches).toHaveLength(0);
      expect(fake.gateway.sections.get("sidebarHiddenThreads")?.value).toEqual(value);
    },
  );

  it("reads refs the Gateway accepts, also with non-ASCII whitespace, and still sends a Show", async () => {
    const fake = fakeGateway();
    const mac = makeHidingDevice(fake);
    mac.set("env-a:x\u00a0y", "hide");
    mac.set("env-a:t1", "hide");
    await mac.sync();
    expect(profileHidden(fake)).toEqual(["env-a:x\u00a0y", "env-a:t1"]);

    const laptop = makeHidingDevice(fake);
    await laptop.sync();
    laptop.set("env-a:t1", "show");
    await laptop.sync();
    expect(profileHidden(fake)).toEqual(["env-a:x\u00a0y"]);
    expect(laptop.memory.ops.size).toBe(0);
  });
});
