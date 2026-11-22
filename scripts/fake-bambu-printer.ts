// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Standalone development tool, not part of the server.
/**
 * Fake Bambu Lab P1S for developing the direct Bambu connection: MQTT over TLS on 8883, camera on
 * 6000, refuses controls unless in Developer mode (`--mode dev`, or send SIGUSR1 to toggle).
 * Copy `<state-dir>/ca.pem` into `<T3 home>/printer-certs/` so T3 Code trusts it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

type Json = Record<string, unknown>;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1];
  if (key && value !== undefined) args.set(key, value);
}
const SERIAL = args.get("serial") ?? "01P00A000000001";
const ACCESS_CODE = args.get("code") ?? "12345678";
const HOST = args.get("host") ?? "127.0.0.1";
const MQTT_PORT = Number(args.get("mqtt-port") ?? 8883);
const CAMERA_PORT = Number(args.get("camera-port") ?? 6000);
const STATE_DIR =
  args.get("state-dir") ?? NodePath.join(NodeOS.homedir(), ".t3", "fake-bambu-printer");
const FRAMES_DIR = args.get("frames") ?? NodePath.join(STATE_DIR, "frames");
let developerMode = (args.get("mode") ?? "normal") === "dev";

const log = (message: string) => console.log(`[fake-p1s ${new Date().toISOString()}] ${message}`);

function ensureCertificates(): { key: string; cert: string; caPath: string } {
  NodeFS.mkdirSync(STATE_DIR, { recursive: true });
  const caKey = NodePath.join(STATE_DIR, "ca.key");
  const caPem = NodePath.join(STATE_DIR, "ca.pem");
  const key = NodePath.join(STATE_DIR, "printer.key");
  const csr = NodePath.join(STATE_DIR, "printer.csr");
  const cert = NodePath.join(STATE_DIR, "printer.pem");
  const openssl = (...opensslArgs: string[]) =>
    NodeChildProcess.execFileSync("openssl", opensslArgs, { stdio: "ignore" });
  if (!NodeFS.existsSync(caPem)) {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPem,
      "-days",
      "3650",
      "-subj",
      "/O=T3 Code development/CN=Fake Bambu Device CA",
    );
  }
  if (!NodeFS.existsSync(cert)) {
    openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${SERIAL}`,
    );
    openssl(
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caPem,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "3650",
    );
  }
  return {
    key: NodeFS.readFileSync(key, "utf8"),
    cert: NodeFS.readFileSync(cert, "utf8"),
    caPath: caPem,
  };
}

const TOTAL_LAYERS = 221;
const PRINT_SECONDS = 20 * 60; // A full print plays out in twenty minutes.
const BASE_REPORT: Json = {
  command: "push_status",
  msg: 0,
  sequence_id: "0",
  gcode_state: "RUNNING",
  gcode_file: "/data/Metadata/plate_1.gcode",
  subtask_name: "porcupinefish_print_ready",
  mc_percent: 0,
  mc_remaining_time: 0,
  layer_num: 0,
  total_layer_num: TOTAL_LAYERS,
  stg_cur: 0,
  print_error: 0,
  nozzle_temper: 220,
  nozzle_target_temper: 220,
  bed_temper: 55,
  bed_target_temper: 55,
  chamber_temper: 31,
  cooling_fan_speed: "15",
  big_fan1_speed: "0",
  big_fan2_speed: "0",
  heatbreak_fan_speed: "15",
  spd_lvl: 2,
  spd_mag: 100,
  lights_report: [{ node: "chamber_light", mode: "on" }],
  hms: [],
  wifi_signal: "-52dBm",
  nozzle_diameter: "0.4",
  nozzle_type: "stainless_steel",
  sdcard: true,
  ipcam: { ipcam_dev: "1", ipcam_record: "enable", timelapse: "disable", resolution: "1080p" },
  ams: {
    tray_now: "0",
    ams: [
      {
        id: "0",
        humidity: "4",
        humidity_raw: "22",
        temp: "27.5",
        tray: [
          {
            id: "0",
            tray_type: "PLA",
            tray_color: "F4F1EAFF",
            remain: 86,
            tray_sub_brands: "PLA Matte",
          },
          {
            id: "1",
            tray_type: "PLA",
            tray_color: "1F1F1FFF",
            remain: 54,
            tray_sub_brands: "PLA Basic",
          },
          {
            id: "2",
            tray_type: "PETG",
            tray_color: "2E7D32FF",
            remain: 31,
            tray_sub_brands: "PETG HF",
          },
          { id: "3" },
        ],
      },
    ],
  },
};

let state: Json = structuredClone(BASE_REPORT);
let elapsed = Math.round(PRINT_SECONDS * 0.08); // Start a little way into the print.
let running = true;
let paused = false;

const funValue = () => (developerMode ? "3EC18FFF9CFF" : "3EC1AFFF9CFF");

function tick(): Json {
  const jitter = () => Math.round((Math.random() - 0.5) * 6) / 10;
  if (running && !paused) elapsed = Math.min(PRINT_SECONDS, elapsed + 1);
  const fraction = elapsed / PRINT_SECONDS;
  const finished = elapsed >= PRINT_SECONDS;
  if (finished && running) {
    running = false;
    log("Print finished.");
  }
  const nozzleTarget = Number(state.nozzle_target_temper);
  const bedTarget = Number(state.bed_target_temper);
  const patch: Json = {
    gcode_state: finished ? "FINISH" : paused ? "PAUSE" : running ? "RUNNING" : "IDLE",
    stg_cur: finished ? 255 : paused ? 16 : 0,
    mc_percent: Math.floor(fraction * 100),
    layer_num: Math.max(1, Math.floor(fraction * TOTAL_LAYERS)),
    mc_remaining_time: Math.ceil(((PRINT_SECONDS - elapsed) / 60) * 12), // Shown as a real-time estimate.
    nozzle_temper: Math.round((nozzleTarget + jitter()) * 10) / 10,
    bed_temper: Math.round((bedTarget + jitter()) * 10) / 10,
    fun: funValue(),
  };
  state = { ...state, ...patch };
  return patch;
}

function remainingLength(length: number): Buffer {
  const bytes: number[] = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}
const mqttString = (value: string) => {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
};
const publishPacket = (topic: string, payload: Json) => {
  const body = Buffer.concat([mqttString(topic), Buffer.from(JSON.stringify(payload))]);
  return Buffer.concat([Buffer.from([0x30]), remainingLength(body.length), body]);
};

interface Client {
  readonly socket: NodeTls.TLSSocket;
  authenticated: boolean;
  subscribed: boolean;
  buffer: Buffer;
}
const clients = new Set<Client>();
const reportTopic = `device/${SERIAL}/report`;
const requestTopic = `device/${SERIAL}/request`;

function broadcast(payload: Json): void {
  const bytes = publishPacket(reportTopic, payload);
  for (const client of clients) {
    if (client.authenticated && client.subscribed) client.socket.write(bytes);
  }
}
const sendTo = (client: Client, payload: Json) =>
  client.socket.write(publishPacket(reportTopic, payload));

function fullReport(): Json {
  return { print: { ...state, command: "push_status", fun: funValue() } };
}

function refuse(client: Client, section: Json, command: string): void {
  sendTo(client, {
    print: {
      command,
      sequence_id: section.sequence_id ?? "0",
      result: "failed",
      reason: "mqtt message verify failed",
    },
  });
  log(`Refused "${command}": printer is not in Developer mode.`);
}

function handleRequest(client: Client, message: Json): void {
  const pushing = message.pushing as Json | undefined;
  const info = message.info as Json | undefined;
  const print = message.print as Json | undefined;
  const system = message.system as Json | undefined;
  if (pushing?.command === "pushall") {
    sendTo(client, fullReport());
    return;
  }
  if (info?.command === "get_version") {
    sendTo(client, {
      info: {
        command: "get_version",
        sequence_id: info.sequence_id ?? "0",
        module: [
          {
            name: "ota",
            product_name: "Bambu Lab P1S",
            sn: SERIAL,
            sw_ver: "01.08.02.00",
            hw_ver: "OTA",
          },
          { name: "ams/0", product_name: "AMS (1)", sn: `${SERIAL}-AMS`, sw_ver: "00.00.06.49" },
        ],
      },
    });
    return;
  }
  if (system?.command === "ledctrl" && system.led_node === "chamber_light") {
    state.lights_report = [
      { node: "chamber_light", mode: system.led_mode === "on" ? "on" : "off" },
    ];
    broadcast({ print: { command: "push_status", lights_report: state.lights_report } });
    log(`Chamber light ${String(system.led_mode)}.`);
    return;
  }
  if (!print) return;
  const command = String(print.command ?? "");
  if (!developerMode) {
    refuse(client, print, command);
    return;
  }
  switch (command) {
    case "pause":
      paused = true;
      break;
    case "resume":
      paused = false;
      break;
    case "stop":
      running = false;
      paused = false;
      elapsed = 0;
      state = { ...state, gcode_state: "IDLE", mc_percent: 0, layer_num: 0, mc_remaining_time: 0 };
      break;
    case "print_speed":
      state.spd_lvl = Number(print.param ?? 2);
      state.spd_mag =
        ({ 1: 50, 2: 100, 3: 124, 4: 166 } as Record<number, number>)[Number(state.spd_lvl)] ?? 100;
      break;
    case "gcode_line": {
      const gcode = String(print.param ?? "");
      const nozzle = /M104 S(\d+)/.exec(gcode);
      const bed = /M140 S(\d+)/.exec(gcode);
      if (nozzle) state.nozzle_target_temper = Number(nozzle[1]);
      if (bed) state.bed_target_temper = Number(bed[1]);
      break;
    }
    case "project_file":
      running = true;
      paused = false;
      elapsed = 0;
      state.subtask_name = String(print.subtask_name ?? "New print");
      break;
    default:
      break;
  }
  log(`Accepted "${command}".`);
  sendTo(client, { print: { command, sequence_id: print.sequence_id ?? "0", result: "success" } });
  broadcast(fullReport());
}

function handlePackets(client: Client): void {
  for (;;) {
    const buffer = client.buffer;
    if (buffer.length < 2) return;
    let multiplier = 1;
    let length = 0;
    let cursor = 1;
    let complete = false;
    while (cursor < buffer.length && cursor <= 4) {
      const byte = buffer[cursor]!;
      cursor += 1;
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || cursor + length > buffer.length) return;
    const type = buffer[0]! & 0xf0;
    const body = buffer.subarray(cursor, cursor + length);
    client.buffer = buffer.subarray(cursor + length);

    if (type === 0x10) {
      // CONNECT: skip protocol name, level, flags and keep-alive, then read the payload strings.
      let offset = 2 + body.readUInt16BE(0) + 4;
      const readString = () => {
        const size = body.readUInt16BE(offset);
        const value = body.subarray(offset + 2, offset + 2 + size).toString("utf8");
        offset += 2 + size;
        return value;
      };
      readString(); // client id
      const username = readString();
      const password = readString();
      const ok = username === "bblp" && password === ACCESS_CODE;
      client.socket.write(Buffer.from([0x20, 0x02, 0x00, ok ? 0x00 : 0x05]));
      if (!ok) {
        log("Rejected a client with the wrong access code.");
        client.socket.end();
        return;
      }
      client.authenticated = true;
      log("Client connected.");
    } else if (type === 0x80) {
      const packetId = body.readUInt16BE(0);
      const topic = body.subarray(4, 4 + body.readUInt16BE(2)).toString("utf8");
      client.subscribed = client.subscribed || topic === reportTopic;
      client.socket.write(Buffer.from([0x90, 0x03, packetId >> 8, packetId & 0xff, 0x00]));
    } else if (type === 0x30) {
      const topicLength = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLength).toString("utf8");
      if (topic !== requestTopic) continue;
      try {
        handleRequest(client, JSON.parse(body.subarray(2 + topicLength).toString("utf8")) as Json);
      } catch (error) {
        log(`Bad request: ${String(error)}`);
      }
    } else if (type === 0xc0) {
      client.socket.write(Buffer.from([0xd0, 0x00]));
    } else if (type === 0xe0) {
      client.socket.end();
      return;
    }
  }
}

function loadFrames(): Buffer[] {
  try {
    return NodeFS.readdirSync(FRAMES_DIR)
      .filter((name) => /\.jpe?g$/i.test(name))
      .sort()
      .map((name) => NodeFS.readFileSync(NodePath.join(FRAMES_DIR, name)));
  } catch {
    return [];
  }
}

const tls = ensureCertificates();
const frames = loadFrames();

NodeTls.createServer({ key: tls.key, cert: tls.cert }, (socket) => {
  const client: Client = {
    socket,
    authenticated: false,
    subscribed: false,
    buffer: Buffer.alloc(0),
  };
  clients.add(client);
  socket.on("data", (chunk: Buffer) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    handlePackets(client);
  });
  socket.on("error", () => undefined);
  socket.on("close", () => clients.delete(client));
}).listen(MQTT_PORT, HOST, () => log(`MQTT on ${HOST}:${MQTT_PORT}, serial ${SERIAL}`));

NodeTls.createServer({ key: tls.key, cert: tls.cert }, (socket) => {
  let login = Buffer.alloc(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  let index = 0;
  socket.on("data", (chunk: Buffer) => {
    if (timer) return;
    login = Buffer.concat([login, chunk]);
    if (login.length < 80) return;
    const user = login.subarray(16, 48).toString("ascii").replace(/\0+$/, "");
    const code = login.subarray(48, 80).toString("ascii").replace(/\0+$/, "");
    if (user !== "bblp" || code !== ACCESS_CODE || frames.length === 0) {
      socket.end();
      return;
    }
    const send = () => {
      const frame = frames[index % frames.length]!;
      index += 1;
      const header = Buffer.alloc(16);
      header.writeUInt32LE(frame.length, 0);
      header.writeUInt32LE(1, 8);
      socket.write(header);
      socket.write(frame);
    };
    send();
    timer = setInterval(send, 1_000);
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    if (timer) clearInterval(timer);
  });
}).listen(CAMERA_PORT, HOST, () =>
  log(`Camera on ${HOST}:${CAMERA_PORT} with ${frames.length} frame(s) from ${FRAMES_DIR}`),
);

setInterval(() => broadcast({ print: { command: "push_status", ...tick() } }), 1_000);

process.on("SIGUSR1", () => {
  developerMode = !developerMode;
  log(`Developer mode ${developerMode ? "on" : "off"}.`);
  broadcast(fullReport());
});

log(
  `Developer mode ${developerMode ? "on" : "off"}. Trust ${tls.caPath} by copying it into <T3 home>/printer-certs/.`,
);
