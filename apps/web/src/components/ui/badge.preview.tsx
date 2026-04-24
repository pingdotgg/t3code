import { definePreview } from "@forma/preview-react";

import "../../index.css";

import { Badge } from "./badge";

export default definePreview({
  label: "Badge",
  cases: {
    default: {
      label: "Status Set",
      render: () => (
        <div className="flex max-w-3xl flex-wrap items-center justify-center gap-3">
          <Badge variant="default">Live</Badge>
          <Badge variant="secondary">Queued</Badge>
          <Badge variant="info">Preview</Badge>
          <Badge variant="success">Healthy</Badge>
          <Badge variant="warning">Needs review</Badge>
          <Badge variant="error">Blocked</Badge>
        </div>
      ),
    },
    outline: {
      render: () => <Badge variant="outline">Detached</Badge>,
    },
    large: {
      render: () => (
        <Badge size="lg" variant="info">
          Syncing workspace
        </Badge>
      ),
    },
  },
});
