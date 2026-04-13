import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef } from "react";
import { useChat } from "./hooks/useChat";
import { useMcp } from "./hooks/useMcp";
import { useVoice } from "./hooks/useVoice";
import { ACCENT_RGB, T } from "./terminal/renderer";
import TerminalView, { type TerminalHandle } from "./terminal/Terminal";
import "./styles/terminal.css";

function App() {
  const termRef = useRef<TerminalHandle>(null);
  const busyRef = useRef(false);

  const onToken = useCallback((chunk: string) => {
    termRef.current?.write(chunk);
  }, []);

  const onDone = useCallback(
    (meta: {
      assistantText: string;
      ttsText: string;
      speakReply: boolean;
    }) => {
      termRef.current?.write("\r\n");
      termRef.current?.writePrompt();
      const raw = meta.ttsText.trim() || meta.assistantText.trim();
      if (meta.speakReply && raw) {
        const max = 6000;
        const chars = [...raw];
        const t =
          chars.length > max
            ? `${chars.slice(0, max).join("")}…`
            : chars.join("");
        void invoke("speak", { text: t }).catch((err) => {
          termRef.current?.write(
            `\r\n${T.subtle}[voice] Speech playback failed: ${String(err)}\x1b[0m\r\n`,
          );
          termRef.current?.writePrompt();
        });
      }
    },
    [],
  );

  const onError = useCallback((msg: string) => {
    termRef.current?.writeError(msg);
    termRef.current?.write("\r\n");
    termRef.current?.writePrompt();
  }, []);

  const onToolUse = useCallback((name: string, args: string) => {
    termRef.current?.writeToolUse(name, args);
  }, []);

  const onToolResult = useCallback((name: string, output: string) => {
    const summary =
      output.length > 200 ? `${output.slice(0, 200)}…` : output;
    termRef.current?.writeToolResult(name, summary);
  }, []);

  const { busy, sendUserMessage } = useChat(
    onToken,
    onDone,
    onError,
    onToolUse,
    onToolResult,
  );

  busyRef.current = busy;

  useMcp();

  const { voicePanel, voiceActive } = useVoice({
    assistantBusy: busy,
    onRecordingStart: () => {
      const t = termRef.current;
      if (!t) return;
      t.write(
        `\r\n${T.accentDim}\x1b[1m[voice]\x1b[0m ${T.subtle}Voice session on — pause after each phrase to send; Esc to exit.\x1b[0m\r\n`,
      );
      t.writePrompt();
    },
    onTranscript: (text) => {
      const t = termRef.current;
      if (!t) return;
      const safe = text.replace(/\u001b/g, "").replace(/\r|\n/g, " ");
      t.write(
        `\r\n\x1b[38;2;${ACCENT_RGB.r};${ACCENT_RGB.g};${ACCENT_RGB.b}m\x1b[1m[voice]\x1b[0m \x1b[38;2;236;236;241m${safe}\x1b[0m\r\n`,
      );
      void sendUserMessage(text, { speakReply: true });
    },
    onStatus: (line) => {
      termRef.current?.write(line);
    },
    onVoiceIdle: () => {
      termRef.current?.writePrompt();
    },
  });

  const onLine = useCallback(
    (line: string) => {
      void sendUserMessage(line);
    },
    [sendUserMessage],
  );

  return (
    <div className="app-root">
      <div className="app-main">
        <TerminalView
          ref={termRef}
          onLine={onLine}
          busyRef={busyRef}
          voiceActive={voiceActive}
        />
      </div>
      {voicePanel}
    </div>
  );
}

export default App;
