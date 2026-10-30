import { describe, expect, it, vi } from "vite-plus/test";

import {
  ONE_PASSWORD_SECRETS,
  forgetOnePasswordSecret,
  resolveOnePasswordSecret,
  startOnePasswordSecretSync,
} from "./onePasswordSecrets";

const OPENAI = ONE_PASSWORD_SECRETS.openaiApiKey;
const STORAGE_KEY = "t3code:one-password-secrets:v2";

function setup(stored: Record<string, string> = {}) {
  const storage = new Map([[STORAGE_KEY, JSON.stringify(stored)]]);
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
  return { readOnePasswordSecrets, storage };
}

describe("onePasswordSecrets", () => {
  it("reads uncached secrets in one approval and serves later reads from the cache", async () => {
    const { readOnePasswordSecrets } = setup();

    const [first, second] = await Promise.all([
      resolveOnePasswordSecret("openaiApiKey"),
      resolveOnePasswordSecret("openaiApiKey"),
    ]);
    expect(first).toBe(`secret:${OPENAI}`);
    expect(second).toBe(first);
    expect(readOnePasswordSecrets).toHaveBeenCalledTimes(1);
    expect(readOnePasswordSecrets).toHaveBeenCalledWith({
      account: "XH4EFF5WXBGXJOIXZG4PLGILIE",
      references: [OPENAI],
    });

    forgetOnePasswordSecret("openaiApiKey");
    await resolveOnePasswordSecret("openaiApiKey");
    expect(readOnePasswordSecrets).toHaveBeenCalledTimes(2);
  });

  it("drops secrets the code no longer names and skips cached ones at startup", async () => {
    const { readOnePasswordSecrets, storage } = setup({
      [OPENAI]: "cached",
      "op://vault/retired/credential": "stale",
    });

    await startOnePasswordSecretSync();

    expect(readOnePasswordSecrets).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? "{}")).toEqual({ [OPENAI]: "cached" });
  });
});
