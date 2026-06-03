import { createFileRoute } from "@tanstack/react-router";

import { MobileMockups } from "../components/dev/MobileMockups";

export const Route = createFileRoute("/dev/mobile")({
  component: MobileMockups,
});
