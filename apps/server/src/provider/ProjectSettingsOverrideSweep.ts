import * as NodeUtil from "node:util";

import { type ProjectId, type ProjectSettingsOverrides } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as Settings from "../serverSettings.ts";

export function deletedProjectOverridePatch(entry: ProjectSettingsOverrides | undefined) {
  // Keep cleanup policy for deleted threads; omitting providerInstances would preserve obsolete references in the merge.
  return entry?.worktreeCleanup !== undefined
    ? { worktreeCleanup: entry.worktreeCleanup, providerInstances: {} }
    : null;
}

export const sweep = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const settings = yield* serverSettings.getSettings;
  const projects = yield* projectStore.list({ includeDeleted: true });
  const projectsById = new Map<string, ProjectStore.ProjectRow>(
    projects.map((project) => [project.projectId, project]),
  );

  const overrides = Object.entries(settings.projectSettingsOverrides).flatMap(
    ([projectId, entry]) => {
      if (Settings.isRepositoryOverrideKey(projectId)) return [];
      const project = projectsById.get(projectId);
      if (project?.deletedAt === null) return [];
      const patch = project ? deletedProjectOverridePatch(entry) : null;
      if (NodeUtil.isDeepStrictEqual(entry, patch)) return [];
      return [[projectId, patch] as const];
    },
  );
  if (overrides.length === 0) return;

  yield* serverSettings.updateSettings({
    projectSettingsOverrides: Object.fromEntries(overrides),
  });
}).pipe(
  Effect.asVoid,
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to sweep orphaned project settings overrides.", cause),
  ),
);

/** Keeps the settings service's project to repository map current as identities resolve. */
export const syncRepositoryKeys = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const enrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const changes = yield* enrichment.subscribeChanges;

  const refresh = Effect.gen(function* () {
    const keys = new Map<ProjectId, string>();
    for (const shell of yield* projectStore.listShells()) {
      const { repositoryIdentity } = yield* enrichment.getAvailable(shell.workspaceRoot);
      if (repositoryIdentity !== null) keys.set(shell.id, repositoryIdentity.canonicalKey);
    }
    yield* serverSettings.setProjectRepositoryKeys(keys);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to map projects to repository settings overrides.", cause),
    ),
  );

  yield* refresh.pipe(
    Effect.andThen(Stream.fromSubscription(changes).pipe(Stream.runForEach(() => refresh))),
    Effect.forkScoped,
  );
});
