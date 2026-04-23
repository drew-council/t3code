import { describe, expect, it } from "vitest";

import { normalizeCommandValue } from "./toolCommand";

describe("normalizeCommandValue", () => {
  it("unwraps shell launcher arrays", () => {
    expect(
      normalizeCommandValue([
        "/bin/zsh",
        "-lc",
        "ls -la /workspace && find /workspace -maxdepth 2 -type d",
      ]),
    ).toBe("ls -la /workspace && find /workspace -maxdepth 2 -type d");
  });

  it("unwraps shell launcher strings", () => {
    expect(
      normalizeCommandValue(
        '/bin/zsh -lc "sed -n \\"1,220p\\" apps/server/src/project/Layers/ProjectFaviconResolver.ts"',
      ),
    ).toBe('sed -n \\"1,220p\\" apps/server/src/project/Layers/ProjectFaviconResolver.ts');
  });

  it("unwraps prefixed shell launcher strings", () => {
    expect(
      normalizeCommandValue(
        "Command: /run/current-system/sw/bin/zsh -lc \"sed -n '920,1080p' apps/server/src/provider/Layers/ProviderService.test.ts\"",
      ),
    ).toBe("sed -n '920,1080p' apps/server/src/provider/Layers/ProviderService.test.ts");
  });

  it("keeps direct shell commands that are not launcher wrappers", () => {
    expect(normalizeCommandValue(["bash", "scripts/setup-dev.sh"])).toBe(
      "bash scripts/setup-dev.sh",
    );
  });

  it("keeps regular commands untouched", () => {
    expect(normalizeCommandValue(["bun", "run", "lint"])).toBe("bun run lint");
  });
});
