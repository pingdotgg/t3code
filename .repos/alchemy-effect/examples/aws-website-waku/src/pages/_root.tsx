import type { ReactNode } from "react";

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <title>Waku on AWS</title>
      </head>
      <body className="bg-slate-50 p-8 text-slate-900">{children}</body>
    </html>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
