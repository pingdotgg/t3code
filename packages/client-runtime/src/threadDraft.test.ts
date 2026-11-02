import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./state/shell.ts";
import {
  threadDraftCardModel,
  threadDraftInitialMachine,
  threadDraftMachineName,
  threadDraftProjectMatch,
} from "./threadDraft.ts";

const machine = (id: string, label: string, displayUrl: string | null) => ({
  environmentId: EnvironmentId.make(id),
  label,
  displayUrl,
});

describe("threadDraftMachineName", () => {
  const laptop = machine("env-laptop", "laptop", "http://localhost:3773");
  const devServer = machine("env-dev", "dev", "http://localhost:3774");
  const sshA = machine("env-ssh-a", "vps", "theo@vps");
  const sshB = machine("env-ssh-b", "vps-2", "theo@vps");
  const relayA = machine("3f2a9c1e-aaaa", "VPS", null);
  const relayB = machine("71bd02e4-bbbb", "V​PS", null);

  it.each([
    [
      "keeps the port, so two local servers differ",
      laptop,
      [laptop, devServer],
      "laptop · localhost:3773",
    ],
    ["names an SSH machine by user and host", sshA, [sshA], "vps · theo@vps"],
    [
      "adds the id when another known machine shares the host",
      sshA,
      [sshA, sshB],
      "vps · theo@vps · env-ssh-a",
    ],
    [
      "shows a short id for a T3 Connect machine",
      relayA,
      [relayA, relayB],
      "VPS · T3 Connect 3f2a9c1e",
    ],
    [
      "drops direction controls that would make a name read as another",
      machine("env-rtl", "one.\u202Etset", "http://box.\u202Elan:3773"),
      [],
      "one.tset · box.lan:3773",
    ],
    [
      "treats an empty address as T3 Connect",
      machine("5c1d0e9a-dddd", "relay", ""),
      [],
      "relay · T3 Connect 5c1d0e9a",
    ],
  ])("%s", (_label, target, known, expected) => {
    expect(threadDraftMachineName(target, known)).toBe(expected);
  });
});

describe("threadDraftInitialMachine", () => {
  const vps = machine("env-vps", "vps", null);
  const device = machine("env-device", "device", null);
  const own = machine("env-own", "laptop", null);
  const twin = machine("env-twin", "VPS", null);
  const all = new Set([vps.environmentId, device.environmentId, own.environmentId]);

  it.each<
    [
      string,
      { environmentId?: EnvironmentId; hint?: string },
      ReadonlyArray<typeof vps>,
      ReadonlySet<EnvironmentId>,
      EnvironmentId | null,
    ]
  >([
    [
      "chooses a named machine this app may use",
      { environmentId: vps.environmentId },
      [vps],
      all,
      vps.environmentId,
    ],
    [
      "never falls back to the hint for a named machine it may not use",
      { environmentId: EnvironmentId.make("env-gone"), hint: "vps" },
      [vps],
      all,
      null,
    ],
    [
      "matches a label exactly, ignoring case",
      { hint: " VPS " },
      [vps, device],
      all,
      vps.environmentId,
    ],
    ["does not match a label that only contains the hint", { hint: "dev" }, [device], all, null],
    [
      "leaves two machines with the same label to the user",
      { hint: "vps" },
      [vps, twin],
      new Set([...all, twin.environmentId]),
      null,
    ],
    [
      "does not choose an exact match this app may not use",
      { hint: "vps" },
      [vps],
      new Set(),
      null,
    ],
    ["allows this thread's own machine", { hint: "laptop" }, [own], all, own.environmentId],
    ["treats an empty hint as no hint", { hint: "  " }, [vps], all, null],
  ])("%s", (_label, item, known, eligible, expected) => {
    expect(threadDraftInitialMachine(item, known, eligible)).toBe(expected);
  });
});

describe("threadDraftProjectMatch", () => {
  const project = (
    id: string,
    environmentId: string,
    repo: string | null,
    extra: Partial<EnvironmentProject> = {},
  ) =>
    ({
      id,
      environmentId: EnvironmentId.make(environmentId),
      workspaceRoot: `/code/${id}`,
      repositoryIdentity:
        repo === null
          ? null
          : { canonicalKey: repo, locator: { kind: "remote", url: repo }, rootPath: `/code/${id}` },
      archivedAt: null,
      ...extra,
    }) as unknown as EnvironmentProject;
  const source = project("app-a", "env-a", "github.com/acme/app");
  const target = EnvironmentId.make("env-b");

  it("opens the same repository on the chosen machine, skipping archived checkouts", () => {
    const archived = project("app-old", "env-b", "github.com/acme/app", {
      archivedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    const live = project("app-b", "env-b", "github.com/acme/app");
    const other = project("app-c", "env-c", "github.com/acme/app");
    expect(threadDraftProjectMatch(source, [other, archived, live], target)).toBe(live);
  });

  it("opens scratch when the source is scratch or the machine lacks the repository", () => {
    const scratch = project("scratch", "env-a", null, { isScratch: true });
    const elsewhere = project("docs-b", "env-b", "github.com/acme/docs");
    expect(threadDraftProjectMatch(scratch, [elsewhere], target)).toBeNull();
    expect(threadDraftProjectMatch(source, [elsewhere], target)).toBeNull();
  });
});

describe("threadDraftCardModel", () => {
  const vps = machine("env-vps", "vps", "theo@vps");
  const known = [vps];
  const none = new Set<EnvironmentId>();
  const only = new Set([vps.environmentId]);
  const card = (
    item: { environmentId?: EnvironmentId; hint?: string },
    connected: ReadonlySet<EnvironmentId>,
    eligible: ReadonlySet<EnvironmentId>,
  ) =>
    threadDraftCardModel(
      { prompt: "Run it.", hiddenCharacters: 0, ...item },
      known,
      connected,
      eligible,
    );

  it.each<
    [
      string,
      { environmentId?: EnvironmentId; hint?: string },
      ReadonlySet<EnvironmentId>,
      ReadonlySet<EnvironmentId>,
      string | null,
    ]
  >([
    [
      "says nothing when the machine can be chosen",
      { environmentId: vps.environmentId },
      only,
      only,
      null,
    ],
    [
      "asks to add a machine this app does not know",
      { environmentId: EnvironmentId.make("env-gone"), hint: "box" },
      only,
      only,
      'This app does not know "box". Add it to open the draft there.',
    ],
    [
      "asks to connect an offline machine",
      { hint: "VPS" },
      none,
      none,
      "Connect vps · theo@vps to open it there.",
    ],
    [
      "names a machine this app may not start threads on",
      { environmentId: vps.environmentId },
      only,
      none,
      "vps · theo@vps can't start threads from this app.",
    ],
  ])("%s", (_label, item, connected, eligible, reason) => {
    expect(card(item, connected, eligible).reason).toBe(reason);
  });
});
