import m0000 from "./20240101000000_init/migration.sql";
import m0001 from "./20240102000000_posts/migration.sql";

export default {
  migrations: {
    "20240101000000_init": m0000,
    "20240102000000_posts": m0001,
  },
};
