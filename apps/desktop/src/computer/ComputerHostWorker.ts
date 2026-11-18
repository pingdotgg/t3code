// The computer-use helper as a forked child: the app's own grants attach to this process, and nothing in
// the main process loads the automation code in `@t3tools/computer-helper`.
import { runChild } from "@t3tools/computer-helper/child";

runChild();
