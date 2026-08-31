// Core of the T3 mobile P2P worklet. Runs under Bare inside
// react-native-bare-kit; `ipc` is a duplex stream carrying the line-delimited
// JSON contract in ../protocol.ts. Bundled by `scripts/build-p2p-worklet.mjs`
// (bare-pack), never imported from React Native code directly.
//
// One DHT node per bootstrap list, one loopback TCP listener per dialed
// environment. Each inbound TCP connection opens a fresh Noise stream to the
// environment's public key, so transient DHT drops self-heal per-connection
// (the same shape as the desktop dialer in @t3tools/p2p).
//
// Dial waits for a successful DHT probe before advertising the loopback port,
// so the RN side does not race ahead into /.well-known against a tunnel that
// cannot yet reach the peer (which otherwise surfaces as a generic HTTP timeout).
import DHT from "hyperdht";
import tcp from "bare-tcp";
import z32 from "z32";
import b4a from "b4a";

const DHT_PROBE_TIMEOUT_MS = 30_000;

export function runP2pWorklet(ipc) {
  const tunnels = new Map();
  const dhtNodes = new Map();

  const send = (message) => {
    // BareKit IPC expects bytes on both ends of the bridge.
    ipc.write(b4a.from(`${JSON.stringify(message)}\n`));
  };

  const dhtFor = (bootstrapKey, bootstrap) => {
    let node = dhtNodes.get(bootstrapKey);
    if (node === undefined) {
      node = new DHT({
        ephemeral: true,
        ...(bootstrap.length > 0 ? { bootstrap } : {}),
      });
      dhtNodes.set(bootstrapKey, node);
    }
    return node;
  };

  const closeTunnel = (publicKeyZ32) => {
    const tunnel = tunnels.get(publicKeyZ32);
    if (tunnel === undefined) {
      return false;
    }
    tunnels.delete(publicKeyZ32);
    tunnel.listener.close();
    return true;
  };

  const probeDht = (dht, publicKey) =>
    new Promise((resolve, reject) => {
      const stream = dht.connect(publicKey);
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error("timed out reaching the peer on the DHT"));
      }, DHT_PROBE_TIMEOUT_MS);
      const finish = (error) => {
        clearTimeout(timer);
        stream.removeListener("open", onOpen);
        stream.removeListener("error", onError);
        stream.destroy();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = (error) => finish(error || new Error("DHT connect failed"));
      stream.once("open", onOpen);
      stream.once("error", onError);
    });

  const handleDial = async (message) => {
    const { id, publicKeyZ32 } = message;
    const bootstrap = Array.isArray(message.bootstrap)
      ? message.bootstrap.flatMap((entry) => {
          const separator = entry.lastIndexOf(":");
          if (separator <= 0) {
            return [];
          }
          const port = Number(entry.slice(separator + 1));
          return Number.isInteger(port) && port > 0
            ? [{ host: entry.slice(0, separator), port }]
            : [];
        })
      : [];
    const bootstrapKey = bootstrap.map((node) => `${node.host}:${node.port}`).join(",");

    const existing = tunnels.get(publicKeyZ32);
    if (existing !== undefined && existing.bootstrapKey === bootstrapKey) {
      send({ type: "listening", id, publicKeyZ32, port: existing.port });
      return;
    }
    if (existing !== undefined) {
      closeTunnel(publicKeyZ32);
    }

    let publicKey;
    try {
      publicKey = z32.decode(publicKeyZ32);
    } catch {
      send({ type: "dial-error", id, publicKeyZ32, message: "invalid public key" });
      return;
    }

    const dht = dhtFor(bootstrapKey, bootstrap);
    try {
      await dht.ready();
      await probeDht(dht, publicKey);
    } catch (error) {
      send({
        type: "dial-error",
        id,
        publicKeyZ32,
        message: (error && error.message) || "Could not reach the peer on the DHT",
      });
      return;
    }

    const listener = tcp.createServer((socket) => {
      const stream = dht.connect(publicKey);
      socket.pipe(stream).pipe(socket);
      const destroyBoth = () => {
        socket.destroy();
        stream.destroy();
      };
      socket.on("close", destroyBoth);
      stream.on("close", destroyBoth);
      socket.on("error", () => {});
      stream.on("error", () => {});
    });
    listener.on("error", (error) => {
      tunnels.delete(publicKeyZ32);
      send({
        type: "dial-error",
        id,
        publicKeyZ32,
        message: (error && error.message) || "listener failed",
      });
    });
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      tunnels.set(publicKeyZ32, { listener, bootstrapKey, port });
      send({ type: "listening", id, publicKeyZ32, port });
    });
  };

  let buffered = "";
  ipc.on("data", (chunk) => {
    buffered += typeof chunk === "string" ? chunk : b4a.toString(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "dial" && typeof message.publicKeyZ32 === "string") {
        void handleDial(message);
      } else if (message.type === "close" && typeof message.publicKeyZ32 === "string") {
        const closed = closeTunnel(message.publicKeyZ32);
        send({ type: "closed", id: message.id, publicKeyZ32: message.publicKeyZ32, closed });
      }
    }
  });

  ipc.on("close", () => {
    for (const publicKeyZ32 of tunnels.keys()) {
      closeTunnel(publicKeyZ32);
    }
    for (const node of dhtNodes.values()) {
      node.destroy().catch(() => {});
    }
    dhtNodes.clear();
  });
}
