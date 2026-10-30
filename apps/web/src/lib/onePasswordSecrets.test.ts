import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: { onePasswordAccount: "", openaiTranscriptionApiKey: "", otherKey: "" },
}));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => state.settings,
  ensureClientSettingsHydrated: async () => undefined,
}));

import {
  forgetOnePasswordSecret,
  resolveSecretSetting,
  startOnePasswordSecretSync,
} from "./onePasswordSecrets";

function setup() {
  state.settings = {
    onePasswordAccount: "",
    openaiTranscriptionApiKey: "op://vault/openai/credential",
    otherKey: "op://vault/other/credential",
  };
  const storage = new Map<string, string>();
  const readOnePasswordSecrets = vi.fn(async (input: { readonly references: readonly string[] }) =>
    input.references.map((reference) => `secret:${reference}`),
  );
  vi.stubGlobal("window", {
    desktopBridge: { readOnePasswordSecrets },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  return { readOnePasswordSecrets };
}

describe("onePasswordSecrets", () => {
  it("reads every uncached reference in one approval and serves later reads from the cache", async () => {
    const { readOnePasswordSecrets } = setup();

    const [openai, again] = await Promise.all([
      resolveSecretSetting("op://vault/openai/credential"),
      resolveSecretSetting("op://vault/openai/credential"),
    ]);
    expect(openai).toBe("secret:op://vault/openai/credential");
    expect(again).toBe(openai);
    expect(await resolveSecretSetting("op://vault/other/credential")).toBe(
      "secret:op://vault/other/credential",
    );
    expect(await resolveSecretSetting(" sk-plain ")).toBe("sk-plain");
    expect(readOnePasswordSecrets).toHaveBeenCalledTimes(1);
    expect(readOnePasswordSecrets).toHaveBeenCalledWith({
      account: null,
      references: ["op://vault/openai/credential", "op://vault/other/credential"],
    });

    forgetOnePasswordSecret("op://vault/openai/credential");
    await resolveSecretSetting("op://vault/openai/credential");
    expect(readOnePasswordSecrets).toHaveBeenLastCalledWith({
      account: null,
      references: ["op://vault/openai/credential"],
    });

    state.settings = { ...state.settings, onePasswordAccount: "my.1password.com" };
    await resolveSecretSetting("op://vault/other/credential");
    expect(readOnePasswordSecrets).toHaveBeenLastCalledWith({
      account: "my.1password.com",
      references: ["op://vault/other/credential", "op://vault/openai/credential"],
    });
    expect(readOnePasswordSecrets).toHaveBeenCalledTimes(3);
  });

  it("drops secrets no setting references at startup", async () => {
    const { readOnePasswordSecrets } = setup();
    await resolveSecretSetting("op://vault/openai/credential");

    state.settings = { ...state.settings, otherKey: "" };
    await startOnePasswordSecretSync();
    state.settings = { ...state.settings, otherKey: "op://vault/other/credential" };
    await resolveSecretSetting("op://vault/other/credential");

    expect(readOnePasswordSecrets).toHaveBeenLastCalledWith({
      account: null,
      references: ["op://vault/other/credential"],
    });
  });
});
