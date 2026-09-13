import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const DEFAULT_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINxKqNPbcpc0Hl9QguQ/M5OU1xk9YiNOtfeywcHiBu6d alchemy-hetzner-server-example";

export default Alchemy.Stack(
  "HetznerServerExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const publicKey = yield* Config.string("SSH_PUBLIC_KEY").pipe(
      Config.withDefault(DEFAULT_PUBLIC_KEY),
    );
    const key = yield* Hetzner.SshKey("deploy", { publicKey });
    const server = yield* Hetzner.Server("box", {
      serverType: "cx22",
      image: "ubuntu-24.04",
      location: "nbg1",
      sshKeys: [key],
    });

    return {
      ipv4: server.ipv4,
      ipv6: server.ipv6,
    };
  }),
);
