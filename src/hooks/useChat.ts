import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown;
};

export type ChatDoneMeta = {
  /** Text shown in the terminal / stored in history (stream first, else Rust extract). */
  assistantText: string;
  /** Best text for TTS (Rust extract first — often fuller when stream missed content). */
  ttsText: string;
  /** True when `sendUserMessage(..., { speakReply: true })` was used for this turn. */
  speakReply: boolean;
};

function toHistoryRow(m: ChatMessage): Record<string, unknown> {
  const o: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
  if (m.tool_calls) o.tool_calls = m.tool_calls;
  return o;
}

export function useChat(
  onToken: (chunk: string) => void,
  onDone: (meta: ChatDoneMeta) => void,
  onError: (msg: string) => void,
  onToolUse: (name: string, args: string) => void,
  onToolResult: (name: string, output: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const streamBuf = useRef("");
  const lastSpeakReplyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const register = (u: UnlistenFn) => {
      if (cancelled) void u();
      else unlisteners.push(u);
    };

    void (async () => {
      register(
        await listen<string>("token", (e) => {
          const chunk = typeof e.payload === "string" ? e.payload : "";
          if (!chunk) return;
          streamBuf.current += chunk;
          onToken(chunk);
        }),
      );
      register(
        await listen("done", (e) => {
          const fromStream = streamBuf.current;
          streamBuf.current = "";
          const speakReply = lastSpeakReplyRef.current;
          lastSpeakReplyRef.current = false;

          let fromRust = "";
          const pl = e.payload;
          let obj: unknown = pl;
          if (typeof pl === "string") {
            try {
              obj = JSON.parse(pl) as unknown;
            } catch {
              obj = null;
            }
          }
          if (obj != null && typeof obj === "object" && "assistantPlain" in obj) {
            const v = (obj as { assistantPlain?: unknown }).assistantPlain;
            if (typeof v === "string") fromRust = v;
          }

          const fs = fromStream.trim();
          const fr = fromRust.trim();
          const forHistory = fs || fr;
          const forTts = fr || fs;
          if (forHistory) {
            const assistant: ChatMessage = {
              role: "assistant",
              content: forHistory,
            };
            setMessages((prev) => {
              const next = [...prev, assistant];
              messagesRef.current = next;
              return next;
            });
          }
          setBusy(false);
          onDone({
            assistantText: forHistory,
            ttsText: forTts,
            speakReply,
          });
        }),
      );
      register(
        await listen<string>("error", (e) => {
          streamBuf.current = "";
          lastSpeakReplyRef.current = false;
          setBusy(false);
          const msg =
            typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
          onError(msg);
        }),
      );
      register(
        await listen<{ name: string; arguments: string }>("tool_use", (e) => {
          onToolUse(e.payload.name, e.payload.arguments);
        }),
      );
      register(
        await listen<{ name: string; output: string }>("tool_result", (e) => {
          onToolResult(e.payload.name, e.payload.output);
        }),
      );
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => void u());
    };
  }, [onToken, onDone, onError, onToolUse, onToolResult]);

  const sendUserMessage = useCallback(
    async (text: string, opts?: { speakReply?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      lastSpeakReplyRef.current = opts?.speakReply ?? false;
      setBusy(true);
      const prev = messagesRef.current;
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const next = [...prev, userMsg];
      messagesRef.current = next;
      setMessages(next);
      const history = next.map(toHistoryRow);
      const payload: {
        history: Record<string, unknown>[];
        speakReply?: boolean;
      } = { history };
      if (opts?.speakReply) {
        payload.speakReply = true;
      }
      try {
        await invoke("send_message", payload);
      } catch (e) {
        streamBuf.current = "";
        lastSpeakReplyRef.current = false;
        setBusy(false);
        onError(String(e));
      }
    },
    [busy, onError],
  );

  return { busy, messages, sendUserMessage };
}
