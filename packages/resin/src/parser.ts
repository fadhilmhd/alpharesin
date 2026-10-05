import type * as A from "./ast";
import { lex, ResinSyntaxError, type Token } from "./lexer";

/**
 * AlphaResin's parser: tokens to a syntax tree, by recursive descent. It reads
 * the language of v5 and v6 (both share their syntax; where the versions
 * differ in meaning, later stages read `Script.version`).
 *
 * Operator precedence, loosest first: `?:`, `or`, `and`, `== !=`,
 * `< > <= >=`, `+ -`, `* / %`, unary `+ - not`, then calls, members and the
 * history operator `[]`.
 */

const QUALIFIERS = new Set(["const", "simple", "series", "input"]);
const ASSIGN_OPS = new Set([":=", "+=", "-=", "*=", "/=", "%="]);

/** The language versions AlphaResin reads. */
export const VERSIONS = [5, 6] as const;

export function parse(source: string): A.Script {
  const { tokens, annotations, version } = lex(source);
  const v = annotations.find((x) => x.name === "version");
  if (version === null || !(VERSIONS as readonly number[]).includes(version)) {
    const said = version === null ? "doesn't say its version (//@version=6 on the first line)" : `is version ${version}`;
    throw new ResinSyntaxError(`AlphaResin reads versions 5 and 6; this script ${said}. TradingView's Pine Editor can convert an older script to v6`, v?.line ?? 1, v?.col ?? 1);
  }
  const p = new Parser(softKeywords(tokens));
  const body = p.statements(true);
  return { kind: "Script", version, annotations, body };
}

/**
 * \`type\`, \`enum\` and \`method\` are keywords only where they start a
 * declaration (\`type Name\` / \`enum Name\` ending the line at the start of a
 * statement, \`method name(\`). Elsewhere scripts use them as names:
 * \`ma(src, len, type) =>\`, \`type = "SMA"\`, \`string type = "free"\`.
 */
function softKeywords(tokens: Token[]): Token[] {
  return tokens.map((tok, k) => {
    if (tok.kind !== "keyword" || !["type", "enum", "method"].includes(tok.value)) return tok;
    const prev = tokens[k - 1];
    const startsStatement = !prev || ["newline", "indent", "dedent"].includes(prev.kind) || (prev.kind === "keyword" && prev.value === "export");
    const next = tokens[k + 1];
    const after = tokens[k + 2];
    const declares =
      startsStatement &&
      next?.kind === "ident" &&
      (tok.value === "method" ? after?.kind === "op" && after.value === "(" : !after || after.kind === "newline" || after.kind === "eof");
    return declares ? tok : { ...tok, kind: "ident" };
  });
}

class Parser {
  private i = 0;
  constructor(private readonly t: Token[]) {}

  // ---------------- token helpers ----------------

