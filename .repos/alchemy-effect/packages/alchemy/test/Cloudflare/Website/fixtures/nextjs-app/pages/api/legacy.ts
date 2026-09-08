import type { NextApiRequest, NextApiResponse } from "next";

// Pages Router API route coexisting with the App Router.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ legacy: "pages-api" });
}
