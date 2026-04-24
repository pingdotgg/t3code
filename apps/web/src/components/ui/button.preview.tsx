import { definePreview } from "@forma/preview-react";

import "../../index.css";

import { Button } from "./button";

export default definePreview({
  cases: {
    default: {
      render: () => <Button>Save changes</Button>,
    },
    secondary: {
      render: () => <Button variant="secondary">Duplicate</Button>,
    },
    destructive: {
      render: () => <Button variant="destructive">Delete</Button>,
    },
    disabled: {
      render: () => <Button disabled>Disabled</Button>,
    },
  },
});
