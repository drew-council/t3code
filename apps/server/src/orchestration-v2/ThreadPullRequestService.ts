import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "../sourceControl/threadPullRequests.ts";
import * as Orchestrator from "./Orchestrator.ts";

class ThreadPullRequestServiceV2 extends Context.Service<
  ThreadPullRequestServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadPullRequestService/ThreadPullRequestServiceV2") {}

function samePullRequest(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null,
): boolean {
  if (left == null || right === null) return left == null && right === null;
  return (
    left.projectId === right.projectId &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number &&
    left.url === right.url
  );
}

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: OrchestrationProjectShell,
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    sourceControlDefinitions.canonicalRepositoryKey(pullRequest.repositoryKey) ===
      sourceControlDefinitions.canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

const resolveProjectForPullRequestDiscovery = Effect.fn(
  "ThreadPullRequestServiceV2.resolveProject",
)(function* (
  project: OrchestrationProjectShell,
  repositoryIdentities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  options?: { readonly refresh?: boolean },
) {
  // Post-turn discovery refreshes 15-minute identity caches because agents may add remotes.
  const repositoryIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
    refresh: options?.refresh ?? false,
  });
  return {
    project: { ...project, repositoryIdentity },
    repository: sourceControlDefinitions.repositorySelector(repositoryIdentity),
  };
});

export function projectWorkspaceMatchesSnapshot(
  currentProject: Option.Option<Pick<OrchestrationProjectShell, "workspaceRoot">>,
  expectedWorkspaceRoot: string,
): boolean {
  return (
    Option.isSome(currentProject) && currentProject.value.workspaceRoot === expectedWorkspaceRoot
  );
}

