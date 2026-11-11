/** @jsxImportSource react */
import type { ReactNode } from "react";

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <title>Alchemy Waku AWS Fixture</title>
      </head>
      <body>{children}</body>
    </html>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
