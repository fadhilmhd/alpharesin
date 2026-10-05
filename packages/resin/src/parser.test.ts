import { describe, expect, it } from "vitest";
import type * as A from "./ast";
import { lex, ResinSyntaxError } from "./lexer";
import { parse } from "./parser";

/** Fixtures written for AlphaResin (public): every construct of the v5 and v6 grammar. */

const v6 = (body: string) => `//@version=6\n${body}`;
const v5 = (body: string) => `//@version=5\n${body}`;
const first = (src: string) => parse(src).body[0]!;
/** The value of `x = …` on the script's first line. */
const valueOf = (src: string) => (first(src) as A.VarDecl).value;

function syntaxError(src: string): ResinSyntaxError {
  try {
    parse(src);
  } catch (e) {
    if (e instanceof ResinSyntaxError) return e;
    throw e;
  }
  throw new Error("expected a syntax error");
}

describe("lexer", () => {
  it("reads numbers, strings, colours, keywords and annotations", () => {
    const { tokens, annotations, version } = lex(`//@version=6\n//@description A test\nx = 1.5e-3 + .5 + 10 // trailing\ns = "a\\"b\\n" + 'it\\'s' + "//not a comment"\nc = #FF00aa80`);
    expect(version).toBe(6);
    expect(annotations.map((a) => [a.name, a.value])).toEqual([["version", "6"], ["description", "A test"]]);
    const values = tokens.filter((t) => t.kind !== "newline" && t.kind !== "eof").map((t) => `${t.kind}:${t.value}`);
    expect(values).toContain("number:1.5e-3");
    expect(values).toContain("number:.5");
    expect(values).toContain('string:a"b\n');
    expect(values).toContain("string:it's");
    expect(values).toContain("string://not a comment");
    expect(values).toContain("color:#ff00aa80");
  });

  it("makes blocks of 4-space indents and joins wrapped lines", () => {
    const kinds = lex(`if a\n    b = 1 +\n         2\n    c = f(1,\n    2)\nd = 3`).tokens.map((t) => (t.kind === "op" || t.kind === "ident" || t.kind === "number" || t.kind === "keyword" ? t.value : t.kind.toUpperCase()));
    expect(kinds).toEqual(["if", "a", "NEWLINE", "INDENT", "b", "=", "1", "+", "2", "NEWLINE", "c", "=", "f", "(", "1", ",", "2", ")", "NEWLINE", "DEDENT", "d", "=", "3", "NEWLINE", "EOF"]);
  });

  it("counts a tab as one level", () => {
    expect(() => parse(v6("if a\n\tb = 1"))).not.toThrow();
  });
});

describe("declarations and assignments", () => {
  it("reads plain, typed, qualified and var declarations", () => {
    const body = parse(
      v6(`a = 1
float b = na
var int count = 0
varip float last = close
series float s = close
simple int len = 14
array<float> xs = array.new<float>(10, 0.0)
float[] ys = array.new_float()
map<string, float> m = map.new<string, float>()
chart.point p = chart.point.now(close)`),
    ).body as A.VarDecl[];
    expect(body.map((d) => [d.name, d.mode, d.qualifier, d.type?.name ?? null])).toEqual([
      ["a", null, null, null],
      ["b", null, null, "float"],
      ["count", "var", null, "int"],
      ["last", "varip", null, "float"],
      ["s", null, "series", "float"],
      ["len", null, "simple", "int"],
      ["xs", null, null, "array"],
      ["ys", null, null, "float"],
      ["m", null, null, "map"],
      ["p", null, null, "chart.point"],
    ]);
    expect(body[6]!.type!.args.map((t) => t.name)).toEqual(["float"]);
    expect(body[7]!.type!.array).toBe(true);
    expect(body[8]!.type!.args.map((t) => t.name)).toEqual(["string", "float"]);
    expect((body[6]!.value as A.Call).typeArgs.map((t) => t.name)).toEqual(["float"]);
  });

  it("reads reassignment, compound assignment, field assignment and tuples", () => {
    const body = parse(v6(`x := x + 1\nx += 2\nobj.field := 3\n[m, s, h] = ta.macd(close, 12, 26, 9)\na = 1, b = 2`)).body;
    expect(body.map((s) => s.kind)).toEqual(["Assign", "Assign", "Assign", "TupleDecl", "VarDecl", "VarDecl"]);
    expect((body[1] as A.Assign).op).toBe("+=");
    expect(((body[2] as A.Assign).target as A.Member).name).toBe("field");
    expect((body[3] as A.TupleDecl).names).toEqual(["m", "s", "h"]);
  });

  it("tells `input` the qualifier from `input.int(…)` the call", () => {
    const body = parse(v6(`len = input.int(14, "Length", minval = 1)\ninput int other = 3`)).body as A.VarDecl[];
    expect(body[0]!.qualifier).toBeNull();
    const call = body[0]!.value as A.Call;
    expect(call.args.map((a) => a.name)).toEqual([null, null, "minval"]);
    expect(body[1]!.qualifier).toBe("input");
  });
});

