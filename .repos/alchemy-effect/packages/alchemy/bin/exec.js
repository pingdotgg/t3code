import { exec } from "alchemy/Cli/exec";
import { runMain } from "alchemy/Util/PlatformServices";

exec().pipe(runMain);
