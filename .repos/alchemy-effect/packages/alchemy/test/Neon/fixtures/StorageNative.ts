import { AwsClient } from "aws4fetch";

export const signStorageRead = (config: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}) =>
  new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  }).sign(config.endpoint);

export default {
  async fetch(request: Request) {
    if (
      request.headers.get("authorization") !== `Bearer ${process.env.APP_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    const client = new AwsClient({
      region: process.env.AWS_REGION!,
      service: "s3",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    });
    const url = `${process.env.AWS_ENDPOINT_URL_S3!.replace(/\/$/, "")}/${encodeURIComponent(process.env.BUCKET_NAME!)}/native.txt`;
    if (new URL(request.url).pathname === "/presign") {
      const target = new URL(url);
      target.searchParams.set("X-Amz-Expires", "60");
      const signed = await client.sign(target, {
        method: "PUT",
        aws: { signQuery: true },
      });
      return Response.json({ url: signed.url });
    }
    if (request.method === "PUT")
      return client.fetch(url, {
        method: "PUT",
        body: await request.arrayBuffer(),
      });
    return client.fetch(url);
  },
};
