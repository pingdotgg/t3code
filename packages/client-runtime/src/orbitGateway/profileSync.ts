import * as Schema from "effect/Schema";
import {
  OrbitGatewayError,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewayClient,
  type OrbitGatewayNode,
  type OrbitGatewaySectionMeta,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
} from "./client.ts";
import { isJsonObject, type JsonObject, type ProfileSectionName } from "./profileDocument.ts";
import { jsonEqual, toGatewayForm } from "./sectionMerge.ts";

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/**
 * Syncs sections of this device's Orbit profile, one channel per section. Per section it keeps
 * the profile version, the agreed `base` and the raw `remote`; local and remote edits together
 * merge and retry (`MAX_ATTEMPTS`). Applying sets `base` from a read-back, so pulls never echo;
 * the first sync with a profile adopts it (or seeds it); `beginNonUserChange` marks non-user writes.
 */

export interface ProfileSyncChannel {
  readonly name: ProfileSectionName;
  /**
   * The device's current value, or null while it cannot be read (settings still loading).
   * `base` is the value last agreed with the profile, for a channel that must keep a part of it
   * while the device cannot resolve that part yet.
   */
  readonly readLocal: (base: JsonObject | null) => JsonObject | null;
  /**
   * Writes the profile's value to the device. `previous` is the last value agreed with the
   * profile (null on the first sync), for channels that must remove what another device deleted.
   */
  readonly applyRemote: (value: JsonObject, previous: JsonObject | null) => void;
  /** Three-way merge, see sectionMerge.ts. The result is what gets sent. */
  readonly merge: (base: JsonObject | null, local: JsonObject, remote: JsonObject) => JsonObject;
  /**
   * The device keeps unsent intents, not a copy: each run rebases them onto the profile's value
   * (`merge(null, local, remote)`) and sends the result when it differs, also on a first sync. The
   * value the profile holds afterwards is always applied back, so the channel retires what it sent.
   */
  readonly rebases?: boolean;
  /** For `rebases`: the value of a section the profile does not have. */
  readonly empty?: JsonObject;
  /** For `rebases`: intents wait, so the run reads the profile instead of trusting its copy. */
  readonly hasPending?: () => boolean;
  /** For `rebases`: whether a value the Gateway returned is one this channel can read. */
  readonly accepts?: (value: JsonObject) => boolean;
}

export interface ProfileSyncSectionState {
  /** The section version this device last agreed on with the profile. */
  readonly version: number;
  /** The value agreed on, as the device reads it back; null when the profile had none. */
  readonly base: JsonObject | null;
  /** The profile's raw value at that version. */
  readonly remote: JsonObject | null;
}

export interface ProfileSyncState {
  readonly profileId: number;
  /** The whole-document version last seen, to know when a probe needs a full read. */
  readonly profileVersion: number;
  readonly sections: Readonly<Partial<Record<ProfileSectionName, ProfileSyncSectionState>>>;
  /** Device values that are not the user's own picks, see `beginNonUserChange`. */
  readonly ignored: Readonly<Partial<Record<ProfileSectionName, JsonObject>>>;
}

export interface ProfileSyncPorts {
  readonly client: Pick<OrbitGatewayClient, "settings" | "patchSections">;
  readonly channels: () => readonly ProfileSyncChannel[];
  readonly loadState: () => ProfileSyncState | null;
  readonly saveState: (state: ProfileSyncState) => void;
  readonly now?: () => number;
}

export type ProfileSyncOutcome = "adopted" | "seeded" | "pulled" | "pushed" | "merged";

export type ProfileSyncResult =
  | { readonly kind: "unbound" }
  | { readonly kind: "idle" }
  /** The Gateway predates profile sections: nothing was read or written. */
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "synced";
      readonly outcomes: Readonly<Partial<Record<ProfileSectionName, ProfileSyncOutcome>>>;
      /** Who changed what, from the latest read or write of this run; null when none happened. */
      readonly sections: Readonly<Record<string, OrbitGatewaySectionMeta>> | null;
    };

/** Attempts at a PATCH before giving up on a run, when other devices keep writing in between. */
const MAX_ATTEMPTS = 3;
/** How long an old Gateway is left alone before the next probe. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;
/**
 * How long a value a Gateway refused (422) waits before a rebasing channel sends it again: the
 * background probe's cadence, so an upgraded Gateway takes it without a local edit.
 */
const REJECTED_RETRY_MS = 30_000;

