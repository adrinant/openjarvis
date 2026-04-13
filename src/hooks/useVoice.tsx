import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { VoiceOrbOverlay } from "../voice/VoiceOrbOverlay";
import { pickRecorderMime, uint8ToBase64 } from "../voice/encode";
import { ACCENT_DIM_RGB, ACCENT_WARN_RGB } from "../terminal/renderer";

/** Energy-based end-of-utterance detection. */
const VAD_INTERVAL_MS = 45;
const VAD_RMS_THRESHOLD = 0.038;
const VAD_SILENCE_MS = 1350;
const VAD_MIN_RECORD_MS = 700;
const VAD_MAX_RECORD_MS = 60_000;
const WAKE_RESTART_MS = 500;
const WAKE_COOLDOWN_MS = 1800;
const CLAP_POLL_MS = 22;
const CLAP_THRESHOLD = 0.2;
const CLAP_MIN_GAP_MS = 120;
const CLAP_MAX_GAP_MS = 320;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

function normalizeWakeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type VoiceOptions = {
  onTranscript: (text: string) => void;
  onStatus?: (ansiLine: string) => void;
  onVoiceIdle?: () => void;
  onRecordingStart?: () => void;
  /** When true, mic capture is paused (assistant is responding). */
  assistantBusy: boolean;
};

