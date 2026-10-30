// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AGENT_DEVICE_SHELL,
  agentDeviceSessionError,
  agentDeviceSessions,
  describeSessions,
  deviceFailure,
  type LauncherTarget,
  launcherHelp,
  makeDeviceTools,
  type ShellCall,
} from "./devices.ts";
import {
  buildBase,
  buildMessages,
  cannedOutput,
  makeSample,
  McpToolUseCase,
  shellRequest,
  t3SubagentContext,
  t3SystemAppend,
  withDevices,
} from "./run.ts";
import { DeviceOperationError, LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";

const MAC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IPHONE = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const world = {
  devices: [
    {
      hostId: MAC,
      id: IPHONE,
      name: "Acme iPhone",
      platform: "ios",
      version: "iOS 26.0",
      booted: true,
      physical: false,
    },
  ],
  deviceHosts: { [MAC]: "build-mac" },
};
const screenshotFailure = {
  _tag: "DeviceOperationError",
  operation: "screenshot",
  reason: "request_failed",
  cause: null,
};
const decodeCase = Schema.decodeUnknownSync(McpToolUseCase);
const deviceCase = (setup: object) =>
  decodeCase({
    id: "device-case",
    area: "device-manager",
    kind: "guard",
    pattern: "device",
    experience: "A device case.",
    setup: { role: "top", world, ...setup },
    prompt: "Show a fresh screenshot of the iPhone on build-mac.",
    expect: {},
  });
const capture = JSON.parse(
  NodeZlib.gunzipSync(
    NodeFS.readFileSync(new URL("./templates/claude.json.gz", import.meta.url)),
  ).toString(),
).request.provider_native;
const model = "claude-opus-5-5";
const base = buildBase(capture, { model, keepUserInstructions: false });
const json = (text: string) => JSON.parse(text);

it.effect("answers device calls with T3's handlers over the case's world", () =>
  Effect.gen(function* () {
    const { devices, deviceHosts } = deviceCase({}).setup.world ?? {};
    const tools = yield* makeDeviceTools({ devices: devices ?? [], deviceHosts }, base.environment);
    const listed = json((yield* tools.call("device_list", {})).text);
    assert.deepEqual(listed.devices, world.devices);
    assert.deepEqual(
      listed.hosts.map((host: { label: string }) => host.label),
      ["This machine", "build-mac"],
    );
    const opened = json((yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE })).text);
    const { command } = opened.agentDevice;
    assert.match(command, /^\/home\/user\/\.t3\/userdata\/device\/.+\/agent-device$/);
    assert.include(opened.quickStart, command);
    assert.deepEqual(tools.launchers, [command]);
    // The image never reaches the model; T3's text result has the rest.
    assert.deepEqual(json((yield* tools.call("device_screenshot", {})).text).screenshot, {
      mimeType: "image/png",
      width: 1206,
      height: 2622,
    });
    const failed = yield* tools.call("device_screenshot", {}, deviceFailure(screenshotFailure));
    assert.isTrue(failed.isError);
    assert.include(failed.text, "screenshot failed");
    const elsewhere = yield* tools.call("device_open", { hostId: "local", deviceId: IPHONE });
    assert.isTrue(elsewhere.isError);
    assert.include(elsewhere.text, IPHONE);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lists the boot state T3 left a device in", () =>
  Effect.gen(function* () {
    const { devices, deviceHosts } = deviceCase({}).setup.world ?? {};
    const stopped = (devices ?? []).map((device) => ({ ...device, booted: false }));
    const tools = yield* makeDeviceTools({ devices: stopped, deviceHosts }, base.environment);
    const before = json((yield* tools.call("device_list", {})).text);
    assert.isFalse(before.devices.find((d: { id: string }) => d.id === IPHONE).booted);
    yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE });
    const after = json((yield* tools.call("device_list", {})).text);
    assert.isTrue(after.devices.find((d: { id: string }) => d.id === IPHONE).booted);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("decodes only T3 device errors as injected failures", () => {
  assert.isDefined(deviceFailure(screenshotFailure));
  assert.isUndefined(deviceFailure({ error: "Synthetic hub is unavailable", isError: true }));
  assert.isUndefined(deviceFailure("default"));
});

it.effect("rebuilds prior device results with T3, whose sessions reach the measured turn", () =>
  Effect.gen(function* () {
    const testCase = deviceCase({
      priorTurns: [
        { role: "user", text: "Show me Settings on the iPhone on build-mac." },
        {
          role: "assistant",
          toolCalls: [
            { tool: "device_list", input: {}, result: "default" },
            { tool: "device_open", input: { hostId: MAC, deviceId: IPHONE }, result: "default" },
          ],
        },
      ],
      mocks: { device_screenshot: screenshotFailure },
    });
    const sample = makeSample(testCase, base);
    assert.throws(() => buildMessages(sample), /run withDevices/);
    yield* withDevices(sample);
    const shown = JSON.stringify(buildMessages(sample));
    const [launcher = ""] = sample.devices?.launchers ?? [];
    assert.include(shown, launcher);
    assert.notInclude(shown, `"content":"default"`);
    const tools = sample.devices!;
    assert.isFalse((yield* tools.call("device_screenshot", {})).isError);
    const mock = deviceFailure(testCase.setup.mocks?.device_screenshot);
    assert.isTrue((yield* tools.call("device_screenshot", {}, mock)).isError);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("gives a native subagent T3's SubagentStart context instead of T3's append", () =>
  Effect.gen(function* () {
    const subagentContext = yield* Effect.promise(() => t3SubagentContext(model));
    const native = {
      ...buildBase(capture, { model, keepUserInstructions: false, nativeSubagent: true }),
      subagentContext,
    };
    const system = (blocks: typeof base.system) =>
      blocks.map((block) => String(block.text)).join("");
    assert.include(system(base.system), t3SystemAppend(model));
    assert.notInclude(system(native.system), t3SystemAppend(model));
    const testCase = deviceCase({ role: "native-subagent" });
    const shown = (sample: typeof native) =>
      buildMessages(makeSample(testCase, sample))[0]?.content.map((block) => String(block.text));
    const reminders = shown(native)?.join("\n") ?? "";
    // A ref without T3's hook gives the subagent nothing.
    assert.equal(
      reminders.includes("SubagentStart hook additional context"),
      subagentContext !== "",
    );
    assert.include(reminders, subagentContext);
    // Claude Code 2.1.310 records the hook's context after the task, and sends it that way.
    const blocks = shown({ ...native, subagentContext: "## T3 Code devices" }) ?? [];
    assert.equal(blocks.at(-2), testCase.prompt);
    assert.equal(
      blocks.at(-1),
      "<system-reminder>\nSubagentStart hook additional context: ## T3 Code devices\n</system-reminder>",
    );
  }),
);

it.effect("tells the shell simulator the launchers T3 returned and agent-device's real CLI", () =>
  Effect.gen(function* () {
    const sample = makeSample(deviceCase({}), base);
    yield* withDevices(sample);
    const call = { tool: "Bash", input: { command: "ls /tmp" } };
    const told = (request: ReturnType<typeof shellRequest>) => JSON.stringify(request.messages);
    assert.notInclude(told(shellRequest(sample, call, "claude-haiku-5-5")), "launchers T3's");
    const opened = yield* sample.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
    const { command } = json(opened.text).agentDevice;
    const request = shellRequest(sample, call, "claude-haiku-5-5");
    assert.include(told(request), `agent-device launchers T3's device_open returned: ${command}`);
    // agent-device's own syntax: a positional recording path, and `record stop` with no flag.
    assert.include(request.system, AGENT_DEVICE_SHELL);
    assert.include(
      request.system,
      "agent-device record start [path] [--scope <app|device|system>]",
    );
    assert.include(request.system, "| record stop |");
    assert.include(request.system, "Unknown flag: --stop. Did you mean --scope?");
    // A case without devices keeps the shell prompt every other case has.
    const plain = makeSample(deviceCase({ world: {} }), base);
    assert.notInclude(shellRequest(plain, call, "claude-haiku-5-5").system, "agent-device");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("prints agent-device's own help for a lone help command on a returned launcher", () => {
  const help = (topic: string) =>
    AGENT_DEVICE_SHELL.split(`$ agent-device help${topic ? ` ${topic}` : ""}\n`)[1]
      ?.split("\n$ agent-device help")[0]
      ?.trimEnd();
  // Commands from the paired runs. The simulator once answered the first with a placeholder.
  const launcher = "/home/user/.t3/userdata/device/bin/agent-device";
  const target = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/303617b9730210ef3c86c52d.json --session t3-4c43aa31e607633b85e9ff2f`;
  const asked = (command: string) => launcherHelp([launcher], command);
  assert.match(help("") ?? "", /^agent-device <command> \[args\] \[--json\]\n/);
  assert.equal(asked(`${launcher} help ${target}`), help(""));
  assert.equal(asked(`${launcher} record --help ${target}`), help("record"));
  assert.equal(asked(`${launcher} help open ${target}`), help("open"));
  assert.equal(asked(`${launcher} --help 2>&1`), help(""));
  assert.equal(asked(`${launcher} help settings --session=t3-1`), help("settings"));
  // Anything else stays with the simulator: other topics, pipes, aliases, other commands.
  assert.isUndefined(asked(`${launcher} metro --help ${target}`));
  assert.isUndefined(asked(`${launcher} help record 2>&1 | head -40`));
  assert.isUndefined(asked(`AD=${launcher}; $AD help record`));
  assert.isUndefined(asked(`${launcher} snapshot -i ${target}`));
  assert.isUndefined(asked(`/usr/local/bin/agent-device help`));
});

it("pins agent-device's help to the version T3 installs", () => {
  const versions = JSON.parse(
    NodeFS.readFileSync(
      new URL("../../apps/server/src/device/deviceToolVersions.json", import.meta.url),
      "utf8",
    ),
  );
  assert.include(AGENT_DEVICE_SHELL, `agent-device ${versions["agent-device"]} prints this help`);
});

// agent-device 0.21.31's errors as a real Mac printed them (stderr, exit status 1).
const NO_SESSION =
  "Error (SESSION_NOT_FOUND): No active session. Run open first.\nHint: Run open first or pass an explicit device selector.";
const APP_RECORDING_BEFORE_OPEN =
  "Error (INVALID_ARGS): record start with app scope and an explicit session requires an active app session; run open <app> first, or use --scope device to record the full screen\nHint: Check command arguments and run --help for usage examples.";
/** agent-device 0.21.31's snapshot-runtime-binding refusal, with the CLI's default hint. */
const iosSnapshotRefused = (session: string) =>
  `Error (SESSION_NOT_FOUND): iOS snapshot requires an active app session on the target device. Run open first (for example: open --session ${session} --platform ios --device "<name>" <app>).\nHint: Run open first or pass an explicit device selector.`;
const APP_RECORDING_WITHOUT_APP =
  "Error (UNKNOWN): App-scoped recording requires an active app session; open the app under test before recording.\nHint: Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.";

it.effect("answers the returned launcher as agent-device does before and after open", () =>
  Effect.gen(function* () {
    const { devices = [], deviceHosts } = deviceCase({}).setup.world ?? {};
    const tools = yield* makeDeviceTools({ devices, deviceHosts }, base.environment);
    const opened = json((yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE })).text);
    const { command, targetArgs, session: bound } = opened.agentDevice;
    // This ref's launcher: a bound one names its session; the shared one takes device_open's flags.
    const session: string = bound ?? targetArgs[targetArgs.indexOf("--session") + 1];
    const line = (args: string) =>
      bound === undefined ? `${command} ${args} ${targetArgs.join(" ")}` : `${command} ${args}`;
    const history: Array<ShellCall> = [];
    const answer = (args: string) => tools.sessionError(history, line(args));
    const ran = (args: string, output: string) =>
      history.push({ tool: "Bash", input: { command: line(args) }, output });

    const shot = answer("screenshot /tmp/shot.png") ?? "";
    assert.isTrue(shot.startsWith(`Exit code 1\n${NO_SESSION}\nDiagnostic ID: `));
    assert.match(
      shot,
      new RegExp(
        `\\nDiagnostics Log: /home/user/\\.agent-device/remote-diagnostics/${session}/requests/[\\da-f]{16}\\.ndjson$`,
      ),
    );
    for (const args of ["press @e3 --settle", 'fill @e5 "hello world"', "scroll down", "home"]) {
      assert.include(answer(args), NO_SESSION, args);
    }
    assert.include(answer("record start /tmp/run.mp4"), APP_RECORDING_BEFORE_OPEN);
    // An iOS snapshot needs an app open in the session.
    assert.include(answer("snapshot -i"), iosSnapshotRefused("sim"));
    // With the device selector both refs pass, these run without a session.
    for (const args of [
      "open",
      "devices",
      "apps",
      "settings appearance dark",
      "alert accept",
      "install com.acme.app /tmp/Acme.app",
      "record start --scope device /tmp/run.mp4",
    ]) {
      assert.isUndefined(answer(args), args);
    }
    // Unknown flags, JSON output and compound commands stay with the simulator.
    assert.isUndefined(answer("screenshot --bogus /tmp/shot.png"));
    assert.isUndefined(answer("screenshot --json /tmp/shot.png"));
    assert.isUndefined(tools.sessionError(history, `${line("screenshot /tmp/a.png")} && echo ok`));
    assert.deepEqual([...tools.sessions(history)], [[session, undefined]]);

    ran("open com.acme.missing", "Exit code 1\nError (APP_NOT_INSTALLED): App not installed");
    assert.include(answer("screenshot /tmp/shot.png"), NO_SESSION);
    ran("open", `Opened: ${session}`);
    assert.isUndefined(answer("screenshot /tmp/shot.png"));
    assert.isUndefined(answer("press @e3"));
    assert.include(answer("record start /tmp/run.mp4"), APP_RECORDING_WITHOUT_APP);
    assert.isUndefined(answer("record start --scope device /tmp/run.mp4"));
    assert.include(answer("snapshot -i"), iosSnapshotRefused(session));
    ran("open com.acme.app", "Opened: com.acme.app");
    assert.isUndefined(answer("record start /tmp/run.mp4"));
    assert.isUndefined(answer("snapshot -i"));
    assert.deepEqual([...tools.sessions(history)], [[session, { app: true }]]);
    ran("close", "Closed");
    assert.include(
      tools.sessionError(history, `${line("screenshot /tmp/a.png")} 2>&1`),
      NO_SESSION,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const shared = (session: string): LauncherTarget => ({
  command: "/home/user/.t3/userdata/device/bin/agent-device",
  session,
  bound: false,
  deviceId: IPHONE,
  ios: true,
  iosSimulator: true,
});
const boundTarget: LauncherTarget = {
  command: "/home/user/.t3/userdata/device/targets/t3-bound/agent-device",
  session: "t3-bound",
  bound: true,
  deviceId: IPHONE,
  ios: true,
  iosSimulator: true,
};
const bash = (command: string, output = "OK"): ShellCall => ({
  tool: "Bash",
  input: { command },
  output,
});
const errorCode = (
  targets: ReadonlyArray<LauncherTarget>,
  history: ReadonlyArray<ShellCall>,
  command: string,
) => agentDeviceSessionError(targets, agentDeviceSessions(targets, {}, history), command)?.code;

it("names the session on either ref: the bound launcher's own, or the shared one's --session", () => {
  const flags = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/x.json`;
  const sharedTargets = [shared("t3-a"), shared("t3-b")];
  // The shared launcher answers each session its flags name; without one, its own check (not
  // modelled) refuses before agent-device runs.
  const opened = [bash(`${sharedTargets[0]!.command} open com.acme.app ${flags} --session t3-a`)];
  assert.isUndefined(
    errorCode(
      sharedTargets,
      opened,
      `${sharedTargets[0]!.command} screenshot ${flags} --session t3-a`,
    ),
  );
  assert.equal(
    errorCode(
      sharedTargets,
      opened,
      `${sharedTargets[0]!.command} screenshot ${flags} --session=t3-b`,
    ),
    "SESSION_NOT_FOUND",
  );
  assert.isUndefined(errorCode(sharedTargets, [], `${sharedTargets[0]!.command} screenshot`));
  // The bound launcher needs no flags, and an explicit --session still wins.
  assert.equal(
    errorCode([boundTarget], [], `${boundTarget.command} screenshot`),
    "SESSION_NOT_FOUND",
  );
  assert.equal(errorCode([boundTarget], [], `${boundTarget.command} record start`), "INVALID_ARGS");
  const boundOpen = [bash(`${boundTarget.command} open`)];
  assert.isUndefined(errorCode([boundTarget], boundOpen, `${boundTarget.command} screenshot`));
  assert.equal(
    errorCode([boundTarget], boundOpen, `${boundTarget.command} record start /tmp/r.mp4`),
    "UNKNOWN",
  );
  assert.equal(
    errorCode([boundTarget], boundOpen, `${boundTarget.command} screenshot --session other`),
    "SESSION_NOT_FOUND",
  );
  // Without a selector, agent-device's record and close refuse a missing named session with
  // other text; that stays with the simulator.
  assert.isUndefined(
    errorCode(sharedTargets, [], `${sharedTargets[0]!.command} record start --session t3-a`),
  );
});

it("follows the session through aliases, compound calls, snapshots and whole-screen recordings", () => {
  const launcher = boundTarget.command;
  const after = (...history: ReadonlyArray<ShellCall>) =>
    agentDeviceSessions([boundTarget], {}, history).get("t3-bound");
  assert.deepEqual(after(bash(`AD=${launcher}; "$AD" open com.acme.app`)), { app: true });
  // A failed lone open starts nothing; an open in a failed compound call still counts.
  assert.isUndefined(after(bash(`${launcher} open com.acme.app`, "Exit code 1\nError (X): no")));
  assert.deepEqual(
    after(bash(`${launcher} open com.acme.app && ${launcher} press @e9`, "Exit code 1\nboom")),
    { app: true },
  );
  // Dead tails, remote agent-device and help start nothing.
  assert.isUndefined(after(bash(`false && ${launcher} open`, "Exit code 1")));
  assert.isUndefined(after(bash("ssh build-mac agent-device open com.acme.app")));
  assert.isUndefined(after(bash(`${launcher} help open`)));
  // agent-device publishes a session for a sessionless Android snapshot, without an app. An iOS
  // snapshot without an app fails and starts nothing.
  assert.isUndefined(after(bash(`${launcher} snapshot -i`)));
  const android = { ...boundTarget, ios: false, iosSimulator: false };
  assert.deepEqual(
    agentDeviceSessions([android], {}, [bash(`${launcher} snapshot -i`)]).get("t3-bound"),
    { app: false },
  );
  // A whole-screen recording holds a session only until it stops.
  const recording = bash(`${launcher} record start --scope device /tmp/r.mp4`);
  assert.deepEqual(after(recording), { app: false, recordingOnly: true });
  assert.isUndefined(errorCode([boundTarget], [recording], `${launcher} screenshot`));
  assert.isUndefined(after(recording, bash(`${launcher} record stop`)));
  assert.equal(
    errorCode(
      [boundTarget],
      [recording, bash(`${launcher} record stop`)],
      `${launcher} screenshot`,
    ),
    "SESSION_NOT_FOUND",
  );
  assert.deepEqual(after(bash(`${launcher} open`), bash(`${launcher} close`)), undefined);
});

it("follows the shared launcher's session through flags held in a variable or an array", () => {
  // Forms Sonnet used with the shared launcher in a live sample.
  const target = shared("t3-a");
  const flags = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/x.json --session t3-a`;
  const after = (history: ShellCall, targets = [target]) =>
    agentDeviceSessions(targets, {}, [history]).get("t3-a");
  const opened = bash(
    `AD=${target.command}; A="${flags}"; $AD open com.acme.app $A 2>&1 | tail -5; sleep 5; $AD snapshot -i $A 2>&1 | head -60`,
    "Opened: com.acme.app",
  );
  assert.deepEqual(after(opened), { app: true });
  const array = bash(`A=(${flags}); ${target.command} open "\${A[@]}" 2>&1 | head -60`);
  assert.deepEqual(after(array), { app: false });
  // With two sessions behind the shared launcher, unread flags name neither.
  assert.isUndefined(after(array, [target, shared("t3-b")]));
  // agent-device still sees no session for a plain command after a failed open in a variable.
  const failed = bash(
    `AD=${target.command}; A="${flags}"; $AD open $A`,
    "Exit code 1\nError (X): no",
  );
  assert.equal(
    errorCode([target], [failed], `${target.command} screenshot ${flags}`),
    "SESSION_NOT_FOUND",
  );
});

it.effect("starts sessions the world says prior turns opened, and rejects unknown devices", () =>
  Effect.gen(function* () {
    const testCase = deviceCase({
      world: { ...world, agentDeviceSessions: { [IPHONE]: { app: "com.acme.app" } } },
      priorTurns: [
        { role: "user", text: "Show me Settings on the iPhone on build-mac." },
        {
          role: "assistant",
          toolCalls: [
            { tool: "device_open", input: { hostId: MAC, deviceId: IPHONE }, result: "default" },
          ],
        },
      ],
    });
    const sample = makeSample(testCase, base);
    yield* withDevices(sample);
    const tools = sample.devices!;
    const [launcher = ""] = tools.launchers;
    assert.deepEqual([...tools.sessions(sample.shell).values()], [{ app: true }]);
    const call = { tool: "Bash", input: { command: "ls" } };
    assert.include(
      JSON.stringify(shellRequest(sample, call, "claude-haiku-5-5").messages),
      "is open with an app",
    );
    assert.isUndefined(tools.sessionError(sample.shell, `${launcher} record start /tmp/r.mp4`));
    const { devices = [], deviceHosts } = testCase.setup.world ?? {};
    const unknown = { devices, deviceHosts, agentDeviceSessions: { "not-a-device": {} } };
    const exit = yield* Effect.exit(makeDeviceTools(unknown, base.environment));
    assert.isTrue(exit._tag === "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "answers a shell mock first, then help, then the session error, before the simulator",
  () =>
    Effect.gen(function* () {
      const sample = makeSample(deviceCase({}), base);
      yield* withDevices(sample);
      const opened = yield* sample.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
      const { command, targetArgs, session } = json(opened.text).agentDevice;
      const flags = session === undefined ? ` ${targetArgs.join(" ")}` : "";
      const told = () =>
        JSON.stringify(
          shellRequest(sample, { tool: "Bash", input: {} }, "claude-haiku-5-5").messages,
        );
      assert.include(told(), "has not started");
      assert.include(cannedOutput(sample, `${command} screenshot /tmp/a.png${flags}`), NO_SESSION);
      assert.match(cannedOutput(sample, `${command} help record`) ?? "", /^Usage:/);
      assert.isUndefined(cannedOutput(sample, `${command} open com.acme.app${flags}`));
      const outage = makeSample(
        deviceCase({
          shellMocks: [
            { match: "\\bagent-device\\b", output: "Exit code 1\nError (COMMAND_FAILED): down" },
          ],
        }),
        base,
      );
      yield* withDevices(outage);
      yield* outage.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
      assert.include(cannedOutput(outage, `${command} screenshot /tmp/a.png${flags}`), "down");
      sample.shell.push({
        tool: "Bash",
        input: { command: `${command} open com.acme.app${flags}` },
        output: "Opened: com.acme.app",
      });
      assert.isUndefined(cannedOutput(sample, `${command} screenshot /tmp/a.png${flags}`));
      assert.include(told(), "is open with an app");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("keeps a redirection's descriptor out of the app an open names, on either launcher", () => {
  // Sol R10 B1: `open 2>&1` once read as `open 2`, an app the real shell never passes.
  const flags = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/x.json --session t3-a`;
  for (const [target, args] of [
    [shared("t3-a"), ` ${flags}`],
    [boundTarget, ""],
  ] as const) {
    for (const redirect of ["2>&1", "2>&1 | tail -5", "2>/dev/null"]) {
      const opened = [
        bash(`${target.command} open${args} ${redirect}`, `Opened: ${target.session}`),
      ];
      assert.deepEqual(
        agentDeviceSessions([target], {}, opened).get(target.session),
        { app: false },
        redirect,
      );
      assert.equal(
        errorCode([target], opened, `${target.command} record start /tmp/run.mp4${args}`),
        "UNKNOWN",
        redirect,
      );
    }
  }
});

it("follows opens the parser cannot prove ran, in calls that did not fail", () => {
  // Opus R10 B1(b): shapes from run 5, where `&&` before `;` leaves an open uncertain.
  const launcher = boundTarget.command;
  const after = (command: string, output = "Opened: com.acme.app") =>
    agentDeviceSessions([boundTarget], {}, [bash(command, output)]).get("t3-bound");
  assert.deepEqual(
    after(`mkdir -p /tmp/p && ${launcher} open com.acme.app 2>&1 | tail -3; echo done`),
    { app: true },
  );
  assert.deepEqual(after(`cd /tmp && ${launcher} open com.acme.app; ${launcher} snapshot -i`), {
    app: true,
  });
  // The launcher alias such a call sets, too, here and in later calls.
  assert.deepEqual(after(`mkdir -p /tmp/p && AD=${launcher}; $AD open com.acme.app`), {
    app: true,
  });
  assert.deepEqual(after(`mkdir -p /tmp/p && AD="${launcher}"; "\${AD}" open com.acme.app`), {
    app: true,
  });
  assert.deepEqual(
    agentDeviceSessions([boundTarget], {}, [
      bash(`cd /tmp && AD=${launcher}; echo ready`),
      bash("$AD open com.acme.app"),
    ]).get("t3-bound"),
    { app: true },
  );
  // A failed call credits only what certainly ran.
  assert.isUndefined(
    after(`mkdir -p /tmp/p && ${launcher} open com.acme.app; echo done`, "Exit code 1\nno"),
  );
  assert.isUndefined(
    after(`mkdir -p /tmp/p && AD=${launcher}; $AD open com.acme.app`, "Exit code 1\nno"),
  );
});

const SPARE_MAC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SPARE_PHONE = "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD";
const twoMacs = {
  devices: [
    ...world.devices,
    { ...world.devices[0]!, hostId: SPARE_MAC, id: SPARE_PHONE, name: "Acme Spare iPhone" },
  ],
  deviceHosts: { ...world.deviceHosts, [SPARE_MAC]: "spare-mac" },
};
const deviceTools = (extra: object) =>
  makeDeviceTools(
    { ...twoMacs, ...extra } as Parameters<typeof makeDeviceTools>[0],
    base.environment,
  );

it.effect("lists a host whose discovery fails as T3 does: failed, with none of its devices", () =>
  Effect.gen(function* () {
    // F1's saved device_list: the hub answered, but its device list timed out.
    const failure = new DeviceOperationError({
      operation: "list",
      reason: "request_failed",
      cause: null,
    });
    const tools = yield* deviceTools({ deviceDiscoveryFailures: { [MAC]: failure } });
    const listed = json((yield* tools.call("device_list", {})).text);
    assert.deepEqual(listed.hostStatuses[MAC], {
      status: "failed",
      detail:
        "Device list failed: Could not communicate with device support. Try refreshing devices.",
    });
    assert.equal(listed.hostStatuses[SPARE_MAC].status, "ready");
    assert.deepEqual(
      listed.devices.map((device: { id: string }) => device.id),
      [SPARE_PHONE],
    );
    const opened = yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE });
    assert.isTrue(opened.isError);
    assert.include(opened.text, IPHONE);
    assert.isFalse(
      (yield* tools.call("device_open", { hostId: SPARE_MAC, deviceId: SPARE_PHONE })).isError,
    );
    // A failed host with no devices of its own still needs its label.
    const unlabeled = yield* Effect.exit(
      deviceTools({ deviceDiscoveryFailures: { "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee": failure } }),
    );
    assert.isTrue(unlabeled._tag === "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("denies every device tool with T3's own error when agent device access is off", () =>
  Effect.gen(function* () {
    const tools = yield* deviceTools({ deviceAgentAccess: false });
    for (const [name, input] of [
      ["device_list", {}],
      ["device_open", { hostId: MAC, deviceId: IPHONE }],
      ["device_screenshot", {}],
      ["device_close", {}],
    ] as const) {
      const result = yield* tools.call(name, input);
      assert.isTrue(result.isError, name);
      // Refs before typed screenshot errors print their generic screenshot failure instead, and
      // later refs may add how to turn access on.
      const denied = result.text.startsWith(
        "Agent device access is turned off for this environment.",
      );
      assert.isTrue(
        denied || (name === "device_screenshot" && result.text === "Device screenshot failed."),
        `${name}: ${result.text}`,
      );
    }
    // T3 drops its device text for a thread without the capability, on refs that have it.
    assert.notInclude(t3SystemAppend(model, false), "## T3 Code devices");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports an unreadable capture as T3 does: a successful 0×0 screenshot", () =>
  Effect.gen(function* () {
    const tools = yield* deviceTools({ deviceInvalidCapture: true });
    yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE });
    const shot = yield* tools.call("device_screenshot", {});
    assert.isFalse(shot.isError);
    assert.deepEqual(json(shot.text).screenshot, { mimeType: "image/png", width: 0, height: 0 });
    const sample = makeSample(
      deviceCase({ world: { ...world, deviceInvalidCapture: true } }),
      base,
    );
    yield* withDevices(sample);
    const told = JSON.stringify(shellRequest(sample, { tool: "Bash", input: {} }, model).messages);
    assert.include(told, "agent-device's own screenshot finds the PNG and is unaffected");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses an open on a device another thread's agent-device session holds", () =>
  Effect.gen(function* () {
    const tools = yield* deviceTools({ deviceOwners: { [IPHONE]: "acme-design-review" } });
    // T3 names the owner's session as it names every thread's.
    const owner = "t3-a062c547ef0b6bf8ee839b67";
    assert.deepEqual(tools.owners, [
      { deviceId: IPHONE, threadId: "acme-design-review", session: owner },
    ]);
    // T3 has no cross-thread gate: device_open succeeds, and device_list shows only this thread.
    const opened = json((yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE })).text);
    assert.deepEqual(json((yield* tools.call("device_list", {})).text).open, [
      { hostId: MAC, deviceId: IPHONE },
    ]);
    const { command, targetArgs, session: bound } = opened.agentDevice;
    const own: string = bound ?? targetArgs[targetArgs.indexOf("--session") + 1];
    const target = (session = own) =>
      bound === undefined
        ? targetArgs.map((arg: string) => (arg === own ? session : arg)).join(" ")
        : session === own
          ? ""
          : `--session ${session}`;
    const line = (args: string, session?: string) => `${command} ${args} ${target(session)}`.trim();
    const history: Array<ShellCall> = [];
    const answer = (args: string, session?: string) =>
      tools.sessionError(history, line(args, session)) ?? "";
    const inUse = `Error (DEVICE_IN_USE): Device is already in use by session "${owner}".\nHint: Run agent-device session list to inspect active sessions. To reuse this device, rerun the command with --session ${owner}. To open a new session on this device, first run agent-device close --session ${owner}.`;
    assert.include(
      answer("open com.acme.app"),
      `${inUse} To wait for the device to free up, run the same open with --wait <ms>.\nDiagnostic ID: `,
    );
    assert.include(
      answer("open --wait 5000"),
      `Error (DEVICE_IN_USE): Device is already in use by session "${owner}".\nHint: Waited 5000ms for this device and it stayed busy. Run agent-device session list`,
    );
    assert.notInclude(answer("open --wait 5000"), "--wait <ms>");
    // The hint's reuse works, in the other thread's session.
    assert.equal(answer("screenshot /tmp/a.png", owner), "");
    assert.equal(answer("open com.acme.app", owner), "");
    // A failed open starts nothing, in a compound call too.
    history.push({
      tool: "Bash",
      input: { command: `${line("open com.acme.app")} && ${line("screenshot /tmp/a.png")}` },
      output: "Exit code 1\nError (DEVICE_IN_USE): Device is already in use",
    });
    assert.deepEqual(
      [...tools.sessions(history)],
      [
        [own, undefined],
        [owner, { app: true }],
      ],
    );
    const sample = makeSample(
      deviceCase({ world: { ...twoMacs, deviceOwners: { [IPHONE]: "acme-design-review" } } }),
      base,
    );
    yield* withDevices(sample);
    const told = JSON.stringify(shellRequest(sample, { tool: "Bash", input: {} }, model).messages);
    assert.include(
      told,
      `${owner} (Acme iPhone, ${IPHONE}, on build-mac) belongs to another T3 thread (acme-design-review)`,
    );
    // Closing the owner's session frees the device.
    history.push({ tool: "Bash", input: { command: line("close", owner) }, output: "Closed" });
    assert.equal(answer("open com.acme.app"), "");
    assert.include(describeSessions(tools.sessions(history), tools.owners), "was closed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves a free device free when another thread holds a different one", () =>
  Effect.gen(function* () {
    const tools = yield* deviceTools({ deviceOwners: { [IPHONE]: "acme-design-review" } });
    const opened = json(
      (yield* tools.call("device_open", { hostId: SPARE_MAC, deviceId: SPARE_PHONE })).text,
    );
    const { command, targetArgs, session } = opened.agentDevice;
    const flags = session === undefined ? ` ${targetArgs.join(" ")}` : "";
    assert.isUndefined(tools.sessionError([], `${command} open com.acme.app${flags}`));
    assert.include(
      tools.sessionError([], `${command} screenshot /tmp/a.png${flags}`) ?? "",
      "SESSION_NOT_FOUND",
    );
    // The local host always exists and holds none of the world's devices.
    assert.isFalse(
      (yield* tools.call("device_list", {})).text.includes(`"hostId":"${LOCAL_DEVICE_HOST_ID}"`),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

type Opened = { command: string; targetArgs: Array<string>; session?: string };
/** This ref's command line for a launcher: a bound one needs no flags; the shared one takes them. */
const commandLine = (opened: Opened, args: string, session?: string) => {
  const own = opened.session ?? opened.targetArgs[opened.targetArgs.indexOf("--session") + 1];
  if (opened.session !== undefined)
    return `${opened.command} ${args}${session === undefined ? "" : ` --session ${session}`}`;
  const flags = opened.targetArgs.map((arg) => (arg === own && session ? session : arg));
  return `${opened.command} ${args} ${flags.join(" ")}`;
};

it.effect(
  "tells the simulator each launcher's device, and routes DEVICE_IN_USE to the held one",
  () =>
    Effect.gen(function* () {
      // Opus R11-B3(a): in run 6 the simulator gave the free spare's plain open the owner's
      // DEVICE_IN_USE twice. It could not tell which device a flagless bound launcher drives.
      const owner = "t3-a062c547ef0b6bf8ee839b67";
      const sample = makeSample(
        deviceCase({ world: { ...twoMacs, deviceOwners: { [IPHONE]: "acme-design-review" } } }),
        base,
      );
      yield* withDevices(sample);
      const tools = sample.devices!;
      const open = (hostId: string, deviceId: string) =>
        Effect.map(
          tools.call("device_open", { hostId, deviceId }),
          (result): Opened => json(result.text).agentDevice,
        );
      const held = yield* open(MAC, IPHONE);
      const spare = yield* open(SPARE_MAC, SPARE_PHONE);
      const session = (opened: Opened) =>
        opened.session ?? opened.targetArgs[opened.targetArgs.indexOf("--session") + 1];
      const told = (command: string) =>
        String(
          shellRequest(sample, { tool: "Bash", input: { command } }, model).messages[0]?.content[0]
            ?.text,
        );
      // Run 6's history: the held device's plain open, refused without the simulator.
      const heldOpen = commandLine(held, "open com.acme.app --metro-port 8095");
      const refused = cannedOutput(sample, heldOpen) ?? "";
      assert.include(
        refused,
        `Error (DEVICE_IN_USE): Device is already in use by session "${owner}".`,
      );
      sample.shell.push({ tool: "Bash", input: { command: heldOpen }, output: refused });

      // The spare's plain open goes to the simulator, which now knows it drives the free spare.
      const spareOpen = commandLine(spare, "open com.acme.app --metro-port 8095");
      assert.isUndefined(cannedOutput(sample, spareOpen));
      const free = told(spareOpen);
      assert.include(
        free,
        `agent-device launchers T3's device_open returned: ${
          held.session === undefined
            ? `${held.command} (shared: each command's --udid or --serial and --session name its device and session)`
            : `${held.command} (drives Acme iPhone, ${IPHONE}, on build-mac, in session ${held.session}); ${spare.command} (drives Acme Spare iPhone, ${SPARE_PHONE}, on spare-mac, in session ${spare.session})`
        }`,
      );
      assert.include(
        free,
        `${session(held)} (Acme iPhone, ${IPHONE}, on build-mac) has not started; ${session(spare)} (Acme Spare iPhone, ${SPARE_PHONE}, on spare-mac) has not started; ${owner} (Acme iPhone, ${IPHONE}, on build-mac) belongs to another T3 thread (acme-design-review) and holds its device with an app open.`,
      );
      assert.include(
        free,
        `In the new call, \`${spareOpen}\` drives Acme Spare iPhone, ${SPARE_PHONE}, on spare-mac, which no other session holds: it prints no DEVICE_IN_USE.`,
      );
      assert.notInclude(free, "Error (DEVICE_IN_USE)");

      // A compound open of the held device gets agent-device's exact refusal, for that open only.
      const piped = commandLine(held, "open com.acme.app");
      const refusal = told(`${piped} 2>&1 | tail -5`);
      assert.include(
        refusal,
        `In the new call, \`${piped}\` drives Acme iPhone, ${IPHONE}, on build-mac, which session ${owner} holds: it fails with exit code 1, printing "Error (DEVICE_IN_USE): Device is already in use by session "${owner}"." and "Hint: Run agent-device session list to inspect active sessions. To reuse this device,`,
      );
      assert.notInclude(refusal, "no other session holds");
      // One call may try the held device, then fall back to the spare through an alias.
      const alias =
        spare.session === undefined
          ? `A=${spare.command}; "$A" open com.acme.app ${spare.targetArgs.join(" ")}`
          : `A=${spare.command}; "$A" open com.acme.app`;
      const both = told(`${piped} || echo busy; ${alias}`);
      assert.include(both, `which session ${owner} holds: it fails with exit code 1`);
      assert.include(
        both,
        `on spare-mac, which no other session holds: it prints no DEVICE_IN_USE`,
      );
      // An open in the other thread's own session is not refused, and gets no route.
      assert.notInclude(told(commandLine(held, "open com.acme.app", owner)), "In the new call");
      // An open after the same call closes the other thread's session finds the device free.
      const reopen = told(`${commandLine(held, "close", owner)}; ${piped}`);
      assert.include(
        reopen,
        `\`${piped}\` drives Acme iPhone, ${IPHONE}, on build-mac, which no other session holds: it prints no DEVICE_IN_USE`,
      );
      assert.notInclude(reopen, `which session ${owner} holds`);
      // Neither do commands other than open.
      assert.notInclude(
        told(`${commandLine(spare, "screenshot /tmp/a.png")} && echo ok`),
        "In the new call",
      );

      // A world where no other thread holds a device gets no route either.
      const alone = makeSample(deviceCase({}), base);
      yield* withDevices(alone);
      const own: Opened = json(
        (yield* alone.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE })).text,
      ).agentDevice;
      const request = shellRequest(
        alone,
        { tool: "Bash", input: { command: `${commandLine(own, "open com.acme.app")} | tail -3` } },
        model,
      );
      assert.notInclude(JSON.stringify(request.messages), "In the new call");
      assert.include(
        JSON.stringify(request.messages),
        `${session(own)} (Acme iPhone, ${IPHONE}, on build-mac) has not started`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("tells the simulator 0.21.31's --foreground and session list behaviour", () => {
  // Opus R11-B3(b): 0.21.31 (session2.js ys) refuses only an open --foreground with no app or URL.
  // Run 6's simulator refused `open <app> --foreground` in 9 base samples.
  assert.include(
    AGENT_DEVICE_SHELL,
    "open --foreground with no app or URL fails with exit code 1 when the command passes --udid or --device",
  );
  assert.include(AGENT_DEVICE_SHELL, "open <app> --foreground works.");
  // Run 6's simulator answered the DEVICE_IN_USE hint's `session list` with "Unknown command".
  assert.include(
    AGENT_DEVICE_SHELL,
    "session list prints, as JSON, the started sessions on the launcher's host, other threads' too",
  );
  // Neither is refused without the simulator.
  for (const args of ["open com.acme.app --foreground", "session list"]) {
    assert.isUndefined(
      agentDeviceSessionError(
        [boundTarget],
        new Map([["t3-bound", undefined]]),
        `${boundTarget.command} ${args}`,
      ),
      args,
    );
  }
});
