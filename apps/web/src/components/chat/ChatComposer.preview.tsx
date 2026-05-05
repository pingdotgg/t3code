import { defineComponentPreview } from "../../../../../.forma/preview/config.ts";

export default defineComponentPreview({
  component: "./ChatComposer.preview.mocks.ts",
  componentExport: "default",
  scenarios: [
    {
      id: "default",
      name: "Default",
      args: {
        variant: "default",
        resolvedTheme: "light",
      },
      env: {
        pathname: "/preview/chat-composer/default",
        searchParams: {},
      },
    },
    {
      id: "slash-command-menu",
      name: "Slash Command Menu",
      args: {
        variant: "slash-command-menu",
        resolvedTheme: "light",
      },
      env: {
        pathname: "/preview/chat-composer/slash-command-menu",
        searchParams: {},
      },
    },
    {
      id: "plan-follow-up",
      name: "Plan Follow-up",
      args: {
        variant: "plan-follow-up",
        resolvedTheme: "dark",
      },
      env: {
        pathname: "/preview/chat-composer/plan-follow-up",
        searchParams: {},
      },
    },
    {
      id: "pending-approval",
      name: "Pending Approval",
      args: {
        variant: "pending-approval",
        resolvedTheme: "light",
      },
      env: {
        pathname: "/preview/chat-composer/pending-approval",
        searchParams: {},
      },
    },
    {
      id: "pending-user-input",
      name: "Pending User Input",
      args: {
        variant: "pending-user-input",
        resolvedTheme: "light",
      },
      env: {
        pathname: "/preview/chat-composer/pending-user-input",
        searchParams: {},
      },
    },
  ],
  controls: [
    {
      name: "variant",
      label: "State",
      type: "select",
      options: [
        { label: "Default", value: "default" },
        { label: "Slash Command Menu", value: "slash-command-menu" },
        { label: "Plan Follow-up", value: "plan-follow-up" },
        { label: "Pending Approval", value: "pending-approval" },
        { label: "Pending User Input", value: "pending-user-input" },
      ],
      defaultValue: "default",
    },
    {
      name: "resolvedTheme",
      label: "Component Theme",
      type: "inline-radio",
      options: [
        { label: "Light", value: "light" },
        { label: "Dark", value: "dark" },
      ],
      defaultValue: "light",
    },
  ],
  moduleMocks: {},
});
