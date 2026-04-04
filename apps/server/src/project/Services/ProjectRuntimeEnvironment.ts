import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectRuntimeEnvironmentResolution {
  readonly env: NodeJS.ProcessEnv;
  readonly mode: "ambient" | "direnv";
  readonly rcPath?: string;
  readonly warning?: string;
  readonly autoAllowedWorktree?: boolean;
}

export interface ProjectRuntimeEnvironmentShape {
  readonly resolveForCwd: (
    cwd: string,
  ) => Effect.Effect<ProjectRuntimeEnvironmentResolution, never>;
}

export class ProjectRuntimeEnvironment extends Context.Service<
  ProjectRuntimeEnvironment,
  ProjectRuntimeEnvironmentShape
>()("t3/project/ProjectRuntimeEnvironment") {}
