import { EnvironmentId, type ServerConfig, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionProfile } from "./connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./connection/model.ts";
import type { EnvironmentPresentation } from "./connection/presentation.ts";
import type { RelayDiscoveredEnvironment } from "./relay/discovery.ts";
import {
  linkableMachines,
  linkRequestAnswerInput,
  linkRequestDisplay,
  linkRequestFailureMessage,
  linkRequestInitialMachine,
  rankMachinesByHint,
} from "./linkRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:link-request:1"),
  threadId: ThreadId.make("thread-1"),
};
const asked = { url: "https://box.example.ts.net", label: "Box" };
const accessLabel = (access: string) => `<${access}>`;

describe("linkRequestDisplay", () => {
  it("names the environment linked and the access the user chose", () => {
    expect(
      linkRequestDisplay(
        { ...asked, linkStatus: "linked", linkedLabel: "Box", linkedAccess: "auto" },
        "local",
        accessLabel,
      ),
    ).toEqual({ kind: "answered", outcome: "linked", label: "Linked Box · <auto>" });
  });

  it("shows why a link failed, and never offers the actions outside the asking thread", () => {
    expect(
      linkRequestDisplay(
        { ...asked, linkStatus: "failed", failure: "Pairing code expired." },
        "local",
        accessLabel,
      ),
    ).toMatchObject({ outcome: "failed", label: "Could not link: Pairing code expired." });
    expect(
      linkRequestDisplay({ ...asked, linkStatus: "pending" }, "inherited", accessLabel),
    ).toMatchObject({ kind: "pending-elsewhere" });
  });
});

describe("linkRequestAnswerInput", () => {
  const vps = {
    environmentId: EnvironmentId.make("environment-vps"),
    label: "VPS",
    urls: ["https://vps.ts.net", "http://10.0.0.2:3773"],
  };

  it("answers with the machine picked and every address known for it", () => {
    expect(
      linkRequestAnswerInput(item, {
        type: "link",
        target: vps,
        access: "auto",
        pairingCode: "  abc  ",
      }),
    ).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "link", ...vps, access: "auto", pairingCode: "abc" },
    });
    expect(
      linkRequestAnswerInput(item, {
        type: "link",
        target: { url: " https://box.ts.net " },
        access: "auto",
        pairingCode: "abc",
      }),
    ).toMatchObject({ answer: { urls: ["https://box.ts.net"] } });
  });

  it("refuses a blank code, a blank address, or a machine with no address", () => {
    const blank = (target: Parameters<typeof linkRequestAnswerInput>[1] & { type: "link" }) =>
      linkRequestAnswerInput(item, target);
    expect(blank({ type: "link", target: vps, access: "auto", pairingCode: "  " })).toBeNull();
    expect(
      blank({ type: "link", target: { url: " " }, access: "auto", pairingCode: "abc" }),
    ).toBeNull();
    expect(
      blank({ type: "link", target: { ...vps, urls: [] }, access: "auto", pairingCode: "abc" }),
    ).toBeNull();
  });
});

const presentation = (
  id: string,
  label: string,
  options: {
    readonly saved?: ReadonlyArray<string>;
    readonly reported?: ReadonlyArray<string>;
    readonly connected?: boolean;
  } = {},
): EnvironmentPresentation & { readonly environmentId: EnvironmentId } => {
  const environmentId = EnvironmentId.make(id);
  const [first, ...rest] = (options.saved ?? []).map((httpBaseUrl, index) => {
    const connectionId = `${id}-${index}`;
    return {
      target: new BearerConnectionTarget({ environmentId, label, connectionId }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId,
          label,
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl,
        }),
      ),
    };
  });
  return {
    environmentId,
    entry: {
      ...(first ?? {
        target: new RelayConnectionTarget({ environmentId, label }),
        profile: Option.none(),
      }),
      ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
      enabled: true,
    },
    connection: {
      phase: options.connected === false ? "offline" : "connected",
      error: null,
      traceId: null,
    },
    serverConfig:
      options.reported === undefined
        ? null
        : ({
            environment: { platform: { machine: "laptop" } },
            directEndpoints: options.reported.map((httpBaseUrl) => ({
              kind: "tailnet",
              httpBaseUrl,
            })),
          } as unknown as ServerConfig),
  };
};

