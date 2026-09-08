import mysql2 from "mysql2";

interface Env {
  DATABASE_URL: string;
}

export default {
  fetch(_request: Request, env: Env) {
    const db = mysql2.createConnection(env.DATABASE_URL);
    const result = db.execute("SELECT 1");
    return Response.json(result);
  },
};