  private peek(k = 0): Token {
    return this.t[Math.min(this.i + k, this.t.length - 1)]!;
  }
  private next(): Token {
    const tok = this.peek();
    if (this.i < this.t.length - 1) this.i++;
    return tok;
  }
  private is(kind: Token["kind"], value?: string, k = 0): boolean {
    const tok = this.peek(k);
    return tok.kind === kind && (value === undefined || tok.value === value);
  }
  private isOp(value: string, k = 0) {
    return this.is("op", value, k);
  }
  private isKw(value: string, k = 0) {
    return this.is("keyword", value, k);
  }
  private fail(message: string, tok: Token = this.peek()): never {
    const found = tok.kind === "newline" ? "the end of the line" : tok.kind === "eof" ? "the end of the script" : tok.kind === "indent" || tok.kind === "dedent" ? "a change of indentation" : `"${tok.value}"`;
    throw new ResinSyntaxError(`${message}, found ${found}`, tok.line, tok.col);
  }
  private expectOp(value: string): Token {
    if (!this.isOp(value)) this.fail(`Expected "${value}"`);
    return this.next();
  }
  private expectKw(value: string): Token {
    if (!this.isKw(value)) this.fail(`Expected "${value}"`);
    return this.next();
  }
  private ident(what = "a name"): Token {
    if (!this.is("ident")) this.fail(`Expected ${what}`);
    return this.next();
  }
  /** A name after a dot may be a keyword too: `syminfo.type`, `strategy.long`. */
  private memberName(): Token {
    if (this.is("ident") || this.is("keyword")) return this.next();
    return this.fail("Expected a name after the dot");
  }
  private pos(tok: Token): { line: number; col: number } {
    return { line: tok.line, col: tok.col };
  }
  /** Try a parse; on a syntax error, rewind and return null. */
  private attempt<T>(fn: () => T): T | null {
    const save = this.i;
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ResinSyntaxError)) throw e;
      this.i = save;
      return null;
    }
  }
  private skipNewlines() {
    while (this.is("newline")) this.next();
  }

  // ---------------- statements ----------------

  /** Statements up to a dedent (a block) or the end (the script). */
  statements(top = false): A.Stmt[] {
    const out: A.Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.is("eof")) {
        if (!top) this.fail("Expected the block to end");
        return out;
      }
      if (this.is("dedent")) {
        if (top) this.fail("Unexpected change of indentation");
        return out;
      }
      out.push(...this.line());
    }
  }

  /** One logical line: one or more statements separated by commas. */
  private line(): A.Stmt[] {
    const out = [this.statement()];
    while (this.isOp(",")) {
      this.next();
      // A comma may end the line too: `a = 1, b = 2,`.
      if (this.is("newline") || this.is("eof") || this.is("dedent")) break;
      out.push(this.statement());
    }
    const prev = this.t[this.i - 1];
    // A statement that ended with its own block has already reached the next line.
    if (prev?.kind !== "dedent" && !this.is("newline") && !this.is("eof") && !this.is("dedent")) this.fail("Expected the end of the line");
    return out;
  }

  /** `NEWLINE INDENT statements DEDENT`. */
  private block(): A.Stmt[] {
    if (!this.is("newline")) this.fail("Expected a new line with an indented block");
    this.skipNewlines();
    if (!this.is("indent")) this.fail("Expected an indented block (4 spaces deeper)");
    this.next();
    const body = this.statements();
    this.next(); // dedent
    return body;
  }

  /** After `=>`: the rest of the line, or an indented block. */
  private arrowBody(): A.Stmt[] {
    if (this.is("newline")) return this.block();
    const out = [this.statement()];
    while (this.isOp(",")) {
      this.next();
      // A comma may end the line too: `a = 1, b = 2,`.
      if (this.is("newline") || this.is("eof") || this.is("dedent")) break;
      out.push(this.statement());
    }
    return out;
  }

  private statement(): A.Stmt {
    const tok = this.peek();
    if (tok.kind === "keyword") {
      switch (tok.value) {
        case "import":
          return this.importStmt();
        case "export":
          return this.exported();
        case "type":
          return this.typeDecl(false);
        case "enum":
          return this.enumDecl(false);
        case "method":
          return this.functionDecl(false);
        case "break":
          this.next();
          return { kind: "Break", ...this.pos(tok) };
        case "continue":
          this.next();
          return { kind: "Continue", ...this.pos(tok) };
        case "if":
        case "for":
        case "while":
        case "switch":
          return this.control() as A.Stmt;
        case "var":
        case "varip":
          return this.varDecl();
      }
    }
    if (this.isFunctionStart()) return this.functionDecl(false);
    if (this.isOp("[")) {
      const tuple = this.attempt(() => this.tupleDecl());
      if (tuple) return tuple;
    }
    const decl = this.attempt(() => this.varDecl());
    if (decl) return decl;
    const expr = this.expr();
    if (this.is("op") && ASSIGN_OPS.has(this.peek().value)) {
      if (expr.kind !== "Ident" && expr.kind !== "Member") this.fail("Only a variable or a field can be assigned");
      const op = this.next().value as A.Assign["op"];
      return { kind: "Assign", op, target: expr, value: this.expr(), line: expr.line, col: expr.col };
    }
    return { kind: "ExprStmt", expr, line: expr.line, col: expr.col };
  }

  private exported(): A.Stmt {
    this.expectKw("export");
    if (this.isKw("type")) return this.typeDecl(true);
    if (this.isKw("enum")) return this.enumDecl(true);
    return this.functionDecl(true);
  }

  private importStmt(): A.ImportStmt {
    const start = this.expectKw("import");
    let path = "";
    while (!this.is("newline") && !this.is("eof") && !this.isKw("as")) path += this.next().value;
    if (!/^[\w]+\/[\w]+\/\d+$/.test(path)) this.fail("An import reads `import user/library/version`", start);
    let alias: string | null = null;
    if (this.isKw("as")) {
      this.next();
      alias = this.ident("an alias").value;
    }
    return { kind: "ImportStmt", path, alias, ...this.pos(start) };
  }

  private typeDecl(exported: boolean): A.TypeDecl {
    const start = this.expectKw("type");
    const name = this.ident("a type name").value;
    if (!this.is("newline")) this.fail("Expected the type's fields on the following lines");
    this.skipNewlines();
    if (!this.is("indent")) this.fail("Expected the type's fields, indented");
    this.next();
    const fields: A.Field[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.is("dedent") || this.is("eof")) break;
      const at = this.peek();
      const varip = this.isKw("varip") ? (this.next(), true) : false;
      const type = this.typeRef();
      const field = this.ident("a field name").value;
      const def = this.isOp("=") ? (this.next(), this.expr()) : null;
      fields.push({ name: field, type, varip, default: def, ...this.pos(at) });
    }
    if (this.is("dedent")) this.next();
    return { kind: "TypeDecl", name, exported, fields, ...this.pos(start) };
  }

  private enumDecl(exported: boolean): A.EnumDecl {
    const start = this.expectKw("enum");
    const name = this.ident("an enum name").value;
    if (!this.is("newline")) this.fail("Expected the enum's members on the following lines");
    this.skipNewlines();
    if (!this.is("indent")) this.fail("Expected the enum's members, indented");
    this.next();
    const members: A.EnumDecl["members"] = [];
    for (;;) {
      this.skipNewlines();
      if (this.is("dedent") || this.is("eof")) break;
      const m = this.ident("an enum member");
      let title: string | null = null;
      if (this.isOp("=")) {
        this.next();
        if (!this.is("string")) this.fail("An enum member's title is a string");
        title = this.next().value;
      }
      members.push({ name: m.value, title, ...this.pos(m) });
    }
    if (this.is("dedent")) this.next();
    return { kind: "EnumDecl", name, exported, members, ...this.pos(start) };
  }

  /** `name(` … matching `)` `=>`, after an optional `method`. */
  private isFunctionStart(): boolean {
    let k = 0;
    if (this.isKw("method", k)) k++;
    if (!this.is("ident", undefined, k) || !this.isOp("(", k + 1)) return false;
    let depth = 0;
    for (let j = k + 1; ; j++) {
      const tok = this.peek(j);
      if (tok.kind === "eof" || tok.kind === "newline") return false;
      if (tok.kind === "op" && (tok.value === "(" || tok.value === "[")) depth++;
      if (tok.kind === "op" && (tok.value === ")" || tok.value === "]")) {
        depth--;
        if (depth === 0) return this.isOp("=>", j + 1);
      }
    }
  }

  private functionDecl(exported: boolean): A.FunctionDecl {
    const start = this.peek();
    const method = this.isKw("method") ? (this.next(), true) : false;
    const name = this.ident("a function name").value;
    this.expectOp("(");
    const params: A.Param[] = [];
    while (!this.isOp(")")) {
      params.push(this.param());
      if (!this.isOp(")")) this.expectOp(",");
    }
    this.expectOp(")");
    this.expectOp("=>");
    const body = this.arrowBody();
    return { kind: "FunctionDecl", name, exported, method, params, body, ...this.pos(start) };
  }

  private param(): A.Param {
    const start = this.peek();
    const qualifier = this.qualifier();
    // `float x`, `array<int> a`, `chart.point p`, or just `x`.
    const typed = this.attempt(() => {
      const type = this.typeRef();
      if (!this.is("ident")) this.fail("Expected a parameter name");
      return type;
    });
    const name = this.ident("a parameter name").value;
    const def = this.isOp("=") ? (this.next(), this.expr()) : null;
    return { name, type: typed, qualifier, default: def, ...this.pos(start) };
  }

  /** `const`, `simple`, `series` or `input` before a type (not `input.int(…)`). */
  private qualifier(): A.Qualifier | null {
    const tok = this.peek();
    if (tok.kind === "ident" && QUALIFIERS.has(tok.value) && this.is("ident", undefined, 1)) {
      this.next();
      return tok.value as A.Qualifier;
    }
    return null;
  }

  private typeRef(): A.TypeRef {
    const start = this.ident("a type");
    let name = start.value;
    while (this.isOp(".") && this.is("ident", undefined, 1)) {
      this.next();
      name += `.${this.next().value}`;
    }
    const args: A.TypeRef[] = [];
    if (this.isOp("<")) {
      this.next();
      args.push(this.typeRef());
      while (this.isOp(",")) {
        this.next();
        args.push(this.typeRef());
      }
      this.expectOp(">");
    }
    let array = false;
    if (this.isOp("[") && this.isOp("]", 1)) {
      this.next();
      this.next();
      array = true;
    }
    return { kind: "Type", name, args, array, ...this.pos(start) };
  }

  /** `[var|varip] [qualifier] [type] name = value`. */
  private varDecl(): A.VarDecl {
    const start = this.peek();
    const mode = this.isKw("var") ? "var" : this.isKw("varip") ? "varip" : null;
    if (mode) this.next();
    const qualifier = this.qualifier();
    const type = this.attempt(() => {
      const ty = this.typeRef();
      if (!this.is("ident") || !this.isOp("=", 1)) this.fail("Not a typed declaration");
      return ty;
    });
    const name = this.ident("a variable name").value;
    this.expectOp("=");
    const value = this.expr();
    return { kind: "VarDecl", mode, qualifier, type, name, value, ...this.pos(start) };
  }

  private tupleDecl(): A.TupleDecl {
    const start = this.expectOp("[");
    const names = [this.ident().value];
    while (this.isOp(",")) {
      this.next();
      names.push(this.ident().value);
    }
    this.expectOp("]");
    this.expectOp("=");
    return { kind: "TupleDecl", names, value: this.expr(), ...this.pos(start) };
  }

  // ---------------- control flow ----------------

  private control(): A.IfNode | A.ForNode | A.ForInNode | A.WhileNode | A.SwitchNode {
    const tok = this.peek();
    switch (tok.value) {
      case "if":
        return this.ifNode();
      case "for":
        return this.forNode();
      case "while": {
        this.next();
        const cond = this.expr();
        return { kind: "While", cond, body: this.block(), ...this.pos(tok) };
      }
      default:
        return this.switchNode();
    }
  }

  private ifNode(): A.IfNode {
    const start = this.expectKw("if");
    const cond = this.expr();
    const then = this.block();
    let otherwise: A.IfNode["else"] = null;
    if (this.isKw("else")) {
      this.next();
      otherwise = this.isKw("if") ? this.ifNode() : this.block();
    }
    return { kind: "If", cond, then, else: otherwise, ...this.pos(start) };
  }

  private forNode(): A.ForNode | A.ForInNode {
    const start = this.expectKw("for");
    if (this.isOp("[")) {
      this.next();
      const names = [this.ident().value];
      this.expectOp(",");
      names.push(this.ident().value);
      this.expectOp("]");
      this.expectKw("in");
      const iterable = this.expr();
      return { kind: "ForIn", names, iterable, body: this.block(), ...this.pos(start) };
    }
    // A loop variable may carry its type: `for int i = 0 to n`.
    if (this.is("ident") && this.is("ident", undefined, 1)) this.next();
    const name = this.ident("a loop variable").value;
    if (this.isKw("in")) {
      this.next();
      const iterable = this.expr();
      return { kind: "ForIn", names: [name], iterable, body: this.block(), ...this.pos(start) };
    }
    this.expectOp("=");
    const from = this.expr();
    this.expectKw("to");
    const to = this.expr();
    const step = this.isKw("by") ? (this.next(), this.expr()) : null;
    return { kind: "For", counter: name, from, to, step, body: this.block(), ...this.pos(start) };
  }

  private switchNode(): A.SwitchNode {
    const start = this.expectKw("switch");
    const subject = this.is("newline") ? null : this.expr();
    if (!this.is("newline")) this.fail("Expected the cases on the following lines");
    this.skipNewlines();
    if (!this.is("indent")) this.fail("Expected the switch's cases, indented");
    this.next();
    const cases: A.SwitchCase[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.is("dedent") || this.is("eof")) break;
      const at = this.peek();
      const match = this.isOp("=>") ? null : this.expr();
      this.expectOp("=>");
      cases.push({ match, body: this.arrowBody(), ...this.pos(at) });
    }
    if (this.is("dedent")) this.next();
    return { kind: "Switch", subject, cases, ...this.pos(start) };
  }

  // ---------------- expressions ----------------

  expr(): A.Expr {
    if (this.is("keyword") && ["if", "for", "while", "switch"].includes(this.peek().value)) return this.control();
    return this.ternary();
  }

  private ternary(): A.Expr {
    const cond = this.or();
    if (!this.isOp("?")) return cond;
    this.next();
    const then = this.expr();
    this.expectOp(":");
    const otherwise = this.expr();
    return { kind: "Ternary", cond, then, else: otherwise, line: cond.line, col: cond.col };
  }

  private binary(next: () => A.Expr, ops: string[], keyword = false): A.Expr {
    let left = next();
    while (keyword ? this.is("keyword") && ops.includes(this.peek().value) : this.is("op") && ops.includes(this.peek().value)) {
      const op = this.next().value as A.BinaryOp;
      const right = next();
      left = { kind: "Binary", op, left, right, line: left.line, col: left.col };
    }
    return left;
  }
  private or = (): A.Expr => this.binary(this.and, ["or"], true);
  private and = (): A.Expr => this.binary(this.equality, ["and"], true);
  private equality = (): A.Expr => this.binary(this.comparison, ["==", "!="]);
  private comparison = (): A.Expr => this.binary(this.additive, ["<", ">", "<=", ">="]);
  private additive = (): A.Expr => this.binary(this.multiplicative, ["+", "-"]);
  private multiplicative = (): A.Expr => this.binary(this.unary, ["*", "/", "%"]);

  private unary = (): A.Expr => {
    const tok = this.peek();
    if ((tok.kind === "op" && (tok.value === "-" || tok.value === "+")) || (tok.kind === "keyword" && tok.value === "not")) {
      this.next();
      return { kind: "Unary", op: tok.value as A.Unary["op"], operand: this.unary(), ...this.pos(tok) };
    }
    return this.postfix();
  };

  private postfix(): A.Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const name = this.memberName();
        e = { kind: "Member", object: e, name: name.value, line: e.line, col: e.col };
      } else if (this.isOp("(")) {
        e = this.call(e, []);
      } else if (this.isOp("<") && (e.kind === "Ident" || e.kind === "Member")) {
        // `array.new<float>(…)`: type arguments, if a call follows; otherwise `<` compares.
        const callee = e;
        const generic = this.attempt(() => {
          this.next();
          const args = [this.typeRef()];
          while (this.isOp(",")) {
            this.next();
            args.push(this.typeRef());
          }
          this.expectOp(">");
          if (!this.isOp("(")) this.fail("Not a generic call");
          return this.call(callee, args);
        });
        if (!generic) return e;
        e = generic;
      } else if (this.isOp("[")) {
        this.next();
        const offset = this.expr();
        this.expectOp("]");
        e = { kind: "Index", object: e, offset, line: e.line, col: e.col };
      } else return e;
    }
  }

  private call(callee: A.Expr, typeArgs: A.TypeRef[]): A.Call {
    this.expectOp("(");
    const args: A.Arg[] = [];
    while (!this.isOp(")")) {
      if (this.is("ident") && this.isOp("=", 1)) {
        const name = this.next().value;
        this.next();
        args.push({ name, value: this.expr() });
      } else args.push({ name: null, value: this.expr() });
      if (!this.isOp(")")) this.expectOp(",");
    }
    this.expectOp(")");
    return { kind: "Call", callee, typeArgs, args, line: callee.line, col: callee.col };
  }

  private primary(): A.Expr {
    const tok = this.peek();
    switch (tok.kind) {
      case "number": {
        this.next();
        return { kind: "Number", value: Number(tok.value), int: /^\d+$/.test(tok.value), raw: tok.value, ...this.pos(tok) };
      }
      case "string":
        this.next();
        return { kind: "String", value: tok.value, ...this.pos(tok) };
      case "color":
        this.next();
        return { kind: "Color", value: tok.value, ...this.pos(tok) };
      case "ident":
        this.next();
        return { kind: "Ident", name: tok.value, ...this.pos(tok) };
      case "keyword":
        if (tok.value === "true" || tok.value === "false") {
          this.next();
          return { kind: "Bool", value: tok.value === "true", ...this.pos(tok) };
        }
        if (["if", "for", "while", "switch"].includes(tok.value)) return this.control();
        break;
      case "op":
        if (tok.value === "(") {
          this.next();
          const inner = this.expr();
          this.expectOp(")");
          return inner;
        }
        if (tok.value === "[") {
          this.next();
          const items: A.Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.isOp("]")) this.expectOp(",");
          }
          this.expectOp("]");
          return { kind: "Tuple", items, ...this.pos(tok) };
        }
        break;
    }
    return this.fail("Expected a value");
  }
}
