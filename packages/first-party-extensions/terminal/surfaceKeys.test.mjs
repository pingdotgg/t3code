import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import {
  defaultTerminalEditingCommand,
  isTerminalEditingCommand,
  negotiatedEditingCommands,
  TERMINAL_EDITING_INPUT,
  terminalEditingCommandForKey,
  terminalEditingCommands,
} from "./surfaceKeys.ts";
import { registerPanelCommands, TERMINAL_FOCUS_WHEN } from "./viewModel.ts";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

const keydown = (key, modifiers = {}) => ({
  type: "keydown",
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

/** A descriptor `defaultKey` spelling ("meta+arrowleft") as the keydown it names. */
function chordEvent(spelling) {
  const tokens = spelling.split("+");
  const key = tokens.pop();
  const modifiers = Object.fromEntries(tokens.map((token) => [`${token}Key`, true]));
  return keydown(key === "backspace" ? "Backspace" : key.replace(/^arrow/, "Arrow"), modifiers);
}

const defaultsOf = (platform) =>
  Object.fromEntries(
    terminalEditingCommands(platform).map((command) => [
      command.id,
      command.defaultKey === undefined ? [] : [command.defaultKey].flat(),
    ]),
  );

NodeTest.describe("terminal editing commands — descriptors", () => {
  NodeTest.it("registers every editing intercept as a focused surface command", () => {
    for (const platform of [MAC, LINUX]) {
      const commands = terminalEditingCommands(platform);
      NodeAssert.deepEqual(
        commands.map((command) => command.id),
        ["clear", "wordBackward", "wordForward", "lineStart", "lineEnd", "deleteToLineStart"],
      );
      for (const command of commands) {
        NodeAssert.equal(command.scope, "surface");
        NodeAssert.equal(command.when, TERMINAL_FOCUS_WHEN);
        NodeAssert.ok(command.title.length > 0);
        NodeAssert.ok(isTerminalEditingCommand(command.id));
      }
    }
    NodeAssert.equal(isTerminalEditingCommand("toggle"), false);
    NodeAssert.equal(isTerminalEditingCommand("toString"), false);
  });

  NodeTest.it("mirrors the native drawer's defaults per platform", () => {
    NodeAssert.deepEqual(defaultsOf(MAC), {
      clear: ["ctrl+l", "meta+k"],
      wordBackward: ["alt+arrowleft"],
      wordForward: ["alt+arrowright"],
      lineStart: ["meta+arrowleft"],
      lineEnd: ["meta+arrowright"],
      deleteToLineStart: ["meta+backspace"],
    });
    // Native binds no line or delete intercept off macOS; the commands still
    // register (rebindable) with no default.
    NodeAssert.deepEqual(defaultsOf(LINUX), {
      clear: ["ctrl+l"],
      wordBackward: ["ctrl+arrowleft", "alt+arrowleft"],
      wordForward: ["ctrl+arrowright", "alt+arrowright"],
      lineStart: [],
      lineEnd: [],
      deleteToLineStart: [],
    });
  });

  NodeTest.it("declares defaults the host's shortcut parser accepts", () => {
    for (const platform of [MAC, LINUX]) {
      for (const keys of Object.values(defaultsOf(platform))) {
        for (const key of keys) NodeAssert.notEqual(parseKeybindingShortcut(key), null, key);
      }
    }
  });

  NodeTest.it("each declared default is exactly a chord the local fallback applies", () => {
    for (const platform of [MAC, LINUX]) {
      for (const [id, keys] of Object.entries(defaultsOf(platform))) {
        for (const key of keys) {
          NodeAssert.equal(defaultTerminalEditingCommand(chordEvent(key), platform), id, key);
        }
      }
    }
  });

  NodeTest.it("writes the same readline bytes the native intercepts send", () => {
    NodeAssert.deepEqual(TERMINAL_EDITING_INPUT, {
      clear: "\u000c",
      wordBackward: "\u001bb",
      wordForward: "\u001bf",
      lineStart: "\u0001",
      lineEnd: "\u0005",
      deleteToLineStart: "\u0015",
    });
  });
});

NodeTest.describe("terminal editing commands — native default matching", () => {
  NodeTest.it("matches only exact modifier sets, like the native intercepts", () => {
    const cases = [
      [MAC, keydown("l", { ctrlKey: true }), "clear"],
      [MAC, keydown("k", { metaKey: true }), "clear"],
      [MAC, keydown("K", { metaKey: true }), "clear"],
      [MAC, keydown("k", { metaKey: true, shiftKey: true }), null],
      [LINUX, keydown("k", { ctrlKey: true }), null],
      [LINUX, keydown("k", { metaKey: true }), null],
      [LINUX, keydown("l", { ctrlKey: true }), "clear"],
      [MAC, keydown("ArrowLeft", { altKey: true }), "wordBackward"],
      [MAC, keydown("ArrowLeft", { altKey: true, shiftKey: true }), null],
      [MAC, keydown("ArrowLeft", { ctrlKey: true }), null],
      [MAC, keydown("ArrowRight", { metaKey: true }), "lineEnd"],
      [LINUX, keydown("ArrowRight", { metaKey: true }), null],
      [LINUX, keydown("ArrowLeft", { ctrlKey: true }), "wordBackward"],
      [LINUX, keydown("ArrowRight", { altKey: true }), "wordForward"],
      [MAC, keydown("Backspace", { metaKey: true }), "deleteToLineStart"],
      [MAC, keydown("Backspace", { altKey: true }), null],
      [LINUX, keydown("Backspace", { ctrlKey: true }), null],
      [MAC, keydown("a"), null],
      [MAC, { ...keydown("l", { ctrlKey: true }), type: "keyup" }, null],
    ];
    for (const [platform, event, expected] of cases) {
      NodeAssert.equal(
        defaultTerminalEditingCommand(event, platform),
        expected,
        `${platform} ${JSON.stringify(event)}`,
      );
    }
  });
});

NodeTest.describe("terminal editing commands — local fallback precedence", () => {
  const resolver = (answer) => {
    const chords = [];
    return {
      chords,
      resolveTerminalFocusKey(chord) {
        chords.push(chord);
        return answer;
      },
    };
  };
  const own = (binding = "pending") => ({ pluginId: "t3.terminal", binding });
  const ctrlL = () => keydown("l", { ctrlKey: true });

  NodeTest.it("applies the default when no user or native rule claims the chord", () => {
    const keybindings = resolver(null);
    const event = ctrlL();
    NodeAssert.equal(terminalEditingCommandForKey(event, keybindings, own(), MAC), "clear");
    NodeAssert.deepEqual(keybindings.chords, [event]);
  });

  NodeTest.it("applies the editing command a user rule binds, on any chord", () => {
    // Ctrl+U is no default, but a user rule names clear: the fallback runs
    // clear instead of letting Ghostty send its own 0x15.
    const event = keydown("u", { ctrlKey: true });
    NodeAssert.equal(
      terminalEditingCommandForKey(event, resolver("ext.t3.terminal.clear"), own(), MAC),
      "clear",
    );
    NodeAssert.equal(
      terminalEditingCommandForKey(ctrlL(), resolver("ext.t3.terminal.wordBackward"), own(), MAC),
      "wordBackward",
    );
  });

  NodeTest.it("yields a chord claimed by anything else to the encoder", () => {
    for (const claim of [
      "sidebar.toggle",
      "ext.acme.tools.run",
      "ext.t3.terminal.toggle",
      "ext.t3.terminal.toString",
      "ext.t3.terminalx.clear",
    ]) {
      NodeAssert.equal(
        terminalEditingCommandForKey(ctrlL(), resolver(claim), own(), MAC),
        null,
        claim,
      );
    }
  });

  NodeTest.it(
    "holds default chords while the binding is pending on a host without the resolver",
    () => {
      const altLeft = keydown("ArrowLeft", { altKey: true });
      NodeAssert.equal(
        terminalEditingCommandForKey(altLeft, undefined, own("pending"), MAC),
        "hold",
      );
      NodeAssert.equal(
        terminalEditingCommandForKey(altLeft, undefined, own("unavailable"), MAC),
        "wordBackward",
      );
      NodeAssert.equal(
        terminalEditingCommandForKey(altLeft, undefined, own("bound"), MAC),
        "wordBackward",
      );
      NodeAssert.equal(
        terminalEditingCommandForKey(keydown("a"), undefined, own("pending"), MAC),
        null,
      );
    },
  );

  NodeTest.it("ignores keyups", () => {
    const keybindings = resolver("ext.t3.terminal.clear");
    NodeAssert.equal(
      terminalEditingCommandForKey({ ...ctrlL(), type: "keyup" }, keybindings, own(), MAC),
      null,
    );
    NodeAssert.deepEqual(keybindings.chords, []);
  });
});

NodeTest.describe("terminal editing commands — registration", () => {
  const viewContext = { resource: { environmentId: "env-1", threadId: "thread-1" } };

  NodeTest.it("registers the editing set and routes only its registered commands", async () => {
    const commands = terminalEditingCommands(MAC);
    const calls = [];
    const client = {
      invokeApi(request) {
        calls.push(request);
        if (request.method === "registerCommands")
          return Promise.resolve({
            commandSetToken: "cmdset-edit",
            results: commands.map((command) => ({
              commandId: command.id,
              status: command.id === "lineEnd" ? "rejected" : "registered",
            })),
          });
        return Promise.resolve({ unregistered: true });
      },
    };
    let bound = null;
    const dispatched = [];
    const registration = await registerPanelCommands({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      commands,
      versionRange: "^1.2.0",
      bindCommands: (token, handler) => {
        bound = { token, handler };
        return "binding-1";
      },
      onCommand: (commandId) => dispatched.push(commandId),
    });
    NodeAssert.equal(registration.commandSetToken, "cmdset-edit");
    NodeAssert.deepEqual(calls[0].input, { commands });
    NodeAssert.equal(bound.token, "cmdset-edit");
    bound.handler({ commandId: "clear", context: viewContext });
    bound.handler({ commandId: "lineEnd", context: viewContext });
    NodeAssert.deepEqual(dispatched, ["clear"]);
  });
});

NodeTest.describe("terminal editing commands — host version negotiation", () => {
  const viewContext = { resource: { environmentId: "env-1", threadId: "thread-1" } };
  const discovery = (version, selected = true) => ({
    id: "t3.ui/keybindings",
    version,
    providerId: "host",
    generation: 1,
    health: "ready",
    selected,
  });
  /** `clientVersion` is the renderer's ClientHost advertisement; `discovered`, the server's. */
  const hostWith = (clientVersion, discovered) => ({
    ...(clientVersion === undefined ? {} : { keybindings: { version: clientVersion } }),
    discoverApis: async () => {
      if (discovered instanceof Error) throw discovered;
      return discovered;
    },
  });
  const negotiated = (clientVersion, discovered, platform) =>
    negotiatedEditingCommands(
      hostWith(clientVersion, discovered),
      viewContext,
      new AbortController().signal,
      platform,
    );
  const negotiate = async (clientVersion, discovered, platform) =>
    (await negotiated(clientVersion, discovered, platform)).commands;

  let descriptorKeys;
  NodeTest.before(async () => {
    const { uiKeybindingsApi } = await import("@t3tools/extension-sdk/catalogue");
    const items = uiKeybindingsApi.definition.methods.find(
      (method) => method.name === "registerCommands",
    ).inputSchema.properties.commands.items;
    NodeAssert.equal(items.additionalProperties, false);
    descriptorKeys = new Set(Object.keys(items.properties));
  });
  // A 1.0.0/1.1.0 host's closed descriptor schema: today's keys minus the 1.2.0 field.
  const fitsClosedSchema = (commands, keys) =>
    commands.every((command) => Object.keys(command).every((key) => keys.has(key)));
  const oldKeys = () => new Set([...descriptorKeys].filter((k) => k !== "defaultKeyLogicalOnly"));

  const cases = [
    // [renderer, server-selected, defaults sent]
    [undefined, [discovery("1.2.0")], false],
    ["1.0.0", [discovery("1.2.0")], false],
    ["1.1.0", [discovery("1.2.0")], false],
    ["1.1.0", [discovery("1.1.0")], false],
    ["1.2.0", [discovery("1.1.0")], false],
    ["1.2.0", [discovery("1.0.0")], false],
    ["1.2.0", [], false],
    ["1.2.0", [discovery("1.2.0", false)], false],
    ["1.2.0", new Error("discovery unavailable"), false],
    ["1.2.0", [discovery("1.2.0")], true],
    ["1.3.0", [discovery("1.2.1")], true],
  ];
  for (const [client, server, logical] of cases) {
    const serverLabel = server instanceof Error ? "failed" : server.map((d) => d.version);
    NodeTest.it(
      `renderer ${client ?? "absent"} / server ${serverLabel} → defaults ${logical}`,
      async () => {
        for (const platform of [MAC, LINUX]) {
          const commands = await negotiate(client, server, platform);
          NodeAssert.deepEqual(
            commands.map((command) => command.id),
            terminalEditingCommands(platform).map((command) => command.id),
          );
          if (logical) {
            NodeAssert.deepEqual(commands, terminalEditingCommands(platform));
            NodeAssert.ok(commands.some((command) => command.defaultKeyLogicalOnly === true));
          } else {
            for (const command of commands) {
              NodeAssert.equal("defaultKey" in command, false, command.id);
              NodeAssert.equal("defaultKeyLogicalOnly" in command, false, command.id);
            }
          }
        }
      },
    );
  }

  NodeTest.it(
    "an older host's closed schema accepts the old payload and rejects the new",
    async () => {
      const old = await negotiate("1.1.0", [discovery("1.1.0")], MAC);
      const current = await negotiate("1.2.0", [discovery("1.2.0")], MAC);
      NodeAssert.equal(fitsClosedSchema(old, oldKeys()), true);
      NodeAssert.equal(fitsClosedSchema(current, oldKeys()), false);
      NodeAssert.equal(fitsClosedSchema(current, descriptorKeys), true);
    },
  );

  NodeTest.it(
    "an older host keeps non-Latin chords logical through the local fallback",
    async () => {
      // No defaults registered, so the old host never claims physical KeyK;
      // the fallback matches the layout key whether or not the renderer resolves.
      const noClaim = { resolveTerminalFocusKey: () => null };
      for (const keybindings of [undefined, noClaim]) {
        const binding = { pluginId: "t3.terminal", binding: "bound" };
        NodeAssert.equal(
          terminalEditingCommandForKey(keydown("k", { metaKey: true }), keybindings, binding, MAC),
          "clear",
        );
        NodeAssert.equal(
          terminalEditingCommandForKey(keydown("л", { metaKey: true }), keybindings, binding, MAC),
          null,
        );
      }
    },
  );

  const registerNegotiated = async (clientVersion, discovered) => {
    const ranges = [];
    const client = {
      invokeApi(request) {
        ranges.push([request.method, request.versionRange]);
        return Promise.resolve(
          request.method === "registerCommands"
            ? { commandSetToken: "cmdset", results: [] }
            : { unregistered: true },
        );
      },
    };
    const registration = await registerPanelCommands({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      ...(await negotiated(clientVersion, discovered, MAC)),
      bindCommands: () => "binding",
      onCommand: () => {},
    });
    registration.release();
    return ranges;
  };

  NodeTest.it("registers an older host's payload on the manifest's ^1.0.0 range", async () => {
    NodeAssert.deepEqual(await registerNegotiated("1.1.0", [discovery("1.1.0")]), [
      ["registerCommands", "^1.0.0"],
      ["unregisterCommands", "^1.0.0"],
    ]);
  });

  NodeTest.it("registers logical defaults on the probed ^1.2.0 range", async () => {
    NodeAssert.deepEqual(await registerNegotiated("1.2.0", [discovery("1.2.0")]), [
      ["registerCommands", "^1.2.0"],
      ["unregisterCommands", "^1.2.0"],
    ]);
  });

  NodeTest.it("the SDK refuses logical defaults on an unprobed ^1.0.0 binding", async () => {
    const { ApiVersionError } = await import("@t3tools/extension-sdk/capabilities");
    await NodeAssert.rejects(
      registerPanelCommands({
        client: { invokeApi: () => Promise.reject(new Error("must not reach the host")) },
        context: viewContext,
        signal: new AbortController().signal,
        commands: await negotiate("1.2.0", [discovery("1.2.0")], MAC),
        bindCommands: () => "binding",
        onCommand: () => {},
      }),
      ApiVersionError,
    );
  });
});

// Built manifests are build output; a pack absent from this checkout (or not built) is skipped.
for (const [pack, range] of [
  ["terminal", "^1.0.0"],
  ["browser", "^1.1.0"],
  ["diff", "^1.1.0"],
]) {
  const manifestUrl = new URL(`../${pack}/.t3-extension/t3-extension.json`, import.meta.url);
  NodeTest.it(
    `the 1.2.0 bump leaves the ${pack} pack's keybindings floor at ${range}`,
    { skip: NodeFS.existsSync(manifestUrl) ? false : `${pack} is not built in this checkout` },
    async () => {
      const manifest = JSON.parse(NodeFS.readFileSync(manifestUrl, "utf8"));
      const floor = manifest.requires.find(
        (requirement) => requirement.id === "t3.ui/keybindings",
      )?.versionRange;
      NodeAssert.equal(floor, range);
    },
  );
}
