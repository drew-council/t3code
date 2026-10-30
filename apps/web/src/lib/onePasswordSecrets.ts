import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";

const STORAGE_KEY = "t3code:one-password-secrets:v1";

const SecretCache = Schema.Struct({
  account: Schema.String,
  values: Schema.Record(Schema.String, Schema.String),
});
type SecretCache = typeof SecretCache.Type;

let pendingRead: Promise<void> | null = null;

export function isOnePasswordReference(value: string): boolean {
  return value.trim().startsWith("op://");
}

/** Any top-level client setting holding an `op://` reference is a secret to resolve. */
function referencedSecrets(): string[] {
  const references = Object.values(getClientSettings()).flatMap((value) =>
    typeof value === "string" && isOnePasswordReference(value) ? [value.trim()] : [],
  );
  return [...new Set(references)];
}

function readCache(): SecretCache {
  const account = getClientSettings().onePasswordAccount.trim();
  const cache = getLocalStorageItem(STORAGE_KEY, SecretCache);
  return cache?.account === account ? cache : { account, values: {} };
}

function writeCache(cache: SecretCache): void {
  setLocalStorageItem(STORAGE_KEY, cache, SecretCache);
}

async function readMissing(references: readonly string[]): Promise<void> {
  for (let pending = pendingRead; pending; pending = pendingRead) await pending;
  const cache = readCache();
  const missing = references.filter((reference) => cache.values[reference] === undefined);
  if (missing.length === 0) return;
  const bridge = window.desktopBridge;
  if (!bridge) throw new Error("1Password references only resolve in the desktop app.");

  const read = bridge
    .readOnePasswordSecrets({ account: cache.account || null, references: missing })
    .then((values) => {
      const latest = readCache();
      if (latest.account !== cache.account) return;
      const next = { ...latest.values };
      missing.forEach((reference, index) => {
        const value = values[index];
        if (value !== undefined && value.length > 0) next[reference] = value;
      });
      writeCache({ account: cache.account, values: next });
    });
  const tracked: Promise<void> = read
    .catch(() => undefined)
    .finally(() => {
      if (pendingRead === tracked) pendingRead = null;
    });
  pendingRead = tracked;
  await read;
}

/**
 * Returns a plain setting value as is, or the cached secret for an `op://` reference.
 * A cache miss reads it together with every other uncached reference in client settings.
 */
export async function resolveSecretSetting(value: string): Promise<string | null> {
  const trimmed = value.trim();
  if (!isOnePasswordReference(trimmed)) return trimmed || null;
  await readMissing([...new Set([trimmed, ...referencedSecrets()])]);
  return readCache().values[trimmed] ?? null;
}

/** Drops a cached secret, e.g. after the service rejects it, so the next use reads it again. */
export function forgetOnePasswordSecret(reference: string): void {
  const cache = readCache();
  const values = { ...cache.values };
  delete values[reference.trim()];
  writeCache({ account: cache.account, values });
}

export function clearOnePasswordSecrets(): void {
  removeLocalStorageItem(STORAGE_KEY);
}

/** Prunes secrets no setting references, then reads the uncached ones in one approval. */
export function startOnePasswordSecretSync(): Promise<void> {
  return ensureClientSettingsHydrated()
    .then(() => {
      const references = referencedSecrets();
      const cache = readCache();
      const values = Object.fromEntries(
        Object.entries(cache.values).filter(([reference]) => references.includes(reference)),
      );
      writeCache({ account: cache.account, values });
      return references.length > 0 ? readMissing(references) : undefined;
    })
    .catch((error: unknown) => {
      console.warn("Could not read 1Password secrets at startup", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}