describe("expressions", () => {
  it("follows Pine's precedence", () => {
    const e = valueOf(v6(`x = not a or b and c == d + e * -f`)) as A.Binary;
    // or( not a , and( b , ==( c , +( d , *( e , -f ) ) ) ) )
    expect(e.op).toBe("or");
    expect((e.left as A.Unary).op).toBe("not");
    const and = e.right as A.Binary;
    expect(and.op).toBe("and");
    const eq = and.right as A.Binary;
    expect(eq.op).toBe("==");
    const sum = eq.right as A.Binary;
    expect(sum.op).toBe("+");
    expect((sum.right as A.Binary).op).toBe("*");
  });

  it("nests ternaries to the right and wraps them across lines", () => {
    const e = valueOf(v6(`x = a > b ?\n     1 :\n     c > d ? 2 : 3`)) as A.Ternary;
    expect(e.kind).toBe("Ternary");
    expect((e.else as A.Ternary).kind).toBe("Ternary");
  });

  it("reads the history operator, members, calls and generic calls", () => {
    const e = valueOf(v6(`x = ta.sma(close[1], len)[2]`)) as A.Index;
    expect(e.kind).toBe("Index");
    const call = e.object as A.Call;
    expect((call.callee as A.Member).name).toBe("sma");
    expect((call.args[0]!.value as A.Index).kind).toBe("Index");
    // `<` stays a comparison when no call follows the would-be type arguments.
    const cmp = valueOf(v6(`x = a < b and c > d`)) as A.Binary;
    expect(cmp.op).toBe("and");
    expect((cmp.left as A.Binary).op).toBe("<");
  });

  it("reads literals, `na`, keyword-named members and tuples", () => {
    const body = parse(v6(`a = 42\nb = 4.2\nc = true\nd = "s"\ne = #000000\nf = na\ng = syminfo.type\nh = strategy.long`)).body as A.VarDecl[];
    expect(body.map((d) => d.value.kind)).toEqual(["Number", "Number", "Bool", "String", "Color", "Ident", "Member", "Member"]);
    expect((body[0]!.value as A.NumberLit).int).toBe(true);
    expect((body[1]!.value as A.NumberLit).int).toBe(false);
    expect((body[6]!.value as A.Member).name).toBe("type");
  });
});

describe("control flow", () => {
  it("reads if / else if / else as a statement and as a value", () => {
    const stmt = first(v6(`if a\n    x := 1\nelse if b\n    x := 2\nelse\n    x := 3`)) as A.IfNode;
    expect(stmt.kind).toBe("If");
    expect((stmt.else as A.IfNode).kind).toBe("If");
    expect(Array.isArray((stmt.else as A.IfNode).else)).toBe(true);
    const value = valueOf(v6(`x = if a\n    1\nelse\n    2\ny = 3`)) as A.IfNode;
    expect(value.kind).toBe("If");
    expect(parse(v6(`x = if a\n    1\nelse\n    2\ny = 3`)).body).toHaveLength(2);
  });

  it("reads counted loops, for…in and while, with break and continue", () => {
    const body = parse(
      v6(`for i = 0 to 10 by 2
    if i == 4
        continue
    x += i
for v in arr
    total += v
for [i, v] in arr
    break
while n > 0
    n -= 1`),
    ).body;
    expect(body.map((s) => s.kind)).toEqual(["For", "ForIn", "ForIn", "While"]);
    expect((body[0] as A.ForNode).step).not.toBeNull();
    expect((body[2] as A.ForInNode).names).toEqual(["i", "v"]);
  });

  it("reads both kinds of switch, with one-line and block cases and a default", () => {
    const s1 = valueOf(v6(`x = switch mode\n    "A" => 1\n    "B" =>\n        y = 2\n        y * 2\n    => 0`)) as A.SwitchNode;
    expect(s1.subject).not.toBeNull();
    expect(s1.cases.map((c) => [c.match === null, c.body.length])).toEqual([[false, 1], [false, 2], [true, 1]]);
    const s2 = first(v6(`switch\n    a > b => x := 1\n    => x := 0`)) as A.SwitchNode;
    expect(s2.subject).toBeNull();
    expect(s2.cases).toHaveLength(2);
  });
});

