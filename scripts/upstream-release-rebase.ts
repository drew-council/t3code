import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BRANCH = "main";
const FIRST_FORK_COMMIT = "a211cf62afd3e7a684fb52b1046d0552378f8f10";
const GITHUB_API_BASE_URL = "https://api.github.com";
const METADATA_VERSION = 1;
const STATE_BRANCH = "automation/upstream-release-base";
const UPSTREAM_GIT_URL = "https://github.com/pingdotgg/t3code.git";
const UPSTREAM_REPO = "pingdotgg/t3code";

type Command = "finalize" | "inspect" | "prepare" | "sync";

interface CliOptions {
  readonly command: Command;
  readonly push: boolean;
  readonly tagName: string | undefined;
}

interface GitHubRelease {
  readonly draft: boolean;
  readonly htmlUrl: string;
  readonly name: string | null;
  readonly prerelease: boolean;
  readonly publishedAt: string | null;
  readonly tagName: string;
}

interface ReleaseTarget {
  readonly commitSha: string;
  readonly htmlUrl: string;
  readonly name: string | null;
  readonly publishedAt: string | null;
  readonly tagName: string;
}

interface LastPrepareFailure {
  readonly conflictedFiles: readonly string[];
}

interface RebaseMetadata {
  readonly backupTag: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly lastPrepareFailure?: LastPrepareFailure;
  readonly oldBaseSha: string;
  readonly oldMainSha: string;
  readonly stateBranch: string;
  readonly targetRelease: ReleaseTarget;
  readonly upstreamGitUrl: string;
  readonly upstreamRepo: string;
  readonly version: number;
}

interface InspectState {
  readonly currentBranch: string | null;
  readonly gitDir: string;
  readonly inProgressRebase: boolean;
  readonly latestStableRelease: ReleaseTarget;
  readonly localMainSha: string;
  readonly metadata: RebaseMetadata | null;
  readonly metadataPath: string;
  readonly originMainSha: string;
  readonly repoRoot: string;
  readonly syncedBaseSha: string;
  readonly upToDate: boolean;
}

interface PrepareResult {
  readonly backupTag: string;
  readonly commitSha: string;
  readonly noOp: boolean;
  readonly oldBaseSha?: string;
  readonly oldMainSha?: string;
  readonly tagName: string;
}

function normalizeTagName(tagName: string): string {
  const trimmed = tagName.trim();
  if (trimmed.length === 0) {
    throw new Error("Release tag cannot be empty.");
  }

  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function sortReleasesByPublishedAtDescending(
  releases: ReadonlyArray<GitHubRelease>,
): GitHubRelease[] {
  return releases.toSorted((left, right) => {
    const leftTimestamp = left.publishedAt === null ? 0 : Date.parse(left.publishedAt);
    const rightTimestamp = right.publishedAt === null ? 0 : Date.parse(right.publishedAt);
    return rightTimestamp - leftTimestamp;
  });
}

export function selectLatestStableRelease(
  releases: ReadonlyArray<GitHubRelease>,
): GitHubRelease | null {
  const eligibleReleases = releases.filter((release) => !release.draft && !release.prerelease);
  return sortReleasesByPublishedAtDescending(eligibleReleases)[0] ?? null;
}

export function resolveTagCommitShaFromLsRemoteOutput(stdout: string, tagName: string): string {
  const normalizedTagName = normalizeTagName(tagName);
  const peeledRef = `refs/tags/${normalizedTagName}^{}`;
  const directRef = `refs/tags/${normalizedTagName}`;

  let directSha: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }

    const [sha = "", ref = ""] = trimmedLine.split(/\s+/);
    if (ref === peeledRef) {
      return sha;
    }
    if (ref === directRef) {
      directSha = sha;
    }
  }

  if (directSha) {
    return directSha;
  }

  throw new Error(`Unable to resolve upstream tag commit for ${normalizedTagName}.`);
}

export function createBackupTagName(timestamp: Date, oldMainSha: string): string {
  const iso = timestamp
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `upstream-rebase-backup/${iso}/${oldMainSha.slice(0, 12)}`;
}

