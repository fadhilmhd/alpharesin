import type * as A from "./ast";
import { parse } from "./parser";

/**
 * Libraries: `import user/Name/3 as alias` resolved against library sources
 * the user supplied (a library's own script, as TradingView shows an open
 * one). The library's declarations join the script under `alias__name`, and
 * the script's `alias.f(…)`, `alias.T.new(…)` and `alias.E.member` read them.
 * Methods keep their names: they're called on values, by name.
 */

export interface LibrarySource {
  /** `user/Name` as imported, when known; otherwise the library's own title names it. */
  path?: string;
  source: string;
}

export interface Linked {
  script: A.Script;
  /** Imports no supplied library matched, by their path. */
  missing: A.ImportStmt[];
  /** Libraries that failed to parse, by import path, with the reason. */
  broken: { at: A.ImportStmt; message: string }[];
}

const MAX_DEPTH = 4;

/** The name a library declares: `library("Name", …)`. */
export function libraryTitle(script: A.Script): string | null {
  for (const s of script.body) {
    if (s.kind === "ExprStmt" && s.expr.kind === "Call" && s.expr.callee.kind === "Ident" && s.expr.callee.name === "library") {
      const t = s.expr.args.find((a) => a.name === null || a.name === "title")?.value;
      return t?.kind === "String" ? t.value : null;
    }
  }
  return null;
}

/** Whether a parsed script is a library (declares `library(…)`). */
export const isLibrary = (script: A.Script) => libraryTitle(script) !== null;

function find<L extends { path: string | null; title: string | null }>(libs: L[], path: string): L | undefined {
  const [user, name] = path.split("/");
  const lower = (x: string | null | undefined) => (x ?? "").toLowerCase();
  return (
    libs.find((l) => l.path !== null && lower(l.path) === lower(`${user}/${name}`)) ??
    libs.find((l) => lower(l.title) === lower(name) || lower(l.path?.split("/")[1]) === lower(name))
  );
}

/** Names a function body declares for itself (not inside nested functions): they hide the library's. */
function locals(stmts: A.Stmt[]): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as { kind?: string };
    if (n.kind === "FunctionDecl") return;
    if (n.kind === "VarDecl") out.push((n as A.VarDecl).name);
    if (n.kind === "TupleDecl") out.push(...(n as A.TupleDecl).names);
    if (n.kind === "For") out.push((n as A.ForNode).counter);
    if (n.kind === "ForIn") out.push(...(n as A.ForInNode).names);
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
  };
  visit(stmts);
  return out;
}

/** Rename every reference to `names` (identifiers and type names) through `to`; locals that shadow them are left alone. */
function rename(node: unknown, names: Map<string, string>, shadow: Set<string> = new Set()): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => rename(n, names, shadow));
  const n = node as Record<string, unknown> & { kind?: string };
  if (n.kind === "FunctionDecl") {
    const f = n as unknown as A.FunctionDecl;
    const inner = new Set([...shadow, ...f.params.map((p) => p.name), ...locals(f.body)]);
    for (const p of f.params) {
      rename(p.type, names, inner);
      rename(p.default, names, inner);
    }
    return rename(f.body, names, inner);
  }
  if (n.kind === "Ident") {
    const to = names.get(n.name as string);
    if (to && !shadow.has(n.name as string)) n.name = to;
    return;
  }
  if (n.kind === "Type") {
    const t = n as unknown as A.TypeRef;
    const to = names.get(t.name);
    if (to) t.name = to;
    return t.args.forEach((a) => rename(a, names, shadow));
  }
  for (const [k, v] of Object.entries(n)) if (k !== "kind" && v && typeof v === "object") rename(v, names, shadow);
}

/**
 * `alias.X` → the library's `X` (\`alias__X\`; a method keeps its name), for
 * the names each library declares. Anything else under the alias is left as
 * written: a library imported as \`ta\` adds to the built-in \`ta.*\`, it
 * doesn't hide it.
 */
function readThrough(node: unknown, aliases: Map<string, Map<string, string>>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => readThrough(n, aliases));
  const n = node as Record<string, unknown> & { kind?: string };
  if (n.kind === "Member") {
    const m = n as unknown as A.Member;
    const to = m.object.kind === "Ident" ? aliases.get(m.object.name)?.get(m.name) : undefined;
    if (to) {
      delete (n as Record<string, unknown>).object;
      n.kind = "Ident";
      n.name = to;
      return;
    }
  }
  if (n.kind === "Type") {
    const t = n as unknown as A.TypeRef;
    const dot = t.name.indexOf(".");
    const to = dot > 0 ? aliases.get(t.name.slice(0, dot))?.get(t.name.slice(dot + 1)) : undefined;
    if (to) t.name = to;
  }
  for (const [k, v] of Object.entries(n)) if (k !== "kind" && v && typeof v === "object") readThrough(v, aliases);
}

/** Resolve a script's imports against `libraries`, recursively. */
export function link(script: A.Script, libraries: LibrarySource[], depth = 0): Linked {
  const imports = script.body.filter((s): s is A.ImportStmt => s.kind === "ImportStmt");
  if (imports.length === 0) return { script, missing: [], broken: [] };
  const parsed = libraries.flatMap((l) => {
    try {
      const s = parse(l.source);
      return [{ path: l.path ?? null, title: libraryTitle(s), script: s, source: l.source }];
    } catch {
      return [];
    }
  });
  const missing: A.ImportStmt[] = [];
  const broken: Linked["broken"] = [];
  const decls: A.Stmt[] = [];
  const aliases = new Map<string, Map<string, string>>();
  for (const imp of imports) {
    const lib = find(parsed, imp.path);
    if (!lib || depth >= MAX_DEPTH) {
      missing.push(imp);
      continue;
    }
    const alias = imp.alias ?? imp.path.split("/")[1]!;
    // A fresh copy per import (two aliases of one library must not share renamed nodes), with its own imports linked first.
    const inner = link(parse(lib.source), libraries, depth + 1);
    missing.push(...inner.missing);
    broken.push(...inner.broken);
    const body = inner.script.body.filter((s) => s.kind !== "ImportStmt" && !(s.kind === "ExprStmt" && s.expr.kind === "Call" && s.expr.callee.kind === "Ident" && s.expr.callee.name === "library"));
    const names = new Map<string, string>();
    for (const s of body) {
      if ((s.kind === "FunctionDecl" && !s.method) || s.kind === "TypeDecl" || s.kind === "EnumDecl" || s.kind === "VarDecl") names.set(s.name, `${alias}__${s.name}`);
    }
    rename(body, names);
    // What the script may read through the alias: the renamed declarations, and methods by their own name.
    const visible = new Map(names);
    for (const s of body) if (s.kind === "FunctionDecl" && s.method) visible.set(s.name, s.name);
    aliases.set(alias, new Map([...(aliases.get(alias) ?? []), ...visible]));
    for (const s of body) if ("name" in s && typeof s.name === "string" && names.has(s.name) && s.kind !== "VarDecl") (s as { name: string }).name = names.get(s.name)!;
    for (const s of body) if (s.kind === "VarDecl" && names.has(s.name)) s.name = names.get(s.name)!;
    decls.push(...body);
  }
  const rest = script.body.filter((s) => s.kind !== "ImportStmt" || missing.includes(s));
  readThrough(rest, aliases);
  return { script: { ...script, body: [...decls, ...rest] }, missing, broken };
}
