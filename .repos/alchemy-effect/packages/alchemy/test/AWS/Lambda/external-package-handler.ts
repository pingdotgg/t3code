import { v4 as uuid } from "uuid";

const handler = async () => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    id: uuid(),
  }),
});

export { handler };
export default handler;