describe("functions, methods, types, enums and imports", () => {
  it("reads one-line and block functions with typed and default parameters", () => {
    const body = parse(
      v6(`f(x) => x * 2
g(float src, simple int len = 14) =>
    s = ta.sma(src, len)
    [s, s * 2]
export h(series float a) => a`),
    ).body as A.FunctionDecl[];
    expect(body.map((f) => [f.name, f.exported, f.body.length])).toEqual([["f", false, 1], ["g", false, 2], ["h", true, 1]]);
    expect(body[1]!.params.map((p) => [p.name, p.type?.name ?? null, p.qualifier, p.default?.kind ?? null])).toEqual([
      ["src", "float", null, null],
      ["len", "int", "simple", "Number"],
    ]);
    const ret = (body[1]!.body[1] as A.ExprStmt).expr as A.TupleExpr;
    expect(ret.kind).toBe("Tuple");
  });

  it("reads user types, methods, enums and imports", () => {
    const body = parse(
      v6(`import TradingView/ta/7 as tvta
export type Pivot
    float price = na
    int index
    varip bool live = false
method touch(Pivot this, float level) =>
    this.price := level
enum Mode
    fast = "Fast"
    slow
p = Pivot.new(1.0, 2)
p.touch(3.0)`),
    ).body;
    expect(body.map((s) => s.kind)).toEqual(["ImportStmt", "TypeDecl", "FunctionDecl", "EnumDecl", "VarDecl", "ExprStmt"]);
    expect(body[0]).toMatchObject({ path: "TradingView/ta/7", alias: "tvta" });
    expect((body[1] as A.TypeDecl).fields.map((f) => [f.name, f.type.name, f.varip, f.default !== null])).toEqual([
      ["price", "float", false, true],
      ["index", "int", false, false],
      ["live", "bool", true, true],
    ]);
    expect((body[2] as A.FunctionDecl).method).toBe(true);
    expect((body[3] as A.EnumDecl).members).toMatchObject([{ name: "fast", title: "Fast" }, { name: "slow", title: null }]);
  });
});

describe("versions", () => {
  it("reads a typical v5 script", () => {
    const script = parse(
      v5(`indicator("Example v5", overlay = true)
len = input.int(20, "Length", minval = 1)
src = input.source(close, "Source")
basis = ta.sma(src, len)
dev = 2.0 * ta.stdev(src, len)
upper = basis + dev
lower = basis - dev
var label lbl = na
if barstate.islast
    label.delete(lbl)
    lbl := label.new(bar_index, high, str.tostring(basis, format.mintick), style = label.style_label_down)
plot(basis, "Basis", color = color.new(color.orange, 0))
p1 = plot(upper, "Upper")
p2 = plot(lower, "Lower")
fill(p1, p2, color = color.new(color.blue, 90))
alertcondition(ta.crossover(src, upper), "Break up", "Price closed above the upper band")`),
    );
    expect(script.version).toBe(5);
    expect(script.body).toHaveLength(14);
  });

  it("refuses older versions and scripts that don't say theirs", () => {
    expect(syntaxError(`//@version=4\nstudy("x")`).message).toContain("this script is version 4");
    expect(syntaxError(`indicator("x")`).message).toContain("doesn't say its version");
  });
});

describe("syntax errors say where", () => {
  it("points at the line and column", () => {
    const unclosed = syntaxError(v6(`x = f(1,\n  2`));
    expect(unclosed.message).toContain("never closed");
    const indent = syntaxError(v6(`if a\n        b = 1`));
    expect(indent.message).toMatch(/one level/);
    expect(indent.line).toBe(3);
    // An expression cut short is reported on its own line.
    const missing = syntaxError(v6(`x = 1 +`));
    expect(missing.line).toBe(2);
    const bad = syntaxError(v6(`x = 1 @ 2`));
    expect(bad.message).toContain('Unexpected character "@"');
    expect([bad.line, bad.col]).toEqual([2, 7]);
    expect(syntaxError(v6(`if a\nx = 1`)).message).toContain("indented block");
  });
});

describe("forms seen in published scripts", () => {
  it("reads type, enum and method as names outside their declarations", () => {
    const s = parse(v6(`ma(src, len, type) =>\n    type == "SMA" ? src : len\ntype = "SMA"\ntype Box\n    string type = "free"\nenum = 1\nplot(ma(close, 3, type))`));
    expect(s.body.map((x) => x.kind)).toEqual(["FunctionDecl", "VarDecl", "TypeDecl", "VarDecl", "ExprStmt"]);
    expect((s.body[0] as A.FunctionDecl).params.map((p) => p.name)).toEqual(["src", "len", "type"]);
    expect((s.body[2] as A.TypeDecl).fields.map((f) => f.name)).toEqual(["type"]);
  });

  it("reads a typed loop variable and a comma ending a line", () => {
    const s = parse(v6(`for int i = 0 to 3\n    x = i\na = 1, b = 2,\nplot(a)`));
    expect((s.body[0] as A.ForNode).counter).toBe("i");
    expect(s.body.map((x) => x.kind)).toEqual(["For", "VarDecl", "VarDecl", "ExprStmt"]);
  });
});