function assertGitHubRelease(input: unknown): GitHubRelease {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid GitHub release payload.");
  }

  const candidate = input as Record<string, unknown>;
  const tagName = candidate.tag_name;
  const htmlUrl = candidate.html_url;
  const draft = candidate.draft;
  const prerelease = candidate.prerelease;
  const publishedAt = candidate.published_at;
  const name = candidate.name;

  if (
    typeof tagName !== "string" ||
    typeof htmlUrl !== "string" ||
    typeof draft !== "boolean" ||
    typeof prerelease !== "boolean" ||
    (publishedAt !== null && typeof publishedAt !== "string") ||
    (name !== null && typeof name !== "string")
  ) {
    throw new Error("Unexpected GitHub release shape.");
  }

  return {
    draft,
    htmlUrl,
    name,
    prerelease,
    publishedAt,
    tagName: normalizeTagName(tagName),
  };
}

function readMetadata(metadataPath: string): RebaseMetadata | null {
  if (!existsSync(metadataPath)) {
    return null;
  }

  const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  if (raw.version !== METADATA_VERSION) {
    throw new Error(`Unsupported metadata version in ${metadataPath}.`);
  }

  return raw as unknown as RebaseMetadata;
}

function writeMetadata(metadataPath: string, metadata: RebaseMetadata): void {
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function deleteMetadata(metadataPath: string): void {
  rmSync(metadataPath, { force: true });
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: { readonly stdio?: "inherit" | "pipe" } = {},
): string {
  try {
    const stdio = options.stdio ?? "pipe";
    const output = execFileSync(command, [...args], {
      cwd,
      encoding: "utf8",
      stdio,
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString("utf8").trim()
        : error instanceof Error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${message}`, {
      cause: error,
    });
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio?: "inherit" | "pipe" } = {},
): string {
  return runCommand("git", args, cwd, options);
}

function tryGit(cwd: string, args: ReadonlyArray<string>): boolean {
  try {
    execFileSync("git", [...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runValidationChecks(repoRoot: string): void {
  runCommand("bun", ["install", "--frozen-lockfile"], repoRoot, { stdio: "inherit" });
  runCommand("bun", ["run", "fmt:check"], repoRoot, { stdio: "inherit" });
  runCommand("bun", ["run", "lint"], repoRoot, { stdio: "inherit" });
  runCommand("bun", ["run", "typecheck"], repoRoot, { stdio: "inherit" });
}

function getRepoRoot(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function getGitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
}

function getMetadataPath(gitDir: string): string {
  return resolve(gitDir, "t3code/upstream-release-rebase.json");
}

function fetchOriginMain(repoRoot: string): void {
  runGit(repoRoot, ["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"]);
}

function ensureLocalMainBranch(repoRoot: string): void {
  if (!tryGit(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"])) {
    runGit(repoRoot, ["checkout", "--quiet", "-b", "main", "--track", "origin/main"]);
    return;
  }

  runGit(repoRoot, ["checkout", "--quiet", "main"]);
}

function getCurrentBranch(repoRoot: string): string | null {
  try {
    return runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return null;
  }
}

function getHeadSha(repoRoot: string, ref: string): string {
  return runGit(repoRoot, ["rev-parse", ref]);
}

function ensureCleanWorkingTree(repoRoot: string): void {
  const status = runGit(repoRoot, ["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error(
      "Working tree must be clean before running upstream release rebase automation.",
    );
  }
}

function getConflictedFiles(repoRoot: string): string[] {
  const output = runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
  return output.length === 0 ? [] : output.split(/\r?\n/).filter((line) => line.length > 0);
}

function hasInProgressRebase(repoRoot: string): boolean {
  const rebaseApplyPath = runGit(repoRoot, ["rev-parse", "--git-path", "rebase-apply"]);
  const rebaseMergePath = runGit(repoRoot, ["rev-parse", "--git-path", "rebase-merge"]);
  return existsSync(rebaseApplyPath) || existsSync(rebaseMergePath);
}

function resolveRemoteStateBaseSha(repoRoot: string): string | null {
  const output = runGit(repoRoot, ["ls-remote", "--heads", "origin", STATE_BRANCH]);
  if (output.length === 0) {
    return null;
  }

  const [sha = ""] = output.split(/\s+/);
  return sha.length > 0 ? sha : null;
}

function resolveInitialOldBaseSha(repoRoot: string): string {
  return getHeadSha(repoRoot, `${FIRST_FORK_COMMIT}^`);
}

function resolveCurrentSyncedBaseSha(repoRoot: string): string {
  return resolveRemoteStateBaseSha(repoRoot) ?? resolveInitialOldBaseSha(repoRoot);
}

function ensureAncestor(
  repoRoot: string,
  ancestorSha: string,
  descendantRef: string,
  description: string,
): void {
  if (!tryGit(repoRoot, ["merge-base", "--is-ancestor", ancestorSha, descendantRef])) {
    throw new Error(`${description} (${ancestorSha}) is not an ancestor of ${descendantRef}.`);
  }
}

async function fetchGitHubJson(pathname: string): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-upstream-release-rebase",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${pathname}.`);
  }

  return response.json();
}

async function fetchLatestStableRelease(): Promise<GitHubRelease> {
  const payload = await fetchGitHubJson(`/repos/${UPSTREAM_REPO}/releases?per_page=20`);
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected GitHub releases payload.");
  }

  const releases = payload.map(assertGitHubRelease);
  const release = selectLatestStableRelease(releases);
  if (!release) {
    throw new Error(`No stable releases found for ${UPSTREAM_REPO}.`);
  }

  return release;
}

async function fetchReleaseByTagName(tagName: string): Promise<GitHubRelease> {
  const payload = await fetchGitHubJson(
    `/repos/${UPSTREAM_REPO}/releases/tags/${encodeURIComponent(normalizeTagName(tagName))}`,
  );
  return assertGitHubRelease(payload);
}

async function resolveTargetRelease(
  repoRoot: string,
  tagName: string | undefined,
): Promise<ReleaseTarget> {
  const release = tagName ? await fetchReleaseByTagName(tagName) : await fetchLatestStableRelease();
  if (release.draft || release.prerelease) {
    throw new Error(`Release ${release.tagName} is not a stable published release.`);
  }

  const lsRemoteOutput = runGit(repoRoot, [
    "ls-remote",
    "--tags",
    UPSTREAM_GIT_URL,
    `refs/tags/${release.tagName}*`,
  ]);
  const commitSha = resolveTagCommitShaFromLsRemoteOutput(lsRemoteOutput, release.tagName);

  return {
    commitSha,
    htmlUrl: release.htmlUrl,
    name: release.name,
    publishedAt: release.publishedAt,
    tagName: release.tagName,
  };
}

function createMetadata(
  oldBaseSha: string,
  oldMainSha: string,
  targetRelease: ReleaseTarget,
): RebaseMetadata {
  return {
    backupTag: createBackupTagName(new Date(), oldMainSha),
    branch: DEFAULT_BRANCH,
    createdAt: new Date().toISOString(),
    oldBaseSha,
    oldMainSha,
    stateBranch: STATE_BRANCH,
    targetRelease,
    upstreamGitUrl: UPSTREAM_GIT_URL,
    upstreamRepo: UPSTREAM_REPO,
    version: METADATA_VERSION,
  };
}

function formatInspectState(state: InspectState): string {
  const lines = [
    `Repository: ${state.repoRoot}`,
    `Current branch: ${state.currentBranch ?? "(detached HEAD)"}`,
    `Local main: ${state.localMainSha}`,
    `Origin main: ${state.originMainSha}`,
    `Current synced upstream base: ${state.syncedBaseSha}`,
    `Latest stable release: ${state.latestStableRelease.tagName} (${state.latestStableRelease.commitSha})`,
    `Latest release URL: ${state.latestStableRelease.htmlUrl}`,
    `Up to date: ${state.upToDate ? "yes" : "no"}`,
    `Metadata file: ${state.metadataPath}`,
    `Rebase in progress: ${state.inProgressRebase ? "yes" : "no"}`,
  ];

  if (state.metadata) {
    lines.push(`Pending metadata target: ${state.metadata.targetRelease.tagName}`);
    lines.push(`Pending metadata backup tag: ${state.metadata.backupTag}`);
    if (state.metadata.lastPrepareFailure) {
      lines.push(
        `Last prepare conflicts: ${
          state.metadata.lastPrepareFailure.conflictedFiles.join(", ") || "(none recorded)"
        }`,
      );
    }
  } else {
    lines.push("Pending metadata target: (none)");
  }

  return `${lines.join("\n")}\n`;
}

async function inspect(repoRoot: string, tagName: string | undefined): Promise<InspectState> {
  fetchOriginMain(repoRoot);

  const latestStableRelease = await resolveTargetRelease(repoRoot, tagName);
  const gitDir = getGitDir(repoRoot);
  const metadataPath = getMetadataPath(gitDir);
  const metadata = readMetadata(metadataPath);
  const currentBranch = getCurrentBranch(repoRoot);
  const localMainSha = getHeadSha(repoRoot, "main");
  const originMainSha = getHeadSha(repoRoot, "origin/main");
  const syncedBaseSha = resolveCurrentSyncedBaseSha(repoRoot);

  return {
    currentBranch,
    gitDir,
    inProgressRebase: hasInProgressRebase(repoRoot),
    latestStableRelease,
    localMainSha,
    metadata,
    metadataPath,
    originMainSha,
    repoRoot,
    syncedBaseSha,
    upToDate: latestStableRelease.commitSha === syncedBaseSha,
  };
}

async function prepare(repoRoot: string, tagName: string | undefined): Promise<PrepareResult> {
  fetchOriginMain(repoRoot);
  ensureLocalMainBranch(repoRoot);
  ensureCleanWorkingTree(repoRoot);

  const gitDir = getGitDir(repoRoot);
  const metadataPath = getMetadataPath(gitDir);
  if (hasInProgressRebase(repoRoot)) {
    throw new Error("A git rebase is already in progress.");
  }
  if (readMetadata(metadataPath) !== null) {
    throw new Error(
      `Metadata already exists at ${metadataPath}. Run finalize or remove it before prepare.`,
    );
  }

  const localMainSha = getHeadSha(repoRoot, "main");
  const originMainSha = getHeadSha(repoRoot, "origin/main");
  if (localMainSha !== originMainSha) {
    throw new Error("Local main must match origin/main before prepare can run.");
  }

  const oldBaseSha = resolveCurrentSyncedBaseSha(repoRoot);
  const targetRelease = await resolveTargetRelease(repoRoot, tagName);
  if (targetRelease.commitSha === oldBaseSha) {
    return {
      backupTag: "",
      commitSha: targetRelease.commitSha,
      noOp: true,
      tagName: targetRelease.tagName,
    };
  }

  ensureAncestor(repoRoot, oldBaseSha, "main", "The current synced upstream base");
  runGit(repoRoot, ["fetch", "--quiet", UPSTREAM_GIT_URL, targetRelease.commitSha]);

  const metadata = createMetadata(oldBaseSha, localMainSha, targetRelease);
  if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${metadata.backupTag}`])) {
    throw new Error(`Backup tag ${metadata.backupTag} already exists.`);
  }

  runGit(repoRoot, ["tag", metadata.backupTag, metadata.oldMainSha]);
  writeMetadata(metadataPath, metadata);

  try {
    runGit(repoRoot, ["rebase", "--onto", targetRelease.commitSha, oldBaseSha, "main"], {
      stdio: "inherit",
    });
  } catch (error) {
    writeMetadata(metadataPath, {
      ...metadata,
      lastPrepareFailure: {
        conflictedFiles: getConflictedFiles(repoRoot),
      },
    });
    throw error;
  }

  return {
    backupTag: metadata.backupTag,
    commitSha: targetRelease.commitSha,
    noOp: false,
    oldBaseSha,
    oldMainSha: metadata.oldMainSha,
    tagName: targetRelease.tagName,
  };
}

function finalize(repoRoot: string, push: boolean): void {
  const gitDir = getGitDir(repoRoot);
  const metadataPath = getMetadataPath(gitDir);
  const metadata = readMetadata(metadataPath);
  if (!metadata) {
    throw new Error(`No pending metadata found at ${metadataPath}.`);
  }

  if (hasInProgressRebase(repoRoot)) {
    throw new Error("Cannot finalize while a git rebase is still in progress.");
  }

  ensureLocalMainBranch(repoRoot);
  ensureCleanWorkingTree(repoRoot);
  ensureAncestor(
    repoRoot,
    metadata.targetRelease.commitSha,
    "HEAD",
    `Target release ${metadata.targetRelease.tagName}`,
  );

  runValidationChecks(repoRoot);
  runGit(repoRoot, ["update-ref", `refs/heads/${STATE_BRANCH}`, metadata.targetRelease.commitSha]);

  if (push) {
    runGit(
      repoRoot,
      [
        "push",
        "--atomic",
        "--force-with-lease=refs/heads/main:" + metadata.oldMainSha,
        "origin",
        "refs/heads/main:refs/heads/main",
        `refs/heads/${STATE_BRANCH}:refs/heads/${STATE_BRANCH}`,
        `refs/tags/${metadata.backupTag}:refs/tags/${metadata.backupTag}`,
      ],
      { stdio: "inherit" },
    );
  }

  deleteMetadata(metadataPath);
}

async function sync(repoRoot: string, tagName: string | undefined, push: boolean): Promise<void> {
  const result = await prepare(repoRoot, tagName);
  if (result.noOp) {
    console.log(
      `main is already based on upstream release ${result.tagName} (${result.commitSha}). Nothing to do.`,
    );
    return;
  }

  console.log(
    `Rebased main from upstream base ${result.oldBaseSha} onto ${result.tagName} (${result.commitSha}).`,
  );
  finalize(repoRoot, push);
  console.log(`Finalized upstream release rebase.${push ? " Pushed updated refs." : ""}`);
}

function printConflictFollowUp(): void {
  console.error("Resolve conflicts, then run `git rebase --continue`.");
  console.error(
    "After the rebase completes, run `node scripts/upstream-release-rebase.ts finalize --push`.",
  );
  console.error(
    "If you want to abandon the attempt, run `git rebase --abort` and delete the metadata file.",
  );
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  let command: Command | undefined;
  let push = false;
  let tagName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--push") {
      push = true;
      continue;
    }

    if (argument === "--tag") {
      const nextArgument = argv[index + 1];
      if (!nextArgument) {
        throw new Error("Missing value for --tag.");
      }
      tagName = normalizeTagName(nextArgument);
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (command !== undefined) {
      throw new Error("Only one command may be provided.");
    }

    if (
      argument !== "finalize" &&
      argument !== "inspect" &&
      argument !== "prepare" &&
      argument !== "sync"
    ) {
      throw new Error(`Unknown command: ${argument}`);
    }

    command = argument;
  }

  if (!command) {
    throw new Error(
      "Usage: node scripts/upstream-release-rebase.ts <inspect|prepare|finalize|sync> [--tag <vX.Y.Z>] [--push]",
    );
  }

  if (command === "finalize" && tagName !== undefined) {
    throw new Error("--tag is only supported with inspect, prepare, or sync.");
  }

  if (push && command !== "finalize" && command !== "sync") {
    throw new Error("--push is only supported with finalize or sync.");
  }

  return { command, push, tagName };
}

async function main(): Promise<void> {
  const { command, push, tagName } = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot(process.cwd());

  switch (command) {
    case "inspect": {
      const state = await inspect(repoRoot, tagName);
      process.stdout.write(formatInspectState(state));
      return;
    }
    case "prepare": {
      try {
        const result = await prepare(repoRoot, tagName);
        if (result.noOp) {
          console.log(
            `main is already based on upstream release ${result.tagName} (${result.commitSha}). Nothing to do.`,
          );
          return;
        }

        console.log(
          `Prepared rebase onto ${result.tagName} (${result.commitSha}). Run finalize after the rebase is complete.`,
        );
      } catch (error) {
        if (hasInProgressRebase(repoRoot)) {
          printConflictFollowUp();
        }
        throw error;
      }
      return;
    }
    case "finalize":
      finalize(repoRoot, push);
      return;
    case "sync":
      await sync(repoRoot, tagName, push);
      return;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
