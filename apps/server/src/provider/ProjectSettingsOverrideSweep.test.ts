import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { findOrphanedProjectIds } from "./ProjectSettingsOverrideSweep.ts";

it("sweeps orphaned project IDs but keeps repository-keyed entries", () => {
  const live = ProjectId.make("project-live");
  const orphan = ProjectId.make("project-orphan");
  const settings = {
    projectSettingsOverrides: {
      [live]: { defaultAutoPull: true },
      [orphan]: { defaultAutoPull: true },
      [ProjectId.make("github.com/acme/absent-here")]: { defaultAutoPull: true },
    },
  };

  assert.deepEqual(findOrphanedProjectIds(settings, new Set([live])), [orphan]);
});
