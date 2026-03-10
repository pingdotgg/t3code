import { fileURLToPath } from "node:url";
import { Image } from "@daytonaio/sdk";

export const JEVIN_AI_SNAPSHOT_NAME = "jevin-ai";
export const JEVIN_AI_SNAPSHOT_USER = "daytona";
export const JEVIN_AI_CODEX_VERSION = "0.111.0";
const JEVIN_AI_ZSHRC_PATH = fileURLToPath(new URL("./jevin-ai.zshrc", import.meta.url));

export function createJevinAiSnapshotImage() {
  return Image.base("ubuntu:24.04")
    .addLocalFile(JEVIN_AI_ZSHRC_PATH, `/home/${JEVIN_AI_SNAPSHOT_USER}/.zshrc`)
    .runCommands(
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl wget git jq unzip zip ripgrep fd-find zsh zsh-autosuggestions zsh-syntax-highlighting fzf bat less vim-tiny procps build-essential python3 python3-pip python3-venv openssh-client sudo xz-utils gnupg",
      "mkdir -p /etc/apt/keyrings",
      "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
      'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs",
      "npm install -g pnpm",
      `npm install -g @openai/codex@${JEVIN_AI_CODEX_VERSION}`,
      "curl -fsSL https://bun.sh/install | bash",
      "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
      "ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx",
      "ln -sf /usr/bin/fdfind /usr/local/bin/fd",
      "ln -sf /usr/bin/batcat /usr/local/bin/bat",
      `useradd -m -s /usr/bin/zsh ${JEVIN_AI_SNAPSHOT_USER}`,
      `echo "${JEVIN_AI_SNAPSHOT_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/91-${JEVIN_AI_SNAPSHOT_USER}`,
      `mkdir -p /workspace && chown -R ${JEVIN_AI_SNAPSHOT_USER}:${JEVIN_AI_SNAPSHOT_USER} /workspace /home/${JEVIN_AI_SNAPSHOT_USER}`,
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
    )
    .dockerfileCommands([`USER ${JEVIN_AI_SNAPSHOT_USER}`])
    .workdir("/workspace")
    .env({
      HOME: `/home/${JEVIN_AI_SNAPSHOT_USER}`,
      USER: JEVIN_AI_SNAPSHOT_USER,
      ZDOTDIR: `/home/${JEVIN_AI_SNAPSHOT_USER}`,
      SHELL: "/usr/bin/zsh",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    })
    .cmd(["/usr/bin/zsh"]);
}
