import path from "node:path";

import { Data, Effect, FileSystem, Layer } from "effect";

import { type ProcessRunOptions, type ProcessRunResult, runProcess } from "../../processRunner.ts";
import {
  ProjectRuntimeEnvironment,
  type ProjectRuntimeEnvironmentResolution,
  type ProjectRuntimeEnvironmentShape,
} from "../Services/ProjectRuntimeEnvironment.ts";

type ProcessExecutor = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

interface ProjectRuntimeEnvironmentLiveOptions {
  readonly run?: ProcessExecutor;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

class ProjectRuntimeEnvironmentCommandError extends Data.TaggedError(
  "ProjectRuntimeEnvironmentCommandError",
)<{
  readonly message: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cause: unknown;
}> {}

class ProjectRuntimeEnvironmentParseError extends Data.TaggedError(
  "ProjectRuntimeEnvironmentParseError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DIR_ENV_CAPTURE_SCRIPT = "process.stdout.write(JSON.stringify(process.env));";

function sanitizeCapturedEnvironment(value: unknown): NodeJS.ProcessEnv | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, current] of Object.entries(value)) {
    if (typeof current === "string") {
      env[key] = current;
    }
  }
  return env;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function createWarning(input: { readonly rcPath?: string; readonly reason: string }): string {
  const rcSuffix = input.rcPath ? ` for ${input.rcPath}` : "";
  return `direnv activation failed${rcSuffix}; using ambient environment (${input.reason})`;
}

function parseGitWorktreePaths(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((line) => line.length > 0);
}

function isDirenvNotAllowedError(cause: unknown): boolean {
  const message =
    cause instanceof Error
      ? `${cause.message}\n${String((cause as { stderr?: unknown }).stderr ?? "")}`
      : String(cause);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not allowed") ||
    normalized.includes("run direnv allow") ||
    normalized.includes("run `direnv allow`") ||
    normalized.includes("is blocked")
  );
}

function isDirenvMissingError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.toLowerCase().includes("command not found: direnv");
}

