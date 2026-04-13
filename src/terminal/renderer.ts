import type { Terminal } from "@xterm/xterm";

/** True-color foreground (matches reference/claurst TUI). */
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
/** True-color background */
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

/** Jarvis-style accent (golden yellow). */
export const ACCENT_RGB = { r: 251, g: 219, b: 100 } as const;
/** Softer gold for status / warnings (replaces red-orange). */
export const ACCENT_DIM_RGB = { r: 200, g: 175, b: 80 } as const;
/** Slightly muted gold for [error] labels (still on-theme). */
export const ACCENT_WARN_RGB = { r: 230, g: 200, b: 95 } as const;

export const T = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  /** TRANSCRIPT_TEXT */
  text: fg(236, 236, 241),
  /** TRANSCRIPT_MUTED */
  muted: fg(139, 139, 153),
  /** TRANSCRIPT_SUBTLE */
  subtle: fg(112, 112, 126),
  accent: fg(ACCENT_RGB.r, ACCENT_RGB.g, ACCENT_RGB.b),
  accentDim: fg(ACCENT_DIM_RGB.r, ACCENT_DIM_RGB.g, ACCENT_DIM_RGB.b),
  /** Bash `$` prompt green */
  shell: fg(76, 175, 80),
  /** Errors / alerts (golden, not red) */
  toolErr: fg(ACCENT_WARN_RGB.r, ACCENT_WARN_RGB.g, ACCENT_WARN_RGB.b),
} as const;

/** Heavy right-pointing angle quotation ornament (reference `PROMPT_POINTER`). */
const PROMPT_GLYPH = "\u276f";

export function writePrompt(term: Terminal) {
  term.write(`${T.bold}${T.accent}${PROMPT_GLYPH}${T.reset} `);
}

export function writeToolUse(term: Terminal, name: string) {
  term.write(`\r\n${T.subtle}   ${T.accent}~${T.reset} ${T.bold}${T.text}${name}${T.reset}\r\n`);
}

export function writeToolArgs(term: Terminal, args: string) {
  if (!args) return;
  term.write(`${T.dim}${T.muted}${args}${T.reset}\r\n`);
}

export function writeToolResult(term: Terminal, summary: string) {
  term.write(`${T.subtle}     ${T.dim}${T.muted}\u2192 ${summary}${T.reset}\r\n\r\n`);
}

export function writeVoicePrefix(term: Terminal) {
  term.write(
    `${T.bold}${bg(ACCENT_RGB.r, ACCENT_RGB.g, ACCENT_RGB.b)}${fg(0, 0, 0)} voice ${T.reset} `,
  );
}

export function writeError(term: Terminal, msg: string) {
  term.write(`${T.toolErr}${T.bold}[error]${T.reset} ${T.text}${msg}${T.reset}\r\n`);
}
