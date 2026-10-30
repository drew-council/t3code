import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

/** Account UUID from `op account list --format=json`. */
const ONE_PASSWORD_ACCOUNT = "XH4EFF5WXBGXJOIXZG4PLGILIE";

/** Every secret the app reads. Startup fetches all uncached ones with a single approval. */
export const ONE_PASSWORD_SECRETS = {
  openaiApiKey: "op://opnix/openai-personal/credential",
} as const;
export type OnePasswordSecret = keyof typeof ONE_PASSWORD_SECRETS;

const STORAGE_KEY = "t3code:one-password-secrets:v2";
const SecretCache = Schema.Record(Schema.String, Schema.String);
type SecretCache = typeof SecretCache.Type;

const REFERENCES: readonly string[] = Object.values(ONE_PASSWORD_SECRETS);

let pendingRead: Promise<void> | null = null;

function readCache(): SecretCache {
  return getLocalStorageItem(STORAGE_KEY, SecretCache) ?? {};
}

function writeCache(cache: SecretCache): void {
  setLocalStorageItem(STORAGE_KEY, cache, SecretCache);
}

async function readMissing(): Promise<void> {
  for (let pending = pendingRead; pending; pending = pendingRead) await pending;
  const missing = REFERENCES.filter((reference) => readCache()[reference] === undefined);
  if (missing.length === 0) return;
  const bridge = window.desktopBridge;
  if (!bridge) throw new Error("1Password secrets only resolve in the desktop app.");

  const read = bridge
    .readOnePasswordSecrets({ account: ONE_PASSWORD_ACCOUNT, references: missing })
    .then((values) => {
      const next = { ...readCache() };
      missing.forEach((reference, index) => {
        const value = values[index];
        if (value !== undefined && value.length > 0) next[reference] = value;
      });
      writeCache(next);
    });
  const tracked: Promise<void> = read
    .catch(() => undefined)
    .finally(() => {
      if (pendingRead === tracked) pendingRead = null;
    });
  pendingRead = tracked;
  await read;
}

/** Returns the cached secret, reading every uncached secret in one approval on a miss. */
export async function resolveOnePasswordSecret(name: OnePasswordSecret): Promise<string | null> {
  const reference = ONE_PASSWORD_SECRETS[name];
  if (readCache()[reference] === undefined) await readMissing();
  return readCache()[reference] ?? null;
}

/** Drops a cached secret, e.g. after the service rejects it, so the next use reads it again. */
export function forgetOnePasswordSecret(name: OnePasswordSecret): void {
  const { [ONE_PASSWORD_SECRETS[name]]: _forgotten, ...rest } = readCache();
  writeCache(rest);
}

export function clearOnePasswordSecrets(): void {
  removeLocalStorageItem(STORAGE_KEY);
}

/** Prunes secrets the code no longer names, then reads the uncached ones in one approval. */
export function startOnePasswordSecretSync(): Promise<void> {
  const cache = readCache();
  writeCache(
    Object.fromEntries(
      Object.entries(cache).filter(([reference]) => REFERENCES.includes(reference)),
    ),
  );
  return readMissing().catch((error: unknown) => {
    console.warn("Could not read 1Password secrets at startup", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
