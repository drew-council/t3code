import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { type ProcessRunOptions, type ProcessRunResult } from "../../processRunner.ts";
import { ProjectRuntimeEnvironment } from "../Services/ProjectRuntimeEnvironment.ts";
import { makeProjectRuntimeEnvironment } from "./ProjectRuntimeEnvironment.ts";

type CommandCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: ProcessRunOptions;
};

type FakeRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-runtime-env-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const absolutePath = pathService.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(pathService.dirname(absolutePath), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

function success(stdout: string, stderr = ""): ProcessRunResult {
  return {
    stdout,
    stderr,
    code: 0,
    signal: null,
    timedOut: false,
  };
}

function fakeRunner(
  handler: (call: CommandCall) => ProcessRunResult | Error,
  calls: CommandCall[],
): FakeRunner {
  return async (command, args, options) => {
    const call = {
      command,
      args,
      ...(options ? { options } : {}),
    };
    calls.push(call);
    const result = handler(call);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
}

function makeResolverLayer(run: FakeRunner, env: NodeJS.ProcessEnv = process.env) {
  return Layer.effect(
    ProjectRuntimeEnvironment,
    makeProjectRuntimeEnvironment({
      run,
      env,
      platform: "linux",
    }),
  );
}

it.layer(NodeServices.layer)("ProjectRuntimeEnvironmentLive", (it) => {
  describe("resolveForCwd", () => {
    it.effect("returns the ambient environment when no direnv file exists", () => {
      const calls: CommandCall[] = [];
      const layer = makeResolverLayer(
        fakeRunner(() => new Error("runner should not be called"), calls),
        { PATH: "/bin" },
      );
      return Effect.gen(function* () {
        const resolver = yield* ProjectRuntimeEnvironment;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolveForCwd(cwd);

        expect(resolved).toEqual({
          env: { PATH: "/bin" },
          mode: "ambient",
        });
        expect(calls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns a direnv environment when direnv exec succeeds", () => {
      const calls: CommandCall[] = [];
      const layer = makeResolverLayer(
        fakeRunner(({ command, args }) => {
          expect(command).toBe("direnv");
          expect(args[0]).toBe("exec");
          return success(JSON.stringify({ PATH: "/direnv/bin", IN_NIX_SHELL: "impure" }));
        }, calls),
        { PATH: "/ambient/bin" },
      );
      return Effect.gen(function* () {
        const resolver = yield* ProjectRuntimeEnvironment;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".envrc", "use flake\n");

        const resolved = yield* resolver.resolveForCwd(cwd);

        expect(resolved.mode).toBe("direnv");
        expect(resolved.env.PATH).toBe("/direnv/bin");
        expect(resolved.env.IN_NIX_SHELL).toBe("impure");
        expect(resolved.rcPath).toBe(path.join(cwd, ".envrc"));
        expect(calls).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back with a warning when direnv is unavailable", () => {
      const calls: CommandCall[] = [];
      const layer = makeResolverLayer(
        fakeRunner(() => new Error("Command not found: direnv"), calls),
        { PATH: "/ambient/bin" },
      );
      return Effect.gen(function* () {
        const resolver = yield* ProjectRuntimeEnvironment;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".envrc", "export FOO=bar\n");

        const resolved = yield* resolver.resolveForCwd(cwd);

        expect(resolved.mode).toBe("ambient");
        expect(resolved.env.PATH).toBe("/ambient/bin");
        expect(resolved.warning).toContain("direnv is not installed or not on PATH");
        expect(calls).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back with a warning when direnv activation fails", () => {
      const calls: CommandCall[] = [];
      const layer = makeResolverLayer(
        fakeRunner(() => new Error("direnv execution failed: broken flake"), calls),
        { PATH: "/ambient/bin" },
      );
      return Effect.gen(function* () {
        const resolver = yield* ProjectRuntimeEnvironment;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".envrc", "use flake\n");

        const resolved = yield* resolver.resolveForCwd(cwd);

        expect(resolved.mode).toBe("ambient");
        expect(resolved.warning).toContain("broken flake");
        expect(resolved.rcPath).toBe(path.join(cwd, ".envrc"));
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "auto-allows same-repo worktrees when a sibling path is already direnv-usable",
      () => {
        const calls: CommandCall[] = [];
        return Effect.gen(function* () {
          const workspaceRoot = yield* makeTempDir;
          const mainRepo = path.join(workspaceRoot, "repo");
          const featureWorktree = path.join(workspaceRoot, "feature-worktree");
          yield* writeTextFile(mainRepo, ".envrc", "use flake\n");
          yield* writeTextFile(featureWorktree, ".envrc", "use flake\n");

          const layer = makeResolverLayer(
            fakeRunner(({ command, args, options }) => {
              if (
                command === "direnv" &&
                args[0] === "exec" &&
                args[1] === featureWorktree &&
                !calls.some(
                  (call) =>
                    call.command === "direnv" &&
                    call.args[0] === "allow" &&
                    call.args[1] === featureWorktree,
                )
              ) {
                return new Error("direnv: .envrc is not allowed. Run `direnv allow`.");
              }

              if (command === "git" && args.join(" ") === "rev-parse --git-common-dir") {
                return success("../.git");
              }

              if (command === "git" && args.join(" ") === "worktree list --porcelain") {
                return success(`worktree ${mainRepo}\nHEAD abc\nbranch refs/heads/main\n`);
              }

              if (command === "direnv" && args[0] === "exec" && args[1] === mainRepo) {
                return success(JSON.stringify({ PATH: "/sibling/bin", IN_NIX_SHELL: "impure" }));
              }

              if (command === "direnv" && args[0] === "allow") {
                expect(args[1]).toBe(featureWorktree);
                return success("");
              }

              if (command === "direnv" && args[0] === "exec" && args[1] === featureWorktree) {
                expect(options?.cwd).toBe(featureWorktree);
                return success(JSON.stringify({ PATH: "/feature/bin", IN_NIX_SHELL: "impure" }));
              }

              return new Error(`Unhandled command: ${command} ${args.join(" ")}`);
            }, calls),
            { PATH: "/ambient/bin" },
          );

          const resolver = yield* Effect.service(ProjectRuntimeEnvironment).pipe(
            Effect.provide(layer),
          );
          const resolved = yield* resolver.resolveForCwd(featureWorktree);

          expect(resolved.mode).toBe("direnv");
          expect(resolved.env.PATH).toBe("/feature/bin");
          expect(resolved.autoAllowedWorktree).toBe(true);
          expect(
            calls.some(
              (call) =>
                call.command === "direnv" &&
                call.args[0] === "allow" &&
                call.args[1] === featureWorktree,
            ),
          ).toBe(true);
        });
      },
    );

    it.effect(
      "falls back when a same-repo worktree is not allowed and no sibling path is direnv-usable",
      () => {
        const calls: CommandCall[] = [];
        return Effect.gen(function* () {
          const workspaceRoot = yield* makeTempDir;
          const mainRepo = path.join(workspaceRoot, "repo");
          const featureWorktree = path.join(workspaceRoot, "feature-worktree");
          yield* writeTextFile(mainRepo, ".envrc", "use flake\n");
          yield* writeTextFile(featureWorktree, ".envrc", "use flake\n");

          const layer = makeResolverLayer(
            fakeRunner(({ command, args }) => {
              if (command === "direnv" && args[0] === "exec" && args[1] === featureWorktree) {
                return new Error("direnv: .envrc is not allowed. Run `direnv allow`.");
              }

              if (command === "git" && args.join(" ") === "rev-parse --git-common-dir") {
                return success("../.git");
              }

              if (command === "git" && args.join(" ") === "worktree list --porcelain") {
                return success(`worktree ${mainRepo}\nHEAD abc\nbranch refs/heads/main\n`);
              }

              if (command === "direnv" && args[0] === "exec" && args[1] === mainRepo) {
                return new Error("direnv: .envrc is not allowed. Run `direnv allow`.");
              }

              return new Error(`Unhandled command: ${command} ${args.join(" ")}`);
            }, calls),
            { PATH: "/ambient/bin" },
          );

          const resolver = yield* Effect.service(ProjectRuntimeEnvironment).pipe(
            Effect.provide(layer),
          );
          const resolved = yield* resolver.resolveForCwd(featureWorktree);

          expect(resolved.mode).toBe("ambient");
          expect(resolved.autoAllowedWorktree).toBeUndefined();
          expect(resolved.warning).toContain("the direnv file is not allowed");
          expect(calls.some((call) => call.command === "direnv" && call.args[0] === "allow")).toBe(
            false,
          );
        });
      },
    );
  });
});
