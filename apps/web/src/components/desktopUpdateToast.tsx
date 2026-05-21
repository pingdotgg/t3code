import { CircleCheckIcon } from "lucide-react";

export function createDesktopUpdateDownloadedToast() {
  return {
    type: "success" as const,
    title: "Update downloaded",
    description: "Restart the app from the update button to install it.",
    data: {
      leadingIcon: <CircleCheckIcon aria-hidden className="size-4 text-primary" />,
    },
  };
}
