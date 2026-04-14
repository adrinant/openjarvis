/** Strip common Markdown so TTS does not read `**`, backticks, or link punctuation. */
export function stripMarkdownForSpeech(input: string): string {
  let s = input.replace(/\r\n/g, "\n");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\*{3}([^*]+?)\*{3}/g, "$1");
  s = s.replace(/\*{2}([^*]+?)\*{2}/g, "$1");
  s = s.replace(/_{3}([^_]+?)_{3}/g, "$1");
  s = s.replace(/_{2}([^_]+?)_{2}/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*([-*+])\s+/gm, "$1 ");
  s = s.replace(/^[\s*_-]{3,}\s*$/gm, " ");
  s = s.replace(/\*+/g, " ");
  s = s.replace(/_+/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

type Stream = {
  reset(): void;
  push(chunk: string): string;
  flush(): string;
};

/** Streaming Markdown → ANSI for xterm (`**` bold, `` ` `` dim, `__` bold). */
export function createMarkdownAnsiStream(): Stream {
  let bold = false;
  let code = false;
  let carry = "";

  function reset() {
    bold = false;
    code = false;
    carry = "";
  }

  function push(chunk: string): string {
    let s = carry + chunk;
    carry = "";

    if (!code && s.length > 0) {
      let t = s;
      while (t.length > 0 && t.endsWith("*")) {
        const n = t.match(/\*+$/)?.[0].length ?? 0;
        if (n >= 2) break;
        carry = t.slice(-1) + carry;
        t = t.slice(0, -1);
      }
      s = t;
    }

    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;

      if (code) {
        if (ch === "`") {
          code = false;
          out += DIM_OFF;
          if (bold) out += BOLD_ON;
          i += 1;
          continue;
        }
        if (ch === "\n") {
          out += "\r\n";
        } else if (ch === "\r") {
          /* skip bare CR */
        } else {
          out += ch;
        }
        i += 1;
        continue;
      }

      if (ch === "`") {
        code = true;
        if (bold) out += BOLD_OFF;
        out += DIM_ON;
        i += 1;
        continue;
      }

      if (i + 1 < s.length && ch === "*" && s[i + 1] === "*") {
        bold = !bold;
        out += bold ? BOLD_ON : BOLD_OFF;
        i += 2;
        continue;
      }

      if (i + 1 < s.length && ch === "_" && s[i + 1] === "_") {
        bold = !bold;
        out += bold ? BOLD_ON : BOLD_OFF;
        i += 2;
        continue;
      }

      if (ch === "\n") {
        out += "\r\n";
      } else if (ch !== "\r") {
        out += ch;
      }
      i += 1;
    }

    return out;
  }

  function flush(): string {
    let out = "";
    if (carry) {
      out += carry;
      carry = "";
    }
    if (code) {
      out += DIM_OFF;
      code = false;
    }
    if (bold) {
      out += BOLD_OFF;
      bold = false;
    }
    return out;
  }

  return { reset, push, flush };
}