export const makeProjectRuntimeEnvironment = Effect.fn("makeProjectRuntimeEnvironment")(function* (
  options?: ProjectRuntimeEnvironmentLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const ambientEnv = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const run = options?.run ?? runProcess;

  const runCommand = Effect.fn("ProjectRuntimeEnvironment.runCommand")(function* (
    command: string,
    args: readonly string[],
    runOptions?: ProcessRunOptions,
  ) {
    return yield* Effect.tryPromise({
      try: () => run(command, args, runOptions),
      catch: (cause) =>
        new ProjectRuntimeEnvironmentCommandError({
          message: cause instanceof Error ? cause.message : String(cause),
          command,
          args,
          cause,
        }),
    });
  });

  const exists = (candidatePath: string) =>
    fileSystem.exists(candidatePath).pipe(Effect.orElseSucceed(() => false));

  const findNearestRcPath = Effect.fn("ProjectRuntimeEnvironment.findNearestRcPath")(function* (
    cwd: string,
  ) {
    let current = path.resolve(cwd);

    while (true) {
      const envrcPath = path.join(current, ".envrc");
      if (yield* exists(envrcPath)) {
        return envrcPath;
      }

      const dotenvPath = path.join(current, ".env");
      if (yield* exists(dotenvPath)) {
        return dotenvPath;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  });

  const captureDirenvEnvironment = (cwd: string): Effect.Effect<NodeJS.ProcessEnv, Error> =>
    Effect.gen(function* () {
      const result = yield* runCommand(
        "direnv",
        ["exec", cwd, process.execPath, "-e", DIR_ENV_CAPTURE_SCRIPT],
        {
          cwd,
          env: ambientEnv,
        },
      );

      const parsed = yield* Effect.try({
        try: () => sanitizeCapturedEnvironment(JSON.parse(result.stdout)),
        catch: (cause) =>
          new ProjectRuntimeEnvironmentParseError({
            message: "Failed to parse direnv environment payload.",
            cause,
          }),
      });
      if (!parsed) {
        return yield* new ProjectRuntimeEnvironmentParseError({
          message: "direnv returned an invalid environment payload.",
        });
      }

      return parsed;
    });

  const maybeAutoAllowWorktree = Effect.fn("ProjectRuntimeEnvironment.maybeAutoAllowWorktree")(
    function* (cwd: string): Effect.fn.Return<boolean> {
      const gitCommonDirResult = yield* Effect.result(
        runCommand("git", ["rev-parse", "--git-common-dir"], {
          cwd,
          env: ambientEnv,
        }),
      );
      if (gitCommonDirResult._tag === "Failure") {
        return false;
      }

      const gitCommonDir = path.resolve(cwd, gitCommonDirResult.success.stdout.trim());
      if (gitCommonDir.length === 0) {
        return false;
      }

      const worktreeListResult = yield* Effect.result(
        runCommand("git", ["worktree", "list", "--porcelain"], {
          cwd,
          env: ambientEnv,
        }),
      );
      if (worktreeListResult._tag === "Failure") {
        return false;
      }

      const currentPath = path.resolve(cwd);
      const siblingWorktrees = parseGitWorktreePaths(worktreeListResult.success.stdout)
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => candidate !== currentPath);
      if (siblingWorktrees.length === 0) {
        return false;
      }

      for (const sibling of siblingWorktrees) {
        const siblingCommonDirResult = yield* Effect.result(
          runCommand("git", ["rev-parse", "--git-common-dir"], {
            cwd: sibling,
            env: ambientEnv,
          }),
        );
        if (siblingCommonDirResult._tag === "Failure") {
          continue;
        }
        const siblingCommonDir = path.resolve(
          sibling,
          siblingCommonDirResult.success.stdout.trim(),
        );
        if (siblingCommonDir !== gitCommonDir) {
          continue;
        }

        const siblingDirenvResult = yield* Effect.result(captureDirenvEnvironment(sibling));
        if (siblingDirenvResult._tag === "Success") {
          const allowResult = yield* Effect.result(
            runCommand("direnv", ["allow", cwd], {
              env: ambientEnv,
            }),
          );
          return allowResult._tag === "Success";
        }
      }

      return false;
    },
  );

  const toAmbientResolution = (input: {
    readonly rcPath?: string;
    readonly reason: string;
    readonly autoAllowedWorktree?: boolean;
  }): ProjectRuntimeEnvironmentResolution => ({
    env: { ...ambientEnv },
    mode: "ambient",
    ...(input.rcPath ? { rcPath: input.rcPath } : {}),
    warning: createWarning(input),
    ...(input.autoAllowedWorktree ? { autoAllowedWorktree: true } : {}),
  });

  const resolveForCwd: ProjectRuntimeEnvironmentShape["resolveForCwd"] = Effect.fn(
    "ProjectRuntimeEnvironment.resolveForCwd",
  )(function* (cwd) {
    if (platform === "win32") {
      return {
        env: { ...ambientEnv },
        mode: "ambient",
      } satisfies ProjectRuntimeEnvironmentResolution;
    }

    const rcPath = yield* findNearestRcPath(cwd);
    if (!rcPath) {
      return {
        env: { ...ambientEnv },
        mode: "ambient",
      } satisfies ProjectRuntimeEnvironmentResolution;
    }

    const rcDir = path.dirname(rcPath);
    const firstAttempt = yield* Effect.result(captureDirenvEnvironment(cwd));
    if (firstAttempt._tag === "Success") {
      return {
        env: firstAttempt.success,
        mode: "direnv",
        rcPath,
      } satisfies ProjectRuntimeEnvironmentResolution;
    }

    if (isDirenvMissingError(firstAttempt.failure)) {
      return toAmbientResolution({
        rcPath,
        reason: "direnv is not installed or not on PATH",
      });
    }

    if (!isDirenvNotAllowedError(firstAttempt.failure)) {
      return toAmbientResolution({
        rcPath,
        reason:
          firstAttempt.failure instanceof Error
            ? (trimOrUndefined(firstAttempt.failure.message) ?? "direnv execution failed")
            : "direnv execution failed",
      });
    }

    const autoAllowedWorktree = yield* maybeAutoAllowWorktree(rcDir);

    if (autoAllowedWorktree) {
      const retryAttempt = yield* Effect.result(captureDirenvEnvironment(cwd));
      if (retryAttempt._tag === "Success") {
        return {
          env: retryAttempt.success,
          mode: "direnv",
          rcPath,
          autoAllowedWorktree: true,
        } satisfies ProjectRuntimeEnvironmentResolution;
      }

      return toAmbientResolution({
        rcPath,
        reason:
          retryAttempt.failure instanceof Error
            ? (trimOrUndefined(retryAttempt.failure.message) ?? "direnv execution failed")
            : "direnv execution failed",
        autoAllowedWorktree: true,
      });
    }

    return toAmbientResolution({
      rcPath,
      reason: "the direnv file is not allowed",
    });
  });

  return {
    resolveForCwd,
  } satisfies ProjectRuntimeEnvironmentShape;
});

export const ProjectRuntimeEnvironmentLive = Layer.effect(
  ProjectRuntimeEnvironment,
  makeProjectRuntimeEnvironment(),
);
