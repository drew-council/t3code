---
name: rebase-local-patches
description: Rebase the drew/local-patches fork branch onto the latest stable T3 Code release from pingdotgg/t3code, reviewing each fork commit and dropping ones upstream made irrelevant.
disable-model-invocation: true
metadata:
  short-description: Rebase and prune drew/local-patches onto upstream stable
---

# Rebase `drew/local-patches`

Rebase `drew/local-patches` onto the latest stable upstream release. Review every fork commit. Drop commits that upstream made unnecessary.

Repository guidance (`AGENTS.md`, `docs/operations/`) wins over this skill where they disagree.

## How upstream releases

- Upstream is `pingdotgg/t3code`, the `upstream` remote. `origin` is the fork.
- Stable tags are plain `vX.Y.Z`. Tags with `-nightly.` or `-preview.` are prereleases. Ignore them unless asked.
- A stable tag points at the promoted nightly commit. Its `package.json` files still hold the previous version.
- After publishing, upstream's finalize job commits `chore(release): prepare vX.Y.Z` to `main` as `t3-code-bot`. It bumps the four package versions.
- The fork carries that commit, cherry-picked, as its first commit on the tag. `flake.nix` reads the version from `apps/server/package.json`, so the Nix build reports the wrong version without it.

## Rules

- Operate only on `drew/local-patches`. If it is not checked out, stop.
- Require a clean working tree and no Git operation in progress.
- Verify `upstream` points at `pingdotgg/t3code` before fetching from it.
- Target the release GitHub marks latest. Only plain stable releases get that mark.
- 0.x releases normally move the patch number. If the target changes the minor or major version, say so and ask before rebasing.
- Create a uniquely named backup branch at the original tip before rewriting history.
- Do not push, delete branches, or alter remotes unless asked.
- Do not run repo-wide checks. Follow the Verifying section of `AGENTS.md`.

## Workflow

1. Inspect branch, status, remotes, and repository instructions.
2. Fetch upstream and its tags: `git fetch upstream --tags`.
3. Find the target and the old base:

   ```bash
   gh release view -R pingdotgg/t3code --json tagName -q .tagName
   git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' drew/local-patches
   ```

   If they match, report that the branch is current and stop.

4. Find the target's prepare commit:

   ```bash
   git log upstream/main --author='t3-code-bot' --grep='^chore(release): prepare <new-tag>$' --format=%H -1
   ```

   If it does not exist yet, stop and ask. The finalize job may not have run.

5. List fork commits oldest-first: `git log --reverse --format='%h %s' <old-tag>..drew/local-patches`. The first is the old prepare commit. It is always dropped.
6. Review each remaining commit against `<old-tag>..<new-tag>`:
   - Read its diff and intent.
   - Check upstream changes to the same files: `git log --oneline <old-tag>..<new-tag> -- <files>`.
   - Skim the release notes: `gh release view <new-tag> -R pingdotgg/t3code`.
   - **Keep** it if the behavior is still needed.
   - **Adapt** it if upstream reshaped the surrounding code.
   - **Drop** it if upstream ships equivalent behavior or removed what it patched.
   - If relevance is uncertain, ask rather than guess.
7. Create the backup: `git branch backup/local-patches-<YYYYMMDD> drew/local-patches`. Add a suffix if that name exists.
8. Write a rebase todo in the scratchpad. The first line picks the new prepare commit. Then one `pick <sha> <subject>` line per kept commit, in original order. Omit dropped commits and the old prepare commit. Run it non-interactively:

   ```bash
   GIT_SEQUENCE_EDITOR="cp <todo-file>" git rebase -i --onto <new-tag> <old-tag> drew/local-patches
   ```

9. Resolve conflicts by the fork commit's intent and the release's current design. Never blindly take `ours` or `theirs`.
   - For weave conflict markers (`refused_by:`), use the `weave` skill.
   - For `pnpm-lock.yaml`, take the upstream side, run `vp i`, and stage the regenerated lockfile.
10. After the rebase:
    - Run `vp i`.
    - If `pnpm-lock.yaml` differs from the backup, run `bash nix/update-pnpm-deps-hash.sh`. Fold the result into the latest commit that touched `nix/pnpm-deps.hash` with `git commit --fixup=<sha>` and `git rebase --autosquash <new-tag>` (via `GIT_SEQUENCE_EDITOR=true`).

## Validation

- `git range-diff <old-tag>..<backup> <new-tag>..drew/local-patches`. Every change in a kept commit MUST be explained by a conflict resolution or adaptation.
- `git diff --stat <new-tag>..drew/local-patches` to inspect the cumulative fork delta.
- `git diff --check <new-tag>..drew/local-patches`.
- `vp run check:changed <new-tag>`. It covers format, lint, knip, typecheck, and tests beside every fork change.
- `vp test run <files>` for tests around each conflict you resolved.
- `nix build --no-link` to confirm the flake builds and the dependency hash is right.

## Report

Summarize:

- old and new release;
- backup branch name;
- kept and adapted commits;
- dropped commits and why;
- conflict resolutions;
- validation results;
- final Git status;
- the push commands, if the user wants them: `git push --force-with-lease origin drew/local-patches` and `git push origin <backup>`.
