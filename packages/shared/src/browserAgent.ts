export const BROWSER_AGENT_AUTO_PAIR_PATH = "/browser-agent/auto-pair";
export const BROWSER_AGENT_EXTENSION_DOWNLOADS_DIR = "downloads";
export const BROWSER_AGENT_EXTENSION_DOWNLOAD_FILENAME = "t3-code-browser-agent.crx";
export const BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH = `/${BROWSER_AGENT_EXTENSION_DOWNLOADS_DIR}/${BROWSER_AGENT_EXTENSION_DOWNLOAD_FILENAME}`;
export const BROWSER_AGENT_EXTENSION_PACKAGE_FILENAMES = [
  BROWSER_AGENT_EXTENSION_DOWNLOAD_FILENAME,
  "chrome-extension.crx",
  "chrome-extension.zip",
] as const;
export const BROWSER_AGENT_EXTENSION_REPO_PACKAGE_RELATIVE_PATHS = [
  "apps/chrome-extension.crx",
  "apps/chrome-extension.zip",
] as const;
