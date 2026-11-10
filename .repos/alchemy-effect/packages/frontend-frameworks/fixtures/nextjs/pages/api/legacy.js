// Pages Router API route (node runtime req/res API).
export default function handler(req, res) {
  res.status(200).json({ legacy: "pages-api" });
}
