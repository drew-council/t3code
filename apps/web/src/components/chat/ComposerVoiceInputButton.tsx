import type { VoiceDraftSnapshot, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { createOpenAiVoiceInputController } from "~/lib/openAiVoiceInput";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/** Remount per draft owner so a recording never lands in another draft. */
export function ComposerVoiceInputButton({
  readDraft,
  commitDraft,
}: {
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const configured = useClientSettings(
    (settings) => settings.openaiTranscriptionApiKey.trim().length > 0,
  );
  const [state, setState] = useState(IDLE_STATE);
  const [controller] = useState(() =>
    createOpenAiVoiceInputController({
      readDraft,
      commitDraft,
      onStateChange: (next) => {
        setState(next);
        if (next.phase === "error" && next.error) {
          toastManager.add({ type: "error", title: "Voice input", description: next.error });
        }
      },
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone and drops the recording on unmount
  useEffect(() => () => controller.dispose(), [controller]);

  if (!configured && state.phase === "idle") return null;

  if (state.phase === "recording") {
    return (
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => controller.cancel()}
                aria-label="Cancel dictation"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Cancel dictation</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void controller.stop()}
                aria-label="Stop and transcribe"
              />
            }
          >
            <SquareIcon />
          </TooltipTrigger>
          <TooltipPopup>Stop and transcribe</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  const busy = state.phase === "preparing" || state.phase === "transcribing";
  const label = busy ? "Cancel transcription" : "Dictate";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => (busy ? controller.cancel() : void controller.start())}
            aria-label={label}
          />
        }
      >
        {busy ? <Spinner /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
