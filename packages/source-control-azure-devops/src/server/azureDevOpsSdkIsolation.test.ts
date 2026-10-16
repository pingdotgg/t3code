import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

it.layer(NodeServices.layer)("Azure SDK import isolation", (it) => {
  it.effect(
    "ignores checkout and PYTHONPATH modules while discovering the installed extension",
    (context) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const available = yield* spawner
            .string(ChildProcess.make("python3", ["-I", "--version"]))
            .pipe(Effect.option);
          if (Option.isNone(available)) return context.skip("python3 is unavailable");
          const directory = yield* fs.makeTempDirectoryScoped();
          const runtime = path.join(directory, "runtime");
          yield* spawner.string(
            ChildProcess.make("python3", ["-I", "-m", "venv", "--without-pip", runtime]),
          );
          const unixPython = path.join(runtime, "bin", "python");
          const python = (yield* fs.exists(unixPython))
            ? unixPython
            : path.join(runtime, "Scripts", "python.exe");
          const site = (yield* spawner.string(
            ChildProcess.make(python, [
              "-I",
              "-c",
              "import sysconfig;print(sysconfig.get_path('purelib'))",
            ]),
          )).trim();
          const extension = path.join(directory, "extension");
          const workspace = path.join(directory, "workspace");
          const environment = path.join(directory, "environment");
          const marker = path.join(directory, "injected");
          const write = (name: string, content: string) =>
            fs
              .makeDirectory(path.dirname(name), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(name, content)));
          for (const name of ["azure", "azure/cli", "azure/cli/core/extension"])
            yield* write(path.join(site, name, "__init__.py"), "");
          yield* write(
            path.join(site, "azure/cli/core/__init__.py"),
            "def get_default_cli(): pass\n",
          );
          yield* write(
            path.join(site, "azure/cli/core/extension/__init__.py"),
            `from types import SimpleNamespace\ndef get_extension(name):\n    assert name == 'azure-devops'\n    return SimpleNamespace(path=${JSON.stringify(extension)})\n`,
          );
          for (const name of ["azext_devops", "azext_devops/dev", "azext_devops/dev/common"])
            yield* write(path.join(extension, name, "__init__.py"), "");
          yield* write(
            path.join(extension, "azext_devops/dev/common/services.py"),
            "from types import SimpleNamespace\ndef resolve_instance(**kwargs): return 'https://dev.azure.com/example'\ndef get_connection_data(instance):\n    return SimpleNamespace(authenticated_user=SimpleNamespace(id='viewer',properties={'Account':{'$value':'reader@example.com'}},provider_display_name='Reader'))\n",
          );
          const injected = `open(${JSON.stringify(marker)},'w').write('executed')\nraise RuntimeError('untrusted module executed')\n`;
          yield* write(path.join(workspace, "json.py"), injected);
          yield* write(path.join(environment, "json.py"), injected);
          yield* write(path.join(environment, "sitecustomize.py"), injected);
          // Confirm the old startup executes each harmless payload before checking the isolated runner.
          for (const cwd of [workspace, directory]) {
            yield* spawner
              .string(
                ChildProcess.make(python, ["-c", "import json"], {
                  cwd,
                  env: { PYTHONPATH: cwd === workspace ? "" : environment },
                }),
              )
              .pipe(Effect.option);
            expect(yield* fs.exists(marker)).toBe(true);
            yield* fs.remove(marker);
          }
          const host = TestSourceControlHost.layer({
            process: {
              run: (input) =>
                (input.command === "az"
                  ? Effect.succeed(`Python location '${python}'`)
                  : spawner
                      .string(
                        ChildProcess.make(input.command, input.args, {
                          cwd: input.cwd,
                          env: { PYTHONPATH: environment },
                        }),
                      )
                      .pipe(Effect.orDie)
                ).pipe(
                  Effect.map((stdout) => ({
                    stdout,
                    stderr: "",
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  })),
                ),
            },
          });
          const cli = yield* AzureDevOpsCli.AzureDevOpsCli.pipe(
            Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(host))),
          );
          // The second call tests PYTHONPATH without a checkout module masking its effect.
          for (const cwd of [workspace, directory]) {
            expect(yield* cli.authenticatedIdentity({ cwd })).toEqual({
              id: "viewer",
              login: "reader@example.com",
              name: "Reader",
            });
            expect(yield* fs.exists(marker)).toBe(false);
          }
        }),
      ),
  );
});
