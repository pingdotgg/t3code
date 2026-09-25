import type { ReactNode } from "react";

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <title>Waku Fixture</title>
      </head>
      <body>
        <span data-testid="root-marker">ROOT_MARKER</span>
        {children}
      </body>
    </html>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