/** A Gateway reply that does not show what a rebasing channel needs to retire its intents. */
function unconfirmed(name: string, why: string): Error {
  return new Error(`The Orbit Gateway did not confirm the ${name} section: ${why}.`);
}

function emptyProfileSyncState(profileId = -1): ProfileSyncState {
  return { profileId, profileVersion: -1, sections: {}, ignored: {} };
}

interface Remote {
  readonly version: number;
  readonly value: JsonObject | null;
}

function remoteSection(settings: OrbitGatewaySettings, name: ProfileSectionName): Remote {
  const document = settings.document;
  const raw =
    name === "appearance" || name === "sidebarHiddenThreads"
      ? document[name]
      : name.startsWith("devices.")
        ? (document.devices as Record<string, unknown> | undefined)?.[name.slice("devices.".length)]
        : undefined;
  return {
    version: settings.sections?.[name]?.version ?? 0,
    value: isJsonObject(raw) ? raw : null,
  };
}

interface Push {
  readonly channel: ProfileSyncChannel;
  readonly version: number;
  readonly value: JsonObject;
  /** The device value this push was planned from. */
  readonly local: JsonObject;
  readonly kind: "seed" | "push" | "merge";
}

export function createProfileSync(ports: ProfileSyncPorts) {
  const now = ports.now ?? Date.now;
  let unsupportedUntil = 0;
  /**
   * A local value the Gateway refused (validation), so the same value is not sent again. A
   * rebasing channel sends it again after `REJECTED_RETRY_MS`, and its runs fail until then.
   */
  const rejected = new Map<
    ProfileSectionName,
    { readonly local: JsonObject; readonly at: number; readonly error: unknown }
  >();
  const isRejected = (channel: ProfileSyncChannel, local: JsonObject): boolean => {
    const entry = rejected.get(channel.name);
    if (entry === undefined || !jsonEqual(entry.local, local)) return false;
    return channel.rebases !== true || now() - entry.at < REJECTED_RETRY_MS;
  };

  const load = (profileId: number): ProfileSyncState => {
    const saved = ports.loadState();
    if (saved?.profileId === profileId) return saved;
    // Another profile (or none yet): every section starts over, the non-user marks stay.
    return { ...emptyProfileSyncState(profileId), ignored: saved?.ignored ?? {} };
  };

  async function runOnce(me: OrbitGatewayNode): Promise<ProfileSyncResult> {
    const profile = me.profile;
    if (profile === null) return { kind: "unbound" };
    if (now() < unsupportedUntil) return { kind: "unsupported" };
    const channels = ports.channels();

    let state = load(profile.id);
    const sections: Partial<Record<ProfileSectionName, ProfileSyncSectionState>> = {
      ...state.sections,
    };
    const ignored: Partial<Record<ProfileSectionName, JsonObject>> = { ...state.ignored };
    const commit = (profileVersion = state.profileVersion): void => {
      state = { profileId: profile.id, profileVersion, sections, ignored };
      ports.saveState(state);
    };
    const read = (channel: ProfileSyncChannel): JsonObject | null =>
      channel.readLocal(sections[channel.name]?.base ?? null);
    const outcomes: Partial<Record<ProfileSectionName, ProfileSyncOutcome>> = {};
    let meta: Readonly<Record<string, OrbitGatewaySectionMeta>> | null = null;
    let conflict: unknown = null;
    // A rebasing channel's refused intents still wait: the run reports the refusal again.
    let heldBack: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const readable = channels.filter((channel) => read(channel) !== null);
      if (readable.length === 0) return { kind: "idle" };

      const mustFetch =
        attempt > 1 ||
        profile.settingsVersion !== state.profileVersion ||
        readable.some(
          (channel) => sections[channel.name] === undefined || channel.hasPending?.() === true,
        );
      let remote: OrbitGatewaySettings | null = null;
      if (mustFetch) {
        remote = await ports.client.settings(profile.id);
        if (remote.sections === null) {
          unsupportedUntil = now() + UNSUPPORTED_RETRY_MS;
          return { kind: "unsupported" };
        }
        meta = remote.sections;
        if (remote.profileId !== profile.id && readable.some((channel) => channel.rebases)) {
          throw unconfirmed("profile", "the settings belong to another profile");
        }
      }

      // Everything from here to the PATCH is synchronous, so an edit cannot slip in between
      // reading the device and writing to it.
      const pushes: Push[] = [];
      for (const channel of readable) {
        const name = channel.name;
        const local = read(channel);
        if (local === null) continue;
        const known = sections[name];
        const profileSide: Remote | null = remote
          ? remoteSection(remote, name)
          : known
            ? { version: known.version, value: known.remote }
            : null;
        if (profileSide === null) continue;

        const pull = (value: JsonObject): void => {
          channel.applyRemote(value, known?.base ?? null);
          sections[name] = {
            version: profileSide.version,
            base: read(channel) ?? value,
            remote: value,
          };
          delete ignored[name];
        };

        if (channel.rebases === true) {
          // Rebased every run, also when the device's value equals `base`: an intent the profile
          // already satisfies is the only kind that retires without a write.
          if (remote !== null && channel.accepts !== undefined) {
            if (profileSide.version < (known?.version ?? 0)) {
              throw unconfirmed(name, "the read has an older section version");
            }
            if (profileSide.value !== null && remote.sections?.[name] === undefined) {
              throw unconfirmed(name, "the read has no section version");
            }
            if (profileSide.value === null) {
              if (
                profileSide.version !== 0 ||
                (known?.version ?? 0) !== 0 ||
                Object.hasOwn(remote.document, name)
              ) {
                throw unconfirmed(name, "the read has no section value");
              }
            } else if (!channel.accepts(profileSide.value)) {
              throw unconfirmed(name, "the read's section value is malformed");
            }
          }
          const current = profileSide.value ?? channel.empty ?? {};
          const value = toGatewayForm(channel.merge(null, toGatewayForm(local), current));
          // Keep the observed version even if the following write cannot be confirmed.
          sections[name] = {
            version: profileSide.version,
            base: profileSide.value,
            remote: profileSide.value,
          };
          if (jsonEqual(value, current)) {
            channel.applyRemote(current, known?.base ?? null);
            if (known === undefined || known.version !== profileSide.version) {
              outcomes[name] = known === undefined ? "adopted" : "pulled";
            }
          } else if (!isRejected(channel, local)) {
            pushes.push({ channel, version: profileSide.version, value, local, kind: "merge" });
          } else {
            heldBack = rejected.get(name)?.error ?? null;
          }
          continue;
        }

        if (known === undefined) {
          // First sync of this section, also after a switch to another profile: the profile wins.
          if (profileSide.value !== null) {
            pull(profileSide.value);
            outcomes[name] = "adopted";
          } else if (ignored[name] && jsonEqual(local, ignored[name])) {
            // Nothing the user chose: a server default must not seed the profile.
            sections[name] = { version: profileSide.version, base: null, remote: null };
          } else if (!isRejected(channel, local)) {
            pushes.push({
              channel,
              version: profileSide.version,
              value: toGatewayForm(local),
              local,
              kind: "seed",
            });
          }
          continue;
        }

        const remoteChanged = remote !== null && profileSide.version !== known.version;
        // A section another device cleared has no value to agree on any more.
        const base = remoteChanged && profileSide.value === null ? null : known.base;
        const dirty =
          !jsonEqual(local, base ?? undefined) &&
          !(ignored[name] !== undefined && jsonEqual(local, ignored[name]));

        if (!dirty) {
          if (remoteChanged && profileSide.value !== null) {
            pull(profileSide.value);
            outcomes[name] = "pulled";
          } else if (remoteChanged) {
            sections[name] = { version: profileSide.version, base: known.base, remote: null };
          }
          continue;
        }
        if (isRejected(channel, local)) continue;

        // Compared and sent the way the Gateway stores it (see toGatewayForm), so a value it
        // trimmed or an empty string it turned into null does not read as a remote edit.
        const sendable = toGatewayForm(local);
        const value = toGatewayForm(
          profileSide.value === null
            ? local
            : channel.merge(
                base === null ? null : toGatewayForm(base),
                sendable,
                profileSide.value,
              ),
        );
        if (profileSide.value !== null && jsonEqual(value, profileSide.value)) {
          // The profile already holds the result: nothing to send.
          if (!jsonEqual(sendable, value)) channel.applyRemote(value, known.base);
          sections[name] = {
            version: profileSide.version,
            base: read(channel) ?? value,
            remote: profileSide.value,
          };
          delete ignored[name];
          continue;
        }
        pushes.push({
          channel,
          version: profileSide.version,
          value,
          local,
          kind: remoteChanged ? "merge" : "push",
        });
      }

      if (pushes.length === 0) {
        commit(remote?.version ?? state.profileVersion);
        if (heldBack !== null) throw heldBack;
        return { kind: "synced", outcomes, sections: meta };
      }
      commit(remote?.version ?? state.profileVersion);

      const patch: Record<string, OrbitGatewaySectionPatch> = {};
      for (const push of pushes) {
        patch[push.channel.name] = { version: push.version, value: push.value };
      }
      let saved: OrbitGatewaySettings;
      try {
        saved = await ports.client.patchSections(profile.id, patch);
      } catch (error) {
        if (isOrbitGatewayError(error)) {
          if (error.status === 404 || error.status === 405) {
            unsupportedUntil = now() + UNSUPPORTED_RETRY_MS;
            return { kind: "unsupported" };
          }
          if (error.code === SETTINGS_VERSION_CONFLICT) {
            conflict = error;
            continue;
          }
          if (error.status === 422) {
            for (const push of pushes) {
              rejected.set(push.channel.name, { local: push.local, at: now(), error });
            }
          }
        }
        throw error;
      }

      // A rebasing channel retires intents only against what the Gateway says it now holds.
      for (const push of pushes) {
        if (push.channel.rebases !== true) continue;
        const name = push.channel.name;
        if (saved.profileId !== profile.id) {
          throw unconfirmed(name, "the reply belongs to another profile");
        }
        const version = saved.sections?.[name]?.version;
        if (typeof version !== "number" || version <= push.version) {
          throw unconfirmed(name, "the reply has no newer section version");
        }
        // Also an empty set must come back explicitly: an absent value may be a partial reply.
        const written = remoteSection(saved, name).value;
        if (written === null) throw unconfirmed(name, "the reply has no section value");
        if (push.channel.accepts?.(written) === false) {
          throw unconfirmed(name, "the reply's section value is malformed");
        }
      }
      meta = saved.sections ?? meta;
      for (const push of pushes) {
        const { channel, local, value } = push;
        const name = channel.name;
        rejected.delete(name);
        const written = remoteSection(saved, name);
        const version = saved.sections ? written.version : push.version + 1;
        // The device may have changed while the PATCH was in flight; its newer edit then stays
        // dirty against `base` and goes out on the next run instead of being overwritten.
        const unchanged = jsonEqual(read(channel) ?? undefined, local);
        if (channel.rebases === true) {
          channel.applyRemote(written.value ?? channel.empty ?? {}, sections[name]?.base ?? null);
        } else if (unchanged && !jsonEqual(toGatewayForm(local), value)) {
          channel.applyRemote(value, sections[name]?.base ?? null);
        }
        sections[name] = {
          version,
          base: unchanged ? (read(channel) ?? value) : value,
          remote: written.value ?? value,
        };
        delete ignored[name];
        outcomes[name] =
          push.kind === "seed" ? "seeded" : push.kind === "merge" ? "merged" : "pushed";
      }
      commit(saved.version);
      return { kind: "synced", outcomes, sections: meta };
    }
    throw conflict;
  }

  /**
   * Call before a change the user did not make (a server-pushed default theme); the returned
   * function, called after the change, records the new device value as not the user's own so it
   * is not pushed. Unsent user edits are left alone: they still go out, with the change in them.
   */
  function beginNonUserChange(name: ProfileSectionName): () => void {
    const channel = ports.channels().find((entry) => entry.name === name);
    if (!channel) return () => {};
    const saved = ports.loadState();
    const section = saved?.sections[name];
    const before = channel.readLocal(section?.base ?? null);
    const mark = saved?.ignored[name];
    const clean =
      before === null ||
      section === undefined ||
      jsonEqual(before, section.base ?? undefined) ||
      (mark !== undefined && jsonEqual(before, mark));
    return () => {
      const after = channel.readLocal(section?.base ?? null);
      if (!clean || after === null) return;
      const current = ports.loadState() ?? emptyProfileSyncState();
      ports.saveState({ ...current, ignored: { ...current.ignored, [name]: after } });
    };
  }

  /**
   * One run at a time. Two runs side by side would both read the same section versions and
   * PATCH them; the second would be refused as stale. A run that starts while another is in
   * flight waits for it and then reads the state it saved, so it sends only what is still dirty.
   */
  let lastRun: Promise<unknown> = Promise.resolve();
  function run(me: OrbitGatewayNode): Promise<ProfileSyncResult> {
    const result = lastRun.then(() => runOnce(me));
    lastRun = result.catch(() => undefined);
    return result;
  }

  return { run, beginNonUserChange };
}
