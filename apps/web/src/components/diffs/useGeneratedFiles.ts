import type { EnvironmentId } from "@t3tools/contracts";
import { classifyChangedFile } from "@t3tools/shared/changedFileKind";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";

const HIDE_GENERATED_FILES_STORAGE_KEY = "t3code.diffHideGeneratedFiles";

export function useHideGeneratedFiles() {
  return useLocalStorage(HIDE_GENERATED_FILES_STORAGE_KEY, true, Schema.Boolean);
}

/**
 * `linguist-generated` from the repository's `.gitattributes` wins, so a repository can mark or
 * unmark a file; otherwise the path's naming convention decides.
 */
export function useIsGeneratedFile(input: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly paths: ReadonlyArray<string>;
}): (path: string) => boolean {
  const paths = [...new Set(input.paths)].toSorted();
  const attributes = useEnvironmentQuery(
    input.environmentId && input.cwd && paths.length > 0
      ? reviewEnvironment.generatedPaths({
          environmentId: input.environmentId,
          input: { cwd: input.cwd, paths },
        })
      : null,
  ).data?.generated;
  return (path) =>
    attributes && Object.hasOwn(attributes, path)
      ? attributes[path] === true
      : classifyChangedFile(path) === "generated";
}
