/**
 * AlphaResin's lexer: Pine-compatible source (v5 and v6) to tokens.
 *
 * Pine is line-based. A logical line ends at a newline unless it continues:
 *   - inside brackets ( ) [ ], or
 *   - on a following line indented by a number of spaces that is not a
 *     multiple of four (Pine's line-wrapping rule; multiples of four open
 *     local blocks).
 * Block structure comes out as INDENT / DEDENT tokens, as in Python. A tab
 * counts as four spaces. Comments run from `//` to the end of the line;
 * `//@name value` comments are compiler annotations and are collected.
 */

export type TokenKind = "number" | "string" | "color" | "ident" | "keyword" | "op" | "newline" | "indent" | "dedent" | "eof";

export interface Pos {
  line: number;
  col: number;
}

export interface Token extends Pos {
  kind: TokenKind;
  value: string;
}

export interface Annotation extends Pos {
  name: string;
  value: string;
}

export class ResinSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${message} (line ${line}, column ${col})`);
    this.name = "ResinSyntaxError";
  }
}

export const KEYWORDS = new Set([
  "and", "or", "not", "if", "else", "for", "to", "by", "in", "while", "switch", "var", "varip",
  "import", "export", "method", "type", "enum", "true", "false", "break", "continue", "as",
]);

/** Longest first, so `:=` wins over `:` and `==` over `=`. */
const OPERATORS = ["=>", ":=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "<", ">", "=", "?", ":", ",", ".", "(", ")", "[", "]"];

/** An operator that, ending a line, says the expression goes on. */
const CONTINUES = new Set(["+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==", "!=", "?", ":", ",", "and", "or", "not", "=", ":=", "+=", "-=", "*=", "/=", "%="]);

export interface Lexed {
  tokens: Token[];
  annotations: Annotation[];
  /** From `//@version=N`; null when the script doesn't say. */
  version: number | null;
}

interface Physical {
  line: number;
  indent: number;
  text: string;
  /** Column of `text` in the source line (1-based). */
  col: number;
}

/** A line split into code and comment, minding `//` inside strings. */
function splitComment(raw: string): { code: string; comment: string | null } {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "/" && raw[i + 1] === "/") return { code: raw.slice(0, i), comment: raw.slice(i + 2) };
  }
  return { code: raw, comment: null };
}

function indentOf(text: string): number {
  let n = 0;
  for (const c of text) {
    if (c === " ") n += 1;
    else if (c === "\t") n += 4;
    else break;
  }
  return n;
}

export function lex(source: string): Lexed {
  const annotations: Annotation[] = [];
  const lines: Physical[] = [];
  source
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/)
    .forEach((raw, k) => {
      const { code, comment } = splitComment(raw);
      if (comment !== null) {
        const m = /^@(\w+)(?:\s*=\s*|\s+)?(.*)$/.exec(comment.trim());
        if (m && code.trim() === "") annotations.push({ name: m[1]!, value: m[2]!.trim(), line: k + 1, col: raw.indexOf("//") + 1 });
      }
      if (code.trim() === "") return;
      const indent = indentOf(code);
      const lead = code.length - code.trimStart().length;
      lines.push({ line: k + 1, indent, text: code.trimEnd().slice(lead), col: lead + 1 });
    });

  const tokens: Token[] = [];
  const stack = [0];
  let depth = 0;
  let last: Token | null = null;
  const push = (t: Token) => {
    tokens.push(t);
    last = t;
  };

  for (const ph of lines) {
    const lastToken = last as Token | null;
    const wraps =
      tokens.length > 0 &&
      (depth > 0 ||
        // Pine's rule: a wrapped line is indented by a non-multiple of four.
        (ph.indent % 4 !== 0 && ph.indent > stack[stack.length - 1]!) ||
        // A line can't end on an operator: what follows continues it.
        (lastToken !== null && (lastToken.kind === "op" || lastToken.kind === "keyword") && CONTINUES.has(lastToken.value) && ph.indent > stack[stack.length - 1]!));
    if (!wraps) {
      if (tokens.length > 0) push({ kind: "newline", value: "", line: ph.line, col: 1 });
      if (ph.indent % 4 !== 0) throw new ResinSyntaxError("Indentation must be a multiple of 4 spaces (or a tab) for a block", ph.line, 1);
      const top = stack[stack.length - 1]!;
      if (ph.indent > top) {
        if (ph.indent !== top + 4) throw new ResinSyntaxError("A block is indented one level (4 spaces) deeper than its parent", ph.line, 1);
        stack.push(ph.indent);
        push({ kind: "indent", value: "", line: ph.line, col: 1 });
      } else {
        while (ph.indent < stack[stack.length - 1]!) {
          stack.pop();
          push({ kind: "dedent", value: "", line: ph.line, col: 1 });
        }
        if (ph.indent !== stack[stack.length - 1]) throw new ResinSyntaxError("This line's indentation matches no open block", ph.line, 1);
      }
    }
    depth = scanLine(ph, tokens, depth, push);
  }
  if (depth > 0) throw new ResinSyntaxError("A bracket is never closed", lines[lines.length - 1]?.line ?? 1, 1);
  const end = (lines[lines.length - 1]?.line ?? 0) + 1;
  if (tokens.length > 0) tokens.push({ kind: "newline", value: "", line: end, col: 1 });
  while (stack.length > 1) {
    stack.pop();
    tokens.push({ kind: "dedent", value: "", line: end, col: 1 });
  }
  tokens.push({ kind: "eof", value: "", line: end, col: 1 });

  const v = annotations.find((a) => a.name === "version");
  const version = v && /^\d+$/.test(v.value) ? Number(v.value) : null;
  return { tokens, annotations, version };
}

/** Tokens of one physical line; returns the bracket depth after it. */
function scanLine(ph: Physical, out: Token[], depth: number, push: (t: Token) => void): number {
  const s = ph.text;
  let i = 0;
  const at = (k: number) => ({ line: ph.line, col: ph.col + k });
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const start = i;
    // Numbers: 12, 1.5, .5, 1., 1e3, 2.5E-4.
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i))!;
      i += m[0].length;
      push({ kind: "number", value: m[0], ...at(start) });
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= s.length) throw new ResinSyntaxError("A string is never closed", ph.line, ph.col + start);
        const d = s[i]!;
        if (d === c) {
          i++;
          break;
        }
        if (d === "\\") {
          const e = s[i + 1] ?? "";
          value += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6)) ? String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)) : e;
          i += e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6)) ? 6 : 2;
          continue;
        }
        value += d;
        i++;
      }
      push({ kind: "string", value, ...at(start) });
      continue;
    }
    if (c === "#") {
      const m = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/.exec(s.slice(i));
      if (!m) throw new ResinSyntaxError("A colour literal is #RRGGBB or #RRGGBBAA", ph.line, ph.col + start);
      i += m[0].length;
      push({ kind: "color", value: m[0].toLowerCase(), ...at(start) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))!;
      i += m[0].length;
      push({ kind: KEYWORDS.has(m[0]) ? "keyword" : "ident", value: m[0], ...at(start) });
      continue;
    }
    const op = OPERATORS.find((o) => s.startsWith(o, i));
    if (!op) throw new ResinSyntaxError(`Unexpected character "${c}"`, ph.line, ph.col + start);
    i += op.length;
    if (op === "(" || op === "[") depth++;
    else if (op === ")" || op === "]") {
      depth--;
      if (depth < 0) throw new ResinSyntaxError(`"${op}" closes nothing`, ph.line, ph.col + start);
    }
    push({ kind: "op", value: op, ...at(start) });
  }
  void out;
  return depth;
}
