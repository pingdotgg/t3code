import * as Dialog from "../../components/ui/Dialog";

/** Asks for a manifest folder on the host, as a path that may start with `~`. */
export function promptManifestFolder(hostLabel: string, onAdd: (folder: string) => void) {
  Dialog.prompt({
    title: "Add manifest folder",
    message: `A folder on ${hostLabel}, such as a repository with an agents folder. New Sandbox finds every agent.yaml and agent.<variant>.yaml in it.`,
    placeholder: "~/code/agents",
    initialValue: "",
    confirmText: "Add",
    onConfirm: (value) => {
      const folder = value.trim();
      if (folder !== "") onAdd(folder);
    },
  });
}