function rmsFromTimeDomain(analyser: AnalyserNode, scratch: Uint8Array): number {
  analyser.getByteTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = (scratch[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / scratch.length);
}

export function useVoice(options: VoiceOptions): {
  voicePanel: ReactNode;
  voiceActive: boolean;
} {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [orbOpen, setOrbOpen] = useState(false);
  const orbOpenRef = useRef(false);
  const recordingRef = useRef(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string>("audio/webm");
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishingRef = useRef(false);
  const vadScratchRef = useRef<Uint8Array | null>(null);
  const { assistantBusy } = options;
  const wakeWordRaw = (import.meta.env.VITE_WAKE_WORD as string | undefined)?.trim();
  const wakeWord = wakeWordRaw && wakeWordRaw.length > 0 ? normalizeWakeText(wakeWordRaw) : "";
  const wakeWordEnabled = wakeWord.length > 0;
  const clapWakeEnabled =
    (import.meta.env.VITE_WAKE_DOUBLE_CLAP as string | undefined)?.trim() === "1";

  const setOrb = useCallback((open: boolean) => {
    orbOpenRef.current = open;
    setOrbOpen(open);
  }, []);

  const clearVad = useCallback(() => {
    if (vadIntervalRef.current !== null) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
  }, []);

  const cleanupMedia = useCallback(() => {
    clearVad();
    try {
      recorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    vadScratchRef.current = null;
  }, [clearVad]);

  const startVad = useCallback(
    (recordStartedAt: number) => {
      clearVad();
      let lastLoud = recordStartedAt;
      let sawSpeech = false;

      vadIntervalRef.current = setInterval(() => {
        if (finishingRef.current) return;
        if (optsRef.current.assistantBusy) return;
        const analyser = analyserRef.current;
        if (!analyser) return;

        let scratch = vadScratchRef.current;
        if (!scratch || scratch.length !== analyser.fftSize) {
          scratch = new Uint8Array(analyser.fftSize);
          vadScratchRef.current = scratch;
        }

        const rms = rmsFromTimeDomain(analyser, scratch);
        const now = performance.now();
        const elapsed = now - recordStartedAt;

        if (rms >= VAD_RMS_THRESHOLD) {
          lastLoud = now;
          sawSpeech = true;
        }

        const silenceOk =
          sawSpeech &&
          elapsed >= VAD_MIN_RECORD_MS &&
          now - lastLoud >= VAD_SILENCE_MS;

        if (silenceOk || elapsed >= VAD_MAX_RECORD_MS) {
          clearVad();
          recordingRef.current = false;
          void finalizeRecordingRef.current(false);
        }
      }, VAD_INTERVAL_MS);
    },
    [clearVad],
  );

  const beginTake = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !analyserRef.current || !audioCtxRef.current) return;
    if (finishingRef.current || optsRef.current.assistantBusy) return;
    if (recorderRef.current?.state === "recording") return;

    const mime = pickRecorderMime();
    mimeRef.current = mime ?? "audio/webm";
    const rec = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);

    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorderRef.current = rec;
    rec.start(250);
    recordingRef.current = true;
    startVad(performance.now());
  }, [startVad]);

  const finalizeRecordingRef = useRef<(discard: boolean) => Promise<void>>(
    async () => {},
  );

  const finalizeRecording = useCallback(
    async (discard: boolean) => {
      if (finishingRef.current) return;
      const rec = recorderRef.current;
      if (!rec || rec.state === "inactive") {
        if (discard) {
          cleanupMedia();
          setOrb(false);
          optsRef.current.onVoiceIdle?.();
        }
        return;
      }

      clearVad();
      finishingRef.current = true;
      recordingRef.current = false;

      const { onStatus, onVoiceIdle, onTranscript } = optsRef.current;

      await new Promise<void>((resolve) => {
        const done = () => {
          finishingRef.current = false;
          resolve();
        };

        rec.onstop = () => {
          void (async () => {
            try {
              if (discard) {
                cleanupMedia();
                setOrb(false);
                onVoiceIdle?.();
                return;
              }

              const blob = new Blob(chunksRef.current, {
                type: rec.mimeType || mimeRef.current,
              });
              chunksRef.current = [];
              recorderRef.current = null;

              const resumeIfIdle = () => {
                queueMicrotask(() => {
                  if (
                    !orbOpenRef.current ||
                    optsRef.current.assistantBusy ||
                    finishingRef.current
                  ) {
                    return;
                  }
                  if (!streamRef.current || !analyserRef.current) return;
                  beginTake();
                });
              };

              if (blob.size < 400) {
                onStatus?.(
                  "\r\n\x1b[38;2;112;112;126m[voice] No speech detected or transcription failed.\x1b[0m\r\n",
                );
                onVoiceIdle?.();
                resumeIfIdle();
                return;
              }

              const buf = await blob.arrayBuffer();
              const b64 = uint8ToBase64(new Uint8Array(buf));
              const ext = blob.type.includes("ogg")
                ? "rec.ogg"
                : blob.type.includes("webm")
                  ? "rec.webm"
                  : "rec.webm";
              const text = await invoke<string>("elevenlabs_transcribe_audio", {
                audioBase64: b64,
                filename: ext,
              });
              const trimmed = text?.trim() ?? "";
              if (trimmed) {
                onTranscript(trimmed);
              } else {
                onStatus?.(
                  "\r\n\x1b[38;2;112;112;126m[voice] No speech detected or transcription failed.\x1b[0m\r\n",
                );
                onVoiceIdle?.();
                resumeIfIdle();
              }
            } catch (e) {
              onStatus?.(
                `\r\n\x1b[38;2;${ACCENT_WARN_RGB.r};${ACCENT_WARN_RGB.g};${ACCENT_WARN_RGB.b}m[voice] ${String(e)}\x1b[0m\r\n`,
              );
              onVoiceIdle?.();
              queueMicrotask(() => {
                if (
                  orbOpenRef.current &&
                  !optsRef.current.assistantBusy &&
                  streamRef.current
                ) {
                  beginTake();
                }
              });
            } finally {
              done();
            }
          })();
        };
        try {
          rec.stop();
        } catch {
          cleanupMedia();
          setOrb(false);
          onVoiceIdle?.();
          done();
        }
      });
    },
    [cleanupMedia, clearVad, setOrb, beginTake],
  );

  finalizeRecordingRef.current = finalizeRecording;

  const openSession = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    analyserRef.current = analyser;

    setOrb(true);
    optsRef.current.onRecordingStart?.();
    beginTake();
  }, [beginTake, setOrb]);

  const cancelCapture = useCallback(() => {
    recordingRef.current = false;
    void finalizeRecording(true);
  }, [finalizeRecording]);

  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  const beginTakeRef = useRef(beginTake);
  beginTakeRef.current = beginTake;
  const finalizeShortcutRef = useRef(finalizeRecording);
  finalizeShortcutRef.current = finalizeRecording;
  const cleanupForUnmountRef = useRef(cleanupMedia);
  cleanupForUnmountRef.current = cleanupMedia;
  const setOrbRef = useRef(setOrb);
  setOrbRef.current = setOrb;
  const activateVoiceRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!orbOpen) return;
    if (assistantBusy) {
      clearVad();
      const r = recorderRef.current;
      if (r && r.state !== "inactive") {
        r.onstop = () => {
          chunksRef.current = [];
          recorderRef.current = null;
        };
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }
      recordingRef.current = false;
      return;
    }

    const tid = window.setTimeout(() => {
      if (!orbOpenRef.current || optsRef.current.assistantBusy) return;
      if (finishingRef.current) return;
      if (!streamRef.current || !analyserRef.current) return;
      if (recorderRef.current?.state === "recording") return;
      beginTake();
    }, 220);
    return () => window.clearTimeout(tid);
  }, [assistantBusy, orbOpen, clearVad, beginTake]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const register = (u: UnlistenFn) => {
      if (cancelled) void u();
      else unlisteners.push(u);
    };

    void (async () => {
      register(
        await listen<string>("voice_transcript", (e) => {
          const text = typeof e.payload === "string" ? e.payload : "";
          if (text.trim()) {
            optsRef.current.onTranscript(text);
          }
        }),
      );
      register(
        await listen<string>("voice_capture_error", (e) => {
          const msg =
            typeof e.payload === "string" ? e.payload : String(e.payload);
          optsRef.current.onStatus?.(
            `\r\n\x1b[38;2;${ACCENT_WARN_RGB.r};${ACCENT_WARN_RGB.g};${ACCENT_WARN_RGB.b}m[voice] ${msg}\x1b[0m\r\n`,
          );
          optsRef.current.onVoiceIdle?.();
        }),
      );
      register(await listen("activate_voice", () => activateVoiceRef.current()));
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => void u());
    };
  }, []);

  activateVoiceRef.current = () => {
    const { onStatus, onVoiceIdle, assistantBusy: ab } = optsRef.current;

    if (!recordingRef.current) {
      if (ab && !orbOpenRef.current) {
        onStatus?.(
          `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Wait for the assistant to finish, then try again.\x1b[0m\r\n`,
        );
        onVoiceIdle?.();
        return;
      }
      if (ab && orbOpenRef.current) {
        return;
      }
      if (
        orbOpenRef.current &&
        streamRef.current &&
        analyserRef.current &&
        !ab
      ) {
        recordingRef.current = true;
        beginTakeRef.current();
        void invoke("start_voice").catch(() => {});
        return;
      }

      recordingRef.current = true;
      finishingRef.current = false;
      void (async () => {
        try {
          await openSessionRef.current();
          void invoke("start_voice").catch(() => {});
        } catch (e) {
          recordingRef.current = false;
          setOrbRef.current(false);
          cleanupForUnmountRef.current();
          const msg = e instanceof Error ? e.message : "Microphone not available.";
          onStatus?.(
            `\r\n\x1b[38;2;${ACCENT_WARN_RGB.r};${ACCENT_WARN_RGB.g};${ACCENT_WARN_RGB.b}m[voice] ${msg}\x1b[0m\r\n`,
          );
          onVoiceIdle?.();
        }
      })();
      return;
    }

    recordingRef.current = false;
    void finalizeShortcutRef.current(false);
  };

  useEffect(() => {
    if (!wakeWordEnabled) return;

    const Ctor = (
      window as Window & {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
      }
    ).SpeechRecognition ??
      (
        window as Window & {
          SpeechRecognition?: SpeechRecognitionCtor;
          webkitSpeechRecognition?: SpeechRecognitionCtor;
        }
      ).webkitSpeechRecognition;

    if (!Ctor) {
      optsRef.current.onStatus?.(
        `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Wake word disabled: speech recognition unavailable in this runtime.\x1b[0m\r\n`,
      );
      return;
    }

    let stopped = false;
    let restartTimer: number | null = null;
    let lastWakeAt = 0;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    optsRef.current.onStatus?.(
      `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Wake word listening: "${wakeWord}".\x1b[0m\r\n`,
    );
    recognition.onerror = () => {};
    recognition.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const alt = event.results[i]?.[0];
        if (alt?.transcript) {
          parts.push(alt.transcript);
        }
      }
      const transcript = normalizeWakeText(parts.join(" "));
      if (!transcript || !transcript.includes(wakeWord)) return;
      const now = Date.now();
      if (now - lastWakeAt < WAKE_COOLDOWN_MS) return;
      lastWakeAt = now;
      activateVoiceRef.current();
    };
    recognition.onend = () => {
      if (stopped) return;
      restartTimer = window.setTimeout(() => {
        if (stopped) return;
        try {
          recognition.start();
        } catch {
          /* ignore transient restart failures */
        }
      }, WAKE_RESTART_MS);
    };

    try {
      recognition.start();
    } catch {
      optsRef.current.onStatus?.(
        `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Wake word failed to start. Check mic permission.\x1b[0m\r\n`,
      );
    }

    return () => {
      stopped = true;
      if (restartTimer !== null) {
        window.clearTimeout(restartTimer);
      }
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [wakeWordEnabled, wakeWord]);

  useEffect(() => {
    if (!clapWakeEnabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let timer: number | null = null;
    let scratch: Uint8Array | null = null;
    let lastClapAt = 0;
    let pendingFirstClapAt = 0;
    let lastWakeAt = 0;

    const stopAll = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      void ctx?.close().catch(() => {});
      ctx = null;
      analyser = null;
      scratch = null;
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
        });
        if (cancelled) {
          stopAll();
          return;
        }

        ctx = new AudioContext();
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        const source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.25;
        source.connect(analyser);
        scratch = new Uint8Array(analyser.fftSize);

        optsRef.current.onStatus?.(
          `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Fast double-clap wake listening.\x1b[0m\r\n`,
        );

        timer = window.setInterval(() => {
          if (cancelled || !analyser || !scratch) return;
          if (orbOpenRef.current || optsRef.current.assistantBusy) return;

          const level = rmsFromTimeDomain(analyser, scratch);
          if (level < CLAP_THRESHOLD) return;

          const now = Date.now();
          if (now - lastClapAt < CLAP_MIN_GAP_MS) return;
          lastClapAt = now;

          if (pendingFirstClapAt === 0 || now - pendingFirstClapAt > CLAP_MAX_GAP_MS) {
            pendingFirstClapAt = now;
            return;
          }

          if (now - pendingFirstClapAt >= CLAP_MIN_GAP_MS && now - pendingFirstClapAt <= CLAP_MAX_GAP_MS) {
            pendingFirstClapAt = 0;
            if (now - lastWakeAt < WAKE_COOLDOWN_MS) return;
            lastWakeAt = now;
            activateVoiceRef.current();
          }
        }, CLAP_POLL_MS);
      } catch {
        if (!cancelled) {
          optsRef.current.onStatus?.(
            `\r\n\x1b[38;2;${ACCENT_DIM_RGB.r};${ACCENT_DIM_RGB.g};${ACCENT_DIM_RGB.b}m[voice] Fast double-clap wake failed to start. Check mic permission.\x1b[0m\r\n`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [clapWakeEnabled]);

  useEffect(() => {
    return () => {
      cleanupForUnmountRef.current();
    };
  }, []);

  const voicePanel = orbOpen ? (
    <aside className="app-voice-sidebar" aria-label="Voice mode">
      <VoiceOrbOverlay analyserRef={analyserRef} onCancel={cancelCapture} />
    </aside>
  ) : null;

  return { voicePanel, voiceActive: orbOpen };
}
