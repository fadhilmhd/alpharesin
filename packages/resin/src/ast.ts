import type { Annotation, Pos } from "./lexer";

/**
 * AlphaResin's syntax tree for Pine-compatible scripts (v5 and v6). Every node
 * carries the position it starts at, so later stages (checks, conversion,
 * coverage) can point at the source.
 */

export interface Script {
  kind: "Script";
  /** From `//@version=N`; null when absent. */
  version: number | null;
  annotations: Annotation[];
  body: Stmt[];
}

// ---------------- types ----------------

/** A type as written: `float`, `array<float>`, `float[]`, `map<string, int>`, `chart.point`, `lib.MyType`. */
export interface TypeRef extends Pos {
  kind: "Type";
  /** Dotted name, e.g. "float", "array", "chart.point", "mylib.Pivot". */
  name: string;
  args: TypeRef[];
  /** Written with the `[]` array shorthand (`float[]`). */
  array: boolean;
}

export type Qualifier = "const" | "simple" | "series" | "input";

// ---------------- statements ----------------

export type Stmt =
  | VarDecl
  | TupleDecl
  | Assign
  | ExprStmt
  | FunctionDecl
  | TypeDecl
  | EnumDecl
  | ImportStmt
  | IfNode
  | ForNode
  | ForInNode
  | WhileNode
  | SwitchNode
  | Break
  | Continue;

export interface VarDecl extends Pos {
  kind: "VarDecl";
  /** `var` keeps its value across bars; `varip` across ticks too. */
  mode: "var" | "varip" | null;
  qualifier: Qualifier | null;
  type: TypeRef | null;
  name: string;
  value: Expr;
}

export interface TupleDecl extends Pos {
  kind: "TupleDecl";
  names: string[];
  value: Expr;
}

export interface Assign extends Pos {
  kind: "Assign";
  /** `:=` or a compound `+=`, `-=`, `*=`, `/=`, `%=`. */
  op: ":=" | "+=" | "-=" | "*=" | "/=" | "%=";
  /** An identifier or a field: `x`, `obj.field`. */
  target: Ident | Member;
  value: Expr;
}

export interface ExprStmt extends Pos {
  kind: "ExprStmt";
  expr: Expr;
}

export interface Param extends Pos {
  name: string;
  type: TypeRef | null;
  qualifier: Qualifier | null;
  default: Expr | null;
}

export interface FunctionDecl extends Pos {
  kind: "FunctionDecl";
  name: string;
  exported: boolean;
  /** `method`: its first parameter is the object it's called on. */
  method: boolean;
  params: Param[];
  /** The last statement's value is the function's result. */
  body: Stmt[];
}

export interface Field extends Pos {
  name: string;
  type: TypeRef;
  varip: boolean;
  default: Expr | null;
}

export interface TypeDecl extends Pos {
  kind: "TypeDecl";
  name: string;
  exported: boolean;
  fields: Field[];
}

export interface EnumDecl extends Pos {
  kind: "EnumDecl";
  name: string;
  exported: boolean;
  members: { name: string; title: string | null; line: number; col: number }[];
}

export interface ImportStmt extends Pos {
  kind: "ImportStmt";
  /** `user/library/version`. */
  path: string;
  alias: string | null;
}

export interface Break extends Pos {
  kind: "Break";
}
export interface Continue extends Pos {
  kind: "Continue";
}

// ---------------- control flow (statements and expressions alike) ----------------

export interface IfNode extends Pos {
  kind: "If";
  cond: Expr;
  then: Stmt[];
  /** `else if` chains nest an If here; plain `else` gives a block. */
  else: Stmt[] | IfNode | null;
}

export interface ForNode extends Pos {
  kind: "For";
  counter: string;
  from: Expr;
  to: Expr;
  step: Expr | null;
  body: Stmt[];
}

export interface ForInNode extends Pos {
  kind: "ForIn";
  /** `for x in arr` → [x]; `for [i, x] in arr` → [i, x]. */
  names: string[];
  iterable: Expr;
  body: Stmt[];
}

export interface WhileNode extends Pos {
  kind: "While";
  cond: Expr;
  body: Stmt[];
}

export interface SwitchCase extends Pos {
  /** null: the default case (`=> …`). */
  match: Expr | null;
  body: Stmt[];
}

export interface SwitchNode extends Pos {
  kind: "Switch";
  /** null: each case is a condition. */
  subject: Expr | null;
  cases: SwitchCase[];
}

// ---------------- expressions ----------------

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | ColorLit
  | Ident
  | Member
  | Call
  | Index
  | Unary
  | Binary
  | Ternary
  | TupleExpr
  | IfNode
  | ForNode
  | ForInNode
  | WhileNode
  | SwitchNode;

export interface NumberLit extends Pos {
  kind: "Number";
  value: number;
  /** Written without a decimal point or exponent: Pine's int. */
  int: boolean;
  raw: string;
}
export interface StringLit extends Pos {
  kind: "String";
  value: string;
}
export interface BoolLit extends Pos {
  kind: "Bool";
  value: boolean;
}
export interface ColorLit extends Pos {
  kind: "Color";
  /** #rrggbb or #rrggbbaa, lower case. */
  value: string;
}
/** A name: a variable, a function, a namespace (`ta`), or `na`. */
export interface Ident extends Pos {
  kind: "Ident";
  name: string;
}
export interface Member extends Pos {
  kind: "Member";
  object: Expr;
  name: string;
}
export interface Arg {
  /** Named arguments: `title = "RSI"`. */
  name: string | null;
  value: Expr;
}
export interface Call extends Pos {
  kind: "Call";
  callee: Expr;
  /** Explicit type arguments: `array.new<float>(…)`. */
  typeArgs: TypeRef[];
  args: Arg[];
}
/** The history operator: `close[1]`. */
export interface Index extends Pos {
  kind: "Index";
  object: Expr;
  offset: Expr;
}
export interface Unary extends Pos {
  kind: "Unary";
  op: "-" | "+" | "not";
  operand: Expr;
}
export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "and" | "or";
export interface Binary extends Pos {
  kind: "Binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}
export interface Ternary extends Pos {
  kind: "Ternary";
  cond: Expr;
  then: Expr;
  else: Expr;
}
/** `[a, b]`: a function's several results. */
export interface TupleExpr extends Pos {
  kind: "Tuple";
  items: Expr[];
}
