import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  writeError,
  writePrompt,
  writeToolArgs,
  writeToolResult,
  writeToolUse,
} from "./renderer";

import "@xterm/xterm/css/xterm.css";

export type TerminalHandle = {
  write: (data: string) => void;
  writePrompt: () => void;
  writeError: (msg: string) => void;
  writeToolUse: (name: string, args: string) => void;
  writeToolResult: (name: string, output: string) => void;
};

type Props = {
  onLine: (line: string) => void;
  busyRef: React.MutableRefObject<boolean>;
  /** When voice sidebar opens/closes, refit columns so the terminal layout updates. */
  voiceActive?: boolean;
};

const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { onLine, busyRef, voiceActive = false },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef("");
  const onLineRef = useRef(onLine);
  onLineRef.current = onLine;

  useImperativeHandle(ref, () => ({
    write: (data: string) => {
      termRef.current?.write(data);
    },
    writePrompt: () => {
      const t = termRef.current;
      if (t) writePrompt(t);
    },
    writeError: (msg: string) => {
      const t = termRef.current;
      if (t) writeError(t, msg);
    },
    writeToolUse: (name: string, args: string) => {
      const t = termRef.current;
      if (!t) return;
      writeToolUse(t, name);
      writeToolArgs(t, args);
    },
    writeToolResult: (name: string, output: string) => {
      const t = termRef.current;
      if (!t) return;
      writeToolResult(t, `${name}: ${output}`);
    },
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.25,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#000000",
        foreground: "#ececf1",
        cursor: "#fbdb64",
        cursorAccent: "#000000",
        selectionBackground: "rgba(251, 219, 100, 0.35)",
        black: "#000000",
        red: "#c9a84a",
        green: "#4caf50",
        yellow: "#ffab40",
        blue: "#64b5f6",
        magenta: "#fbdb64",
        cyan: "#4dd0e1",
        white: "#ececf1",
        brightBlack: "#70707e",
        brightRed: "#ffe9a8",
        brightGreen: "#81c784",
        brightYellow: "#ffe082",
        brightBlue: "#90caf9",
        brightMagenta: "#fff3a0",
        brightCyan: "#80deea",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;

    term.writeln(
      "\x1b[1m\x1b[38;2;251;219;100mOpenJarvis\x1b[0m\x1b[38;2;112;112;126m — terminal chat\x1b[0m",
    );
    term.writeln(
      "\x1b[38;2;139;139;153mCtrl+Shift+Space / Cmd+Shift+Space\x1b[38;2;112;112;126m · voice (ElevenLabs STT + TTS) · \x1b[38;2;139;139;153mCopy\x1b[38;2;112;112;126m: select, Ctrl/Cmd+C · \x1b[38;2;139;139;153mPaste\x1b[38;2;112;112;126m: Ctrl/Cmd+V\x1b[0m\r\n",
    );
    writePrompt(term);

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;

      const copyChord =
        mod && !event.altKey && (key === "c" || key === "C");

      if (copyChord && term.hasSelection()) {
        event.preventDefault();
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }

      const pasteChord =
        mod && !event.shiftKey && !event.altKey && (key === "v" || key === "V");
      if (pasteChord && !busyRef.current) {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          if (!text || busyRef.current) return;
          const line = text.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
          for (const ch of line) {
            const code = ch.charCodeAt(0);
            if (code >= 32 && code < 127) {
              lineRef.current += ch;
              term.write(ch);
            }
          }
        });
        return false;
      }

      return true;
    });

    const onData = (data: string) => {
      if (busyRef.current) return;
      if (data === "\r" || data === "\n") {
        const line = lineRef.current;
        lineRef.current = "";
        term.write("\r\n");
        onLineRef.current(line);
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (lineRef.current.length > 0) {
          lineRef.current = lineRef.current.slice(0, -1);
          term.write("\b \b");
        }
        return;
      }
      const code = data.charCodeAt(0);
      if (data.length === 1 && code >= 32 && code < 127) {
        lineRef.current += data;
        term.write(data);
      }
    };
    term.onData(onData);

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);
    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);

    return () => {
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [busyRef]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    let raf = 0;
    const id = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* xterm fit can throw if size is 0 briefly */
        }
        term.scrollToBottom();
      });
    });
    return () => {
      window.cancelAnimationFrame(id);
      window.cancelAnimationFrame(raf);
    };
  }, [voiceActive]);

  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        margin: 0,
        padding: "10px 14px 12px",
        background: "#000000",
      }}
    >
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
});

export default TerminalView;
