import { type ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as Settings from "../serverSettings.ts";

export const findOrphanedProjectIds = (
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  liveProjectIds: ReadonlySet<ProjectId>,
): ReadonlyArray<ProjectId> =>
  Object.keys(settings.projectSettingsOverrides)
    .filter((key) => !Settings.isRepositoryOverrideKey(key))
    .map((projectId) => projectId as ProjectId)
    .filter((projectId) => !liveProjectIds.has(projectId));

export const sweep = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const settings = yield* serverSettings.getSettings;
  const liveShells = yield* projectStore.listShells();
  const liveProjectIds = new Set(liveShells.map((shell) => shell.id));

  const orphanedProjectIds = findOrphanedProjectIds(settings, liveProjectIds);
  if (orphanedProjectIds.length === 0) return;

  yield* serverSettings.updateSettings({
    projectSettingsOverrides: Object.fromEntries(
      orphanedProjectIds.map((projectId) => [projectId, null]),
    ),
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
