import {
  OnePasswordAccount,
  definition as onePassword,
} from "@t3tools/secret-provider-onepassword/shared/definition";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Long enough to reach for a fingerprint reader.
const READ_TIMEOUT = Duration.seconds(60);

const Reference = Schema.String.check(
  Schema.makeFilter((value: string) =>
    onePassword.isReference(value) ? true : onePassword.invalidReferenceMessage,
  ),
);

class OnePasswordReadError extends Schema.TaggedError<OnePasswordReadError>()(
  "OnePasswordReadError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Reads every reference with one `op inject`, so 1Password asks for approval once. */
export const readOnePasswordSecrets = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_ONE_PASSWORD_SECRETS_CHANNEL,
  payload: Schema.Struct({
    account: Schema.NullOr(OnePasswordAccount),
    references: Schema.Array(Reference).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.onePassword.read")(function* ({ account, references }, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new OnePasswordReadError({ detail: "1Password request was rejected." });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // A random separator after every reference keeps one secret from shifting the others.
    const separator = `__t3-secret-${yield* (yield* Crypto.Crypto).randomUUIDv4()}__`;
    // `op` ignores piped stdin from Node, so the template goes through a temp file.
    const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
    yield* fileSystem.writeFileString(
      templatePath,
      references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
    );
    const args = [
      "--cache=false",
      "inject",
      ...(account === null ? [] : [`--account=${account}`]),
      "-i",
      templatePath,
    ];
    const outcome = yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("op", args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      );
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: 3 },
      );
    }).pipe(
      Effect.timeoutOption(READ_TIMEOUT),
      Effect.mapError(
        () => new OnePasswordReadError({ detail: "Could not run the 1Password CLI (`op`)." }),
      ),
    );
    if (Option.isNone(outcome)) {
      return yield* new OnePasswordReadError({ detail: "1Password did not answer in time." });
    }

    const [stdout, stderr, exitCode] = outcome.value;
    const values = stdout.split(separator);
    const trailing = values.pop();
    if (
      exitCode !== 0 ||
      values.length !== references.length ||
      trailing === undefined ||
      trailing.trim().length > 0
    ) {
      const reason = stderr.trim().split("\n").at(-1)?.slice(0, 300);
      return yield* new OnePasswordReadError({
        detail: reason ? `1Password: ${reason}` : "1Password did not return the secrets.",
      });
    }
    return values;
  }, Effect.scoped),
});