const discovered = (
  id: string,
  label: string,
  machine?: "mac-mini",
): RelayDiscoveredEnvironment => ({
  environment: {
    environmentId: EnvironmentId.make(id),
    label,
    endpoint: {
      httpBaseUrl: `https://${id}.t3.example`,
      wsBaseUrl: `wss://${id}.t3.example`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-10-01T00:00:00.000Z",
  },
  availability: "online",
  status:
    machine === undefined
      ? Option.none()
      : Option.some({
          environmentId: EnvironmentId.make(id),
          endpoint: {
            httpBaseUrl: `https://${id}.t3.example`,
            wsBaseUrl: `wss://${id}.t3.example`,
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-10-01T00:00:00.000Z",
          descriptor: {
            environmentId: EnvironmentId.make(id),
            label,
            platform: { os: "darwin", arch: "arm64", machine },
            serverVersion: "1.0.0",
            capabilities: {},
          },
        } as unknown as RelayEnvironmentStatusResponse),
  error: Option.none(),
});

describe("linkableMachines", () => {
  it("lists the other machines with reported addresses before saved ones, once each", () => {
    const here = presentation("environment-here", "Here", { saved: ["http://localhost:3773"] });
    const vps = presentation("environment-vps", "VPS", {
      saved: ["https://vps.example.com", "https://vps.ts.net"],
      reported: ["https://vps.ts.net"],
    });
    const mini = presentation("environment-mini", "Mini", { connected: false });
    expect(
      linkableMachines({
        environments: [here, vps, mini],
        threadEnvironmentId: here.environmentId,
        links: [{ environmentId: mini.environmentId, status: "unreachable" }],
        connect: new Map(),
      }),
    ).toEqual([
      {
        environmentId: vps.environmentId,
        label: "VPS",
        machine: "laptop",
        connected: true,
        connectOnly: false,
        linked: false,
        urls: ["https://vps.ts.net", "https://vps.example.com"],
      },
      {
        environmentId: mini.environmentId,
        label: "Mini",
        machine: "server",
        connected: false,
        connectOnly: false,
        linked: true,
        urls: [],
      },
    ]);
  });

  it("reaches a machine saved only over T3 Connect at its Connect address", () => {
    const here = presentation("environment-here", "Here", { saved: ["http://localhost:3773"] });
    const box = presentation("environment-box", "Box");
    const [listed] = linkableMachines({
      environments: [here, box],
      threadEnvironmentId: here.environmentId,
      links: [],
      connect: new Map([[box.environmentId, discovered(box.environmentId, "Box")]]),
    });
    expect(listed?.urls).toEqual(["https://environment-box.t3.example"]);
    // Until discovery has found it, there is no address to offer.
    expect(
      linkableMachines({
        environments: [here, box],
        threadEnvironmentId: here.environmentId,
        links: [],
        connect: new Map(),
      })[0]?.urls,
    ).toEqual([]);
  });

  it("also offers the Connect address of a machine saved by direct address, last", () => {
    const here = presentation("environment-here", "Here", { saved: ["http://localhost:3773"] });
    const vps = presentation("environment-vps", "VPS", {
      saved: ["http://192.168.1.20:3773"],
      reported: ["https://vps.ts.net"],
    });
    const [listed] = linkableMachines({
      environments: [here, vps],
      threadEnvironmentId: here.environmentId,
      links: [],
      connect: new Map([[vps.environmentId, discovered(vps.environmentId, "VPS")]]),
    });
    expect(listed?.urls).toEqual([
      "https://vps.ts.net",
      "http://192.168.1.20:3773",
      "https://environment-vps.t3.example",
    ]);
  });

  it("no longer counts a machine as linked once its link expired", () => {
    const here = presentation("environment-here", "Here", { saved: ["http://localhost:3773"] });
    const vps = presentation("environment-vps", "VPS", { saved: ["https://vps.ts.net"] });
    const mini = presentation("environment-mini", "Mini", { saved: ["http://mini.local:3773"] });
    const listed = linkableMachines({
      environments: [here, vps, mini],
      threadEnvironmentId: here.environmentId,
      links: [
        { environmentId: vps.environmentId, status: "expired" },
        { environmentId: mini.environmentId, status: "unreachable" },
        { environmentId: EnvironmentId.make("environment-old"), status: "expired" },
      ],
      connect: new Map([["environment-old", discovered("environment-old", "Old box")]]),
    });
    expect(listed.map((machine) => [machine.label, machine.linked])).toEqual([
      ["VPS", false],
      ["Mini", true],
      ["Old box", false],
    ]);
  });

  it("offers machines only on T3 Connect after the saved ones, at their Connect address", () => {
    const here = presentation("environment-here", "Here", { saved: ["http://localhost:3773"] });
    const vps = presentation("environment-vps", "VPS", { saved: ["https://vps.ts.net"] });
    const listed = linkableMachines({
      environments: [here, vps],
      threadEnvironmentId: here.environmentId,
      links: [{ environmentId: EnvironmentId.make("environment-old"), status: "reachable" }],
      connect: new Map([
        // This environment and saved machines are listed once, as saved.
        [here.environmentId, discovered(here.environmentId, "Here")],
        [vps.environmentId, discovered(vps.environmentId, "VPS")],
        ["environment-mini", discovered("environment-mini", "Mac mini", "mac-mini")],
        ["environment-old", discovered("environment-old", "Old box")],
      ]),
    });
    expect(listed.map((machine) => [machine.label, machine.connectOnly])).toEqual([
      ["VPS", false],
      ["Mac mini", true],
      ["Old box", true],
    ]);
    expect(listed[1]).toEqual({
      environmentId: EnvironmentId.make("environment-mini"),
      label: "Mac mini",
      machine: "mac-mini",
      connected: false,
      connectOnly: true,
      linked: false,
      urls: ["https://environment-mini.t3.example"],
    });
    expect(listed[2]).toMatchObject({ machine: "server", linked: true });
  });
});

describe("rankMachinesByHint", () => {
  const machines = [
    { label: "Old vps box" },
    { label: "VPS-2" },
    { label: "Mac mini" },
    { label: "vps" },
  ];

  it("puts an exact name first, then a prefix, then a substring, keeping order within each", () => {
    expect(rankMachinesByHint(machines, " VPS ").map((machine) => machine.label)).toEqual([
      "vps",
      "VPS-2",
      "Old vps box",
      "Mac mini",
    ]);
    expect(rankMachinesByHint(machines, undefined)).toBe(machines);
  });

  it("preselects the card's machine, or the hint's match, and nothing for a hint that matches none", () => {
    const listed = [
      { environmentId: EnvironmentId.make("environment-mini"), label: "Mac mini" },
      { environmentId: EnvironmentId.make("environment-vps"), label: "Hetzner VPS" },
    ].map(
      (machine) =>
        ({
          ...machine,
          machine: "server",
          connected: true,
          connectOnly: false,
          linked: false,
          urls: [],
        }) as const,
    );
    expect(linkRequestInitialMachine({ hint: "vps" }, listed)).toBe("environment-vps");
    // Agents pass the user's words, which name the machine among others.
    expect(linkRequestInitialMachine({ hint: "my mac mini" }, listed)).toBe("environment-mini");
    expect(linkRequestInitialMachine({ hint: "my mac" }, listed)).toBe("environment-mini");
    expect(linkRequestInitialMachine({ hint: "the hetzner vps box" }, listed)).toBe(
      "environment-vps",
    );
    expect(linkRequestInitialMachine({ hint: "desk" }, listed)).toBeNull();
    expect(linkRequestInitialMachine({ hint: "minimal" }, listed)).toBeNull();
    expect(
      linkRequestInitialMachine(
        { environmentId: EnvironmentId.make("environment-x"), hint: "vps" },
        listed,
      ),
    ).toBe("environment-x");
  });
});

describe("linkRequestFailureMessage", () => {
  it("passes through only known user-facing errors", () => {
    expect(
      linkRequestFailureMessage({ _tag: "PeerLinkRequestError", message: "Already answered." }),
    ).toBe("Already answered.");
    expect(linkRequestFailureMessage({ _tag: "SchemaError", message: "code=abc" })).toBe(
      "Could not answer the request. Try again.",
    );
  });
});
