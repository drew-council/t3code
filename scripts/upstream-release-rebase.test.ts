import { assert, describe, it } from "@effect/vitest";

import {
  createBackupTagName,
  resolveTagCommitShaFromLsRemoteOutput,
  selectLatestStableRelease,
} from "./upstream-release-rebase.ts";

describe("upstream-release-rebase", () => {
  describe("selectLatestStableRelease", () => {
    it("picks the newest stable release and skips drafts and prereleases", () => {
      const release = selectLatestStableRelease([
        {
          draft: false,
          htmlUrl: "https://example.com/v0.0.15",
          name: "v0.0.15",
          prerelease: false,
          publishedAt: "2026-03-29T04:51:57Z",
          tagName: "v0.0.15",
        },
        {
          draft: false,
          htmlUrl: "https://example.com/v0.0.16-beta.1",
          name: "v0.0.16-beta.1",
          prerelease: true,
          publishedAt: "2026-03-30T04:51:57Z",
          tagName: "v0.0.16-beta.1",
        },
        {
          draft: true,
          htmlUrl: "https://example.com/v0.0.17",
          name: "v0.0.17",
          prerelease: false,
          publishedAt: "2026-03-31T04:51:57Z",
          tagName: "v0.0.17",
        },
      ]);

      assert.equal(release?.tagName, "v0.0.15");
    });

    it("returns null when no stable releases exist", () => {
      const release = selectLatestStableRelease([
        {
          draft: false,
          htmlUrl: "https://example.com/v0.0.16-beta.1",
          name: "v0.0.16-beta.1",
          prerelease: true,
          publishedAt: "2026-03-30T04:51:57Z",
          tagName: "v0.0.16-beta.1",
        },
      ]);

      assert.equal(release, null);
    });
  });

  describe("resolveTagCommitShaFromLsRemoteOutput", () => {
    it("prefers peeled annotated tags when present", () => {
      const sha = resolveTagCommitShaFromLsRemoteOutput(
        `1111111111111111111111111111111111111111\trefs/tags/v0.0.15
2222222222222222222222222222222222222222\trefs/tags/v0.0.15^{}`,
        "v0.0.15",
      );

      assert.equal(sha, "2222222222222222222222222222222222222222");
    });

    it("accepts lightweight tags with only a direct ref", () => {
      const sha = resolveTagCommitShaFromLsRemoteOutput(
        `3333333333333333333333333333333333333333\trefs/tags/v0.0.14`,
        "0.0.14",
      );

      assert.equal(sha, "3333333333333333333333333333333333333333");
    });
  });

  describe("createBackupTagName", () => {
    it("builds a stable timestamped backup tag", () => {
      const tag = createBackupTagName(
        new Date("2026-04-04T16:12:34.567Z"),
        "a18481ac9cd868bcbbf393bded705330329dee25",
      );

      assert.equal(tag, "upstream-rebase-backup/20260404T161234Z/a18481ac9cd8");
    });
  });
});
