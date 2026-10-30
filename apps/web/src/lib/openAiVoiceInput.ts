import {
  type VoiceDraftSnapshot,
  VoiceInputController,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceTranscriber,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
} from "@t3tools/client-runtime/voice-input";

import { forgetOnePasswordSecret, resolveOnePasswordSecret } from "~/lib/onePasswordSecrets";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
const OPENAI_TRANSCRIPTION_PROMPT =
  "A developer dictating instructions to a coding agent about source code, file paths, and programming tools.";
const PREFERRED_MIME_TYPE = "audio/webm;codecs=opus";

const recordings = new Map<string, Blob>();
let nextRecordingId = 0;

class MediaVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private stopped: Promise<void> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onLimitReached: (uri: string) => void;
  private readonly onError: (message: string) => void;

  constructor(onLimitReached: (uri: string) => void, onError: (message: string) => void) {
    this.onLimitReached = onLimitReached;
    this.onError = onError;
  }

  async acquireMicrophone(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  releaseMicrophone(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.stream) throw new Error("The microphone is not available.");
    this.uri = null;
    this.recorder = new MediaRecorder(
      this.stream,
      MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)
        ? { mimeType: PREFERRED_MIME_TYPE }
        : undefined,
    );
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    const recorder = this.recorder;
    if (!recorder) return;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    this.stopped = new Promise((resolve) => {
      recorder.onstop = () => {
        const uri = `recording-${++nextRecordingId}`;
        recordings.set(uri, new Blob(chunks, { type: recorder.mimeType }));
        this.uri = uri;
        resolve();
      };
    });
    recorder.onerror = () => this.onError("Voice recording failed.");
    recorder.start();
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() => {
        if (this.uri) this.onLimitReached(this.uri);
      });
    }, forDuration * 1000);
  }

  async stop(): Promise<void> {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    await this.stopped;
    this.stopped = null;
  }
}

function recordingFileName(type: string): string {
  if (type.includes("ogg")) return "recording.ogg";
  if (type.includes("mp4")) return "recording.mp4";
  return "recording.webm";
}

function openAiErrorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = body.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      if (typeof error.message === "string") return `OpenAI: ${error.message}`;
    }
  }
  return `OpenAI transcription failed with status ${status}.`;
}

async function transcribeRecording(
  apiKey: string,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  const audio = recordings.get(uri);
  if (!audio || audio.size === 0) return "";
  const form = new FormData();
  form.append("file", audio, recordingFileName(audio.type));
  form.append("model", OPENAI_TRANSCRIPTION_MODEL);
  form.append("prompt", OPENAI_TRANSCRIPTION_PROMPT);

  let response: Response;
  let body: unknown;
  try {
    response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    body = await response.json().catch(() => null);
  } catch (cause) {
    throwIfVoiceTranscriptionAborted(signal);
    throw new VoiceTranscriptionError("transcription-failed", "Could not reach OpenAI.", {
      cause,
    });
  }
  if (!response.ok) {
    if (response.status === 401) forgetOnePasswordSecret("openaiApiKey");
    throw new VoiceTranscriptionError(
      "transcription-failed",
      openAiErrorMessage(body, response.status),
    );
  }
  if (typeof body !== "object" || body === null || !("text" in body)) return "";
  return typeof body.text === "string" ? body.text : "";
}

const openAiTranscriber: VoiceTranscriber = {
  prepare: async ({ signal }) => {
    let apiKey: string | null;
    try {
      apiKey = await resolveOnePasswordSecret("openaiApiKey");
    } catch (cause) {
      throwIfVoiceTranscriptionAborted(signal);
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new VoiceTranscriptionError("preparation-failed", detail, { cause });
    }
    throwIfVoiceTranscriptionAborted(signal);
    if (!apiKey) {
      throw new VoiceTranscriptionError(
        "preparation-failed",
        "1Password returned no OpenAI API key.",
      );
    }
    const key = apiKey;
    return {
      locale: navigator.language,
      transcribe: (uri, options) => transcribeRecording(key, uri, options.signal),
    };
  },
};

async function requestMicrophonePermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { granted: true, canAskAgain: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return { granted: false, canAskAgain: false };
    }
    throw error;
  }
}

export function createOpenAiVoiceInputController(input: {
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
}): VoiceInputController {
  const recorder = new MediaVoiceRecorder(
    (uri) =>
      void controller.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: uri,
      }),
    (message) => void controller.interruptRecording(message),
  );
  const controller: VoiceInputController = new VoiceInputController({
    recorder,
    getTranscriber: () => openAiTranscriber,
    requestPermission: requestMicrophonePermission,
    configureRecording: () => recorder.acquireMicrophone(),
    releaseRecording: async () => recorder.releaseMicrophone(),
    deleteRecording: (uri) => recordings.delete(uri),
    readDraft: input.readDraft,
    commitDraft: input.commitDraft,
    onStateChange: input.onStateChange,
  });
  return controller;
}
