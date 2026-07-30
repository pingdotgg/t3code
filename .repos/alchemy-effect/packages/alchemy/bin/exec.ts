import { exec } from "alchemy/Cli";
import { runMain } from "alchemy/Util/PlatformServices";

exec().pipe(runMain);