const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
  /** Set when a run ends, so the saved branch catches up with checkouts made during it. */
  readonly followCheckout?: boolean;
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const pendingBackfill = new Map<ThreadId, number>();

  const finishBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const readThreadSnapshot = ({ threadId, backfill }: RefreshRequest) =>
    threadId === null
      ? orchestrator
          .getShellSnapshot({
            location: "active",
            unsettledOnly: !(backfill || pendingBackfill.size > 0),
          })
          .pipe(NodeSqliteClient.readOnly)
      : Effect.gen(function* () {
          // Read sequence first so guarded sync rejects intervening changes.
          const snapshotSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const thread = yield* orchestrator.getThreadShell(threadId);
          return { snapshotSequence, threads: thread === null ? [] : [thread] };
        });

  // gh stack and agents switch branches inside a worktree, which T3 never sees otherwise.
  const followCheckout = Effect.fn("ThreadPullRequestServiceV2.followCheckout")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    // A temporary branch is still owned by the launch rename.
    if (thread.worktreePath === null || thread.branch === null) return false;
    if (isTemporaryWorktreeBranch(thread.branch)) return false;
    yield* git.invalidateLocalStatus(thread.worktreePath);
    const local = yield* git.localStatus({ cwd: thread.worktreePath });
    // A detached HEAD mid-rebase has no name; keep the last branch until it lands.
    if (local.refName === null || local.isDefaultRef || local.refName === thread.branch) {
      return false;
    }
    const uuid = yield* crypto.randomUUIDv4();
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`server:thread-follow-checkout:${thread.id}:${uuid}`),
      threadId: thread.id,
      branch: local.refName,
      expectedBranch: thread.branch,
      expectedWorktreePath: thread.worktreePath,
    });
    return true;
  });

  // One linked layer is enough: stack sync links the rest of a native stack.
  const linkStackedBranchPullRequest = Effect.fn(
    "ThreadPullRequestServiceV2.linkStackedBranchPullRequest",
  )(function* (
    thread: OrchestrationV2ThreadShell,
    detected: GitManager.GitBranchPullRequest,
    projectId: OrchestrationProjectShell["id"],
  ) {
    if (thread.worktreePath === null || detected.state !== "open") return;
    // Tombstones count, so a layer the user unlinked stays unlinked.
    if ((thread.pullRequests ?? []).length > 0 || thread.linkedPullRequest != null) return;
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(detected.url);
    if (parsed === null) return;
    const key = normalizeThreadPullRequestKey(parsed.link);
    const stack = yield* pullRequests.stack({ projectId, ...key }, { includeDetails: false });
    if (stack === null) return;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make(
        `server:pr-branch-stack-link:${thread.id}:${threadPullRequestKeyOf(key)}`,
      ),
      threadId: thread.id,
      ...key,
      url: detected.url,
      source: "stack",
    });
  });

  const synchronize = Effect.fn("ThreadPullRequestServiceV2.synchronize")(function* (
    request: RefreshRequest,
  ) {
    const [threadSnapshot, projectShells] = yield* Effect.all([
      readThreadSnapshot(request),
      projectStore.listShells(),
    ]);
    // Subagent children refresh after their own runs; sweeping them costs a lookup each per minute.
    const snapshotThreads =
      request.threadId === null
        ? threadSnapshot.threads.filter(
            (thread) => thread.lineage.relationshipToParent !== "subagent",
          )
        : threadSnapshot.threads;
    if (request.followCheckout === true) {
      const moved = yield* Effect.forEach(snapshotThreads, (thread) =>
        followCheckout(thread).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread checkout follow failed", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
          ),
        ),
      );
      // The metadata update re-enqueues discovery for the new branch.
      if (moved.some(Boolean)) return;
    }
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshotThreads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    const visibleThreadIds = new Set(
      snapshotThreads.filter((thread) => thread.branch !== null).map((thread) => thread.id),
    );
    const checkedIds = request.threadId === null ? [...pendingBackfill.keys()] : [request.threadId];
    for (const threadId of checkedIds) {
      if (!visibleThreadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshotThreads.filter(
      (thread) =>
        thread.archivedAt === null &&
        ((thread.settledOverride !== "settled" && thread.settledAt === null) ||
          request.threadId !== null ||
          pendingBackfill.has(thread.id)) &&
        (thread.branch !== null || thread.branchPullRequest != null),
    );
    const groups = Map.groupBy(threads, (thread) =>
      JSON.stringify([thread.projectId, thread.worktreePath, thread.branch]),
    );

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const first = group[0]!;
          const project = projects.get(first.projectId);
          if (project === undefined) return finishBackfill(group);
          const { project: resolvedProject, repository } =
            yield* resolveProjectForPullRequestDiscovery(project, repositoryIdentities, {
              refresh: request.refresh,
            });
          if (first.branch !== null && repository === null) return finishBackfill(group);
          const worktreeExists =
            first.worktreePath !== null && (yield* fileSystem.exists(first.worktreePath));
          const cwd =
            worktreeExists && first.worktreePath !== null
              ? first.worktreePath
              : project.workspaceRoot;
          const detected =
            first.branch === null
              ? null
              : yield* git.branchPullRequest(
                  { cwd, branch: first.branch },
                  { refresh: request.refresh },
                );
          if (detected !== null && !pullRequestMatchesProject(detected, resolvedProject)) {
            return finishBackfill(group);
          }
          const detectedReference =
            detected !== null && repository !== null
              ? {
                  projectId: project.id,
                  repository,
                  number: detected.number,
                  url: detected.url,
                }
              : null;

          if (detected !== null) {
            yield* Effect.forEach(
              group,
              (thread) =>
                linkStackedBranchPullRequest(thread, detected, project.id).pipe(
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterruptsOnly(cause),
                    (cause) =>
                      Effect.logWarning("linking a stacked branch pull request failed", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                  ),
                ),
              { discard: true },
            );
          }

          const plans = yield* Effect.forEach(group, (thread) =>
            Effect.gen(function* () {
              let branchPullRequest = detectedReference;
              if (
                branchPullRequest === null &&
                thread.branch !== null &&
                thread.worktreePath === null &&
                thread.branchPullRequest != null
              ) {
                const previous = yield* pullRequests.summary(thread.branchPullRequest, {
                  recoverTransientFailure: false,
                });
                if (
                  previous.headBranch === thread.branch &&
                  (previous.state === "merged" || previous.state === "closed")
                ) {
                  branchPullRequest = thread.branchPullRequest;
                }
              }

              let replacement: ThreadLinkedPullRequest | undefined;
              if (
                (thread.pullRequests ?? []).length === 0 &&
                thread.linkedPullRequest != null &&
                detected?.state === "open" &&
                detectedReference !== null &&
                !samePullRequest(thread.linkedPullRequest, detectedReference)
              ) {
                const linked = yield* pullRequests.summary(thread.linkedPullRequest, {
                  recoverTransientFailure: false,
                });
                if (linked.state === "merged" || linked.state === "closed") {
                  replacement = detectedReference;
                }
              }
              if (
                samePullRequest(thread.branchPullRequest, branchPullRequest) &&
                replacement === undefined
              ) {
                pendingBackfill.delete(thread.id);
                return null;
              }
              return { thread, branchPullRequest, replacement };
            }).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("thread pull request discovery failed", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.tap(() => Effect.sync(() => failBackfill([thread]))),
                    Effect.as(null),
                  ),
              ),
            ),
          );
          const updates = plans.filter((plan) => plan !== null);
          if (updates.length === 0) return;

          if (detected !== null && first.branch !== null) {
            const current = yield* git.branchPullRequest(
              { cwd, branch: first.branch },
              { freshGitState: true },
            );
            const currentIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
              refresh: true,
            });
            if (
              current === null ||
              current.number !== detected.number ||
              current.url !== detected.url ||
              current.state !== detected.state ||
              current.repositoryKey !== detected.repositoryKey ||
              !pullRequestMatchesProject(current, {
                ...project,
                repositoryIdentity: currentIdentity,
              })
            ) {
              return failBackfill(updates.map((update) => update.thread));
            }
          }

          yield* Effect.forEach(
            updates,
            ({ thread, branchPullRequest, replacement }) =>
              Effect.gen(function* () {
                // Discovery yields to network I/O; recheck the project at commit to reject deleted projects or changed checkouts.
                const currentProject = yield* projectStore.getShell(project.id);
                if (!projectWorkspaceMatchesSnapshot(currentProject, project.workspaceRoot)) {
                  return failBackfill([thread]);
                }
                const uuid = yield* crypto.randomUUIDv4();
                yield* orchestrator.dispatch({
                  type: "thread.pull-request.sync",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  projectId: project.id,
                  snapshotSequence: threadSnapshot.snapshotSequence,
                  expected: {
                    workspaceRoot: project.workspaceRoot,
                    branch: thread.branch,
                    worktreePath: thread.worktreePath,
                    linkedPullRequest: thread.linkedPullRequest ?? null,
                    branchPullRequest: thread.branchPullRequest ?? null,
                  },
                  branchPullRequest,
                  ...(replacement === undefined ? {} : { linkedPullRequest: replacement }),
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning("thread pull request update failed", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.tap(() => Effect.sync(() => failBackfill([thread])))),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread branch pull request lookup failed", {
                threadIds: group.map((thread) => thread.id),
                cause: Cause.pretty(cause),
              }).pipe(Effect.tap(() => Effect.sync(() => failBackfill(group)))),
          ),
        ),
      // Batch concurrent branch lookups into one GitHub GraphQL document.
      { concurrency: 32, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    synchronize(request).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread pull request refresh failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
      case "thread.metadata-updated":
        return worker.enqueue({ threadId: event.threadId, refresh: false });
      case "thread.unsettled":
      case "checkpoint.captured":
        return worker.enqueue({ threadId: event.threadId, refresh: true });
      case "run.updated":
        if (
          event.payload.status === "completed" ||
          event.payload.status === "failed" ||
          event.payload.status === "cancelled" ||
          event.payload.status === "interrupted"
        ) {
          return worker.enqueue({ threadId: event.threadId, refresh: true, followCheckout: true });
        }
        break;
    }
    return Effect.void;
  };

  const start: ThreadPullRequestServiceV2["Service"]["start"] = Effect.fn(
    "ThreadPullRequestServiceV2.start",
  )(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ threadId: null, refresh: false, backfill: true });
        yield* worker.drain;
        yield* Effect.gen(function* () {
          // The sweep only catches pull requests opened outside a turn, which
          // nobody sees without a client. Thread events still refresh headless work.
          if (!(yield* backgroundPolicy.shouldRunOpportunisticWork)) return;
          yield* worker.enqueue({ threadId: null, refresh: false });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("1 minute"));
      }).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadPullRequestServiceV2["Service"];
});
