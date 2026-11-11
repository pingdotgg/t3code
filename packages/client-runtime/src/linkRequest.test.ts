import { EnvironmentId, type ServerConfig, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionProfile } from "./connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./connection/model.ts";
import type { EnvironmentPresentation } from "./connection/presentation.ts";
import type { RelayDiscoveredEnvironment } from "./relay/discovery.ts";
import {
  ANOTHER_ADDRESS,
  linkableMachines,
  linkedEnvironmentNames,
  linkRequestAnswerInput,
  linkRequestDisplay,
  linkRequestFailureMessage,
  linkRequestInitialMachine,
  linkRequestTarget,
  linkRequestTargetName,
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
    // A loopback address would name the linking server itself, so it is no address of the VPS.
    const vps = presentation("environment-vps", "VPS", {
      saved: ["https://vps.example.com", "https://vps.ts.net", "http://127.0.0.1:3773"],
      reported: ["https://vps.ts.net", "http://localhost:3773"],
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

    // A Connect record that publishes only a loopback address gives the machine none.
    const local = discovered("environment-local", "Local");
    const published = {
      ...local,
      environment: {
        ...local.environment,
        endpoint: { ...local.environment.endpoint, httpBaseUrl: "http://127.0.0.1:3773/" },
      },
    };
    expect(
      linkableMachines({
        environments: [],
        threadEnvironmentId: EnvironmentId.make("environment-here"),
        links: [],
        connect: new Map([["environment-local", published]]),
      })[0]?.urls,
    ).toEqual([]);
  });
});

describe("linkedEnvironmentNames", () => {
  it("names the unexpired links as this client does, else as the link does", () => {
    const vps = EnvironmentId.make("environment-vps");
    const mini = EnvironmentId.make("environment-mini");
    const unsaved = EnvironmentId.make("environment-unsaved");
    expect(
      linkedEnvironmentNames({
        links: [
          { environmentId: vps, label: "vps-01", status: "unreachable" },
          { environmentId: mini, label: "mini", status: "expired" },
          { environmentId: unsaved, label: "Office box", status: "reachable" },
        ],
        environments: [
          { environmentId: vps, label: "Hetzner VPS" },
          { environmentId: mini, label: "Mac mini" },
        ],
      }),
    ).toEqual(
      new Map([
        [vps, "Hetzner VPS"],
        [unsaved, "Office box"],
      ]),
    );
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

describe("linkRequestTarget", () => {
  const box = {
    environmentId: EnvironmentId.make("environment-box"),
    label: "Box",
    machine: "server",
    connected: true,
    connectOnly: false,
    linked: false,
    urls: ["http://10.0.0.2:3773", "https://box.t3connect.example/"],
  } as const;

  it("takes a machine from an address the agent gave only where this app already reaches it", () => {
    // Anything can answer at an address as the box, so an id beside one is not trusted.
    const unfamiliar = {
      url: "https://other.example",
      environmentId: box.environmentId,
      label: "Box",
    };
    expect(linkRequestTarget(unfamiliar, [box], null)).toEqual({ kind: "address" });
    expect(linkRequestTarget(unfamiliar, [box], box.environmentId)).toEqual({ kind: "address" });
    expect(linkRequestTargetName(unfamiliar)).toBe("https://other.example");
    // A username in the address must not pass for the host the code goes to.
    expect(linkRequestTargetName({ url: "https://box.t3connect.example@other.example/x" })).toBe(
      "https://other.example",
    );
    // A known address in another spelling is the box, linked at its own addresses only.
    expect(
      linkRequestTarget({ url: "https://BOX.t3connect.example:443/mcp" }, [box], null),
    ).toEqual({
      kind: "machine",
      environmentId: box.environmentId,
      label: "Box",
      urls: box.urls,
      linked: false,
    });
    expect(linkRequestTarget({ url: "http://box.t3connect.example" }, [box], null)).toEqual({
      kind: "address",
    });
    expect(linkRequestTarget({ url: "not a url" }, [box], null)).toEqual({ kind: "address" });
    expect(linkRequestTarget({ url: "blob:https://box.t3connect.example/1" }, [box], null)).toEqual(
      { kind: "address" },
    );
    // A private address two machines share names neither.
    const mini = { ...box, environmentId: EnvironmentId.make("environment-mini") };
    expect(linkRequestTarget({ url: "http://10.0.0.2:3773" }, [box, mini], null)).toEqual({
      kind: "address",
    });
  });

  it("links the machine the agent named or the user picked, at the addresses this app has", () => {
    expect(linkRequestTarget({ environmentId: box.environmentId }, [box], null)).toMatchObject({
      kind: "machine",
      label: "Box",
      urls: box.urls,
    });
    expect(linkRequestTarget({}, [box], box.environmentId)).toMatchObject({ kind: "machine" });
    expect(linkRequestTarget({}, [box], ANOTHER_ADDRESS)).toEqual({ kind: "address" });
    expect(linkRequestTarget({}, [box], null)).toEqual({ kind: "none" });
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
