import type * as A from "./ast";
import { ResinSyntaxError } from "./lexer";
import { isLibrary, libraryTitle, link, type LibrarySource } from "./link";
import { parse } from "./parser";
import { MEMBERS, PARAMS } from "./reference/params";

/**
 * AlphaResin's converter: a Pine-compatible script (v5/v6) to an AlphaPine SDK v1
 * module that runs it bar by bar on the SDK's Pine runtime (`sdk.pine`,
 * packages/engine/src/pine.ts).
 *
 * The shape of what it writes:
 *
 *   export default {
 *     name, overlay, inputs,
 *     run(ctx, sdk) {
 *       const P = sdk.pine.start(ctx, { overlay, … });
 *       const S = {};                    // state per call site: ta.*, var, history
 *       …types, functions, top-level variables…
 *       for (let i = 0; i < P.n; i++) { P.bar(i); …the script… }
 *       return P.output();
 *     },
 *   };
 *
 * Pine names become `$name` (functions `$f_`, methods `$m_`, types `$T_`), so
 * nothing clashes with JavaScript. Each place that keeps state (a ta.* call,
 * a user function call, `var`, `x[k]` of an expression) gets its own slot in
 * the caller's state, as Pine gives each call site its own.
 *
 * What isn't converted yet is reported with its line, never dropped silently.
 */

export interface Issue {
  line: number;
  col: number;
  message: string;
}

export interface Converted {
  ok: boolean;
  /** The module's source; empty when there are errors. */
  code: string;
  name: string;
  overlay: boolean;
  version: number | null;
  errors: Issue[];
  warnings: Issue[];
  /** The script is a library: it converts to check its functions, and is used by the scripts that import it. */
  library: boolean;
  /** For a library: the name it declares (`library("Name")`), which imports of it read. */
  libraryName: string | null;
  /** Imports that no supplied library matched, as written (`user/Name/3`). */
  missingLibraries: string[];
}

export interface ConvertOptions {
  /** Library sources the script's imports may read (packages/resin link.ts). */
  libraries?: LibrarySource[];
  /**
   * How notes name the place the module runs ("the Terminal" by default, for
   * the AlphaPine Terminal): "Footprint data the host doesn't carry".
   */
  host?: string;
}

class Unsupported extends Error {
  constructor(
    message: string,
    readonly at: { line: number; col: number },
  ) {
    super(message);
  }
}

// ---------------- what Pine provides ----------------

const SERIES = new Set(["open", "high", "low", "close", "volume", "time", "hl2", "hlc3", "ohlc4", "hlcc4"]);
const BAR_VARS: Record<string, string> = {
  bar_index: "P.bar_index",
  last_bar_index: "P.last_bar_index",
  last_bar_time: "P.last_bar_time",
  time_close: "P.time_close",
  timenow: "P.time_close",
  na: "NaN",
  hour: 'P.dt("hour")',
  minute: 'P.dt("minute")',
  second: 'P.dt("second")',
  dayofweek: 'P.dt("dayofweek")',
  dayofmonth: 'P.dt("dayofmonth")',
  month: 'P.dt("month")',
  year: 'P.dt("year")',
  weekofyear: 'P.dt("weekofyear")',
};
/** Namespaces whose members are plain constants, kept as their Pine name. */
const CONSTANT_NS = new Set([
  "shape", "location", "size", "plot", "line", "label", "box", "table", "extend", "xloc", "yloc", "hline", "format", "display", "text", "position",
  "order", "alert", "font", "scale", "currency", "barmerge", "session", "adjustment", "linefill", "polyline", "chart",
]);
const UNSUPPORTED_NS: Record<string, string> = {
  request: "Data from other markets or timeframes (request.*) isn't converted yet",
};
const COLOR_NAMES = new Set(["aqua", "black", "blue", "fuchsia", "gray", "green", "lime", "maroon", "navy", "olive", "orange", "purple", "red", "silver", "teal", "white", "yellow"]);
const MATH_FNS = new Set(["abs", "sign", "sqrt", "exp", "log", "log10", "pow", "floor", "ceil", "sin", "cos", "tan", "asin", "acos", "atan", "todegrees", "toradians", "round", "max", "min", "avg", "random"]);
const STR_FNS = new Set(["tostring", "format", "length", "upper", "lower", "contains", "startswith", "endswith", "replace_all", "substring", "split", "tonumber", "trim", "pos", "match", "repeat", "replace"]);
const ARRAY_FNS = new Set([
  "new", "from", "size", "get", "set", "push", "unshift", "pop", "shift", "insert", "remove", "clear", "includes", "indexof", "lastindexof", "first", "last",
  "sum", "avg", "max", "min", "median", "stdev", "range", "sort", "reverse", "slice", "copy", "concat", "fill", "join", "abs", "every", "some", "mode", "variance", "covariance", "standardize", "percentile_linear_interpolation", "percentile_nearest_rank", "percentrank", "sort_indices", "binary_search", "binary_search_leftmost", "binary_search_rightmost"]);
const MAP_FNS = new Set(["new", "put", "get", "contains", "remove", "size", "keys", "values", "clear", "copy", "put_all"]);
const MATRIX_FNS = new Set([
  "new", "get", "set", "rows", "columns", "elements_count", "add_row", "add_col", "remove_row", "remove_col", "row", "col", "fill", "copy", "reverse",
  "swap_rows", "swap_columns", "transpose", "sum", "diff", "mult", "avg", "max", "min", "trace", "is_square", "concat", "reshape", "submatrix", "sort", "median", "mode", "det", "inv", "pow", "rank", "kron", "is_zero", "is_binary", "is_identity", "is_diagonal", "is_antidiagonal", "is_symmetric", "is_antisymmetric", "is_triangular", "is_stochastic"]);
/** What the runtime draws for each drawing type (packages/engine/src/pine.ts); other setters only style, and are left out. */
const DRAW_FNS: Record<string, Set<string>> = {
  label: new Set(["new", "delete", "set_x", "set_y", "set_xy", "set_text", "set_color", "set_style", "set_textcolor", "set_size", "set_tooltip", "get_x", "get_y", "get_text", "copy"]),
  line: new Set(["new", "delete", "set_x1", "set_x2", "set_y1", "set_y2", "set_xy1", "set_xy2", "set_color", "set_style", "set_width", "set_extend", "get_x1", "get_x2", "get_y1", "get_y2", "get_price", "copy"]),
  box: new Set(["new", "delete", "set_left", "set_right", "set_top", "set_bottom", "set_lefttop", "set_rightbottom", "set_bgcolor", "set_border_color", "set_text", "set_extend", "get_left", "get_right", "get_top", "get_bottom", "copy"]),
  table: new Set(["new", "cell", "cell_set_text", "cell_set_bgcolor", "cell_set_text_color", "merge_cells", "clear", "delete"]),
  polyline: new Set(["new", "delete"]),
  linefill: new Set(["new", "delete", "set_color", "get_line1", "get_line2"]),
};
for (const [ns, fn] of [["label", "set_point"], ["line", "set_first_point"], ["line", "set_second_point"], ["box", "set_top_left_point"], ["box", "set_bottom_right_point"]] as const) DRAW_FNS[ns]!.add(fn);

/** strategy.* variables the broker answers (packages/engine/src/broker.ts). */
const STRATEGY_VARS = new Set([
  "position_size", "position_avg_price", "position_entry_name", "opentrades", "closedtrades", "wintrades", "losstrades", "eventrades", "initial_capital",
  "netprofit", "netprofit_percent", "grossprofit", "grossloss", "openprofit", "equity", "max_drawdown", "max_drawdown_percent", "avg_trade",
  "avg_winning_trade", "avg_losing_trade", "account_currency", "grossprofit_percent", "grossloss_percent", "openprofit_percent", "max_runup",
  "max_runup_percent", "avg_trade_percent", "avg_winning_trade_percent", "avg_losing_trade_percent", "max_contracts_held_all", "max_contracts_held_long",
  "max_contracts_held_short", "margin_liquidation_price",
]);
const STRATEGY_CONSTS = new Set(["long", "short", "fixed", "cash", "percent_of_equity"]);
const STRATEGY_ORDERS = new Set(["entry", "order", "close", "close_all", "exit", "cancel", "cancel_all"]);
const TRADE_FIELDS = new Set([
  "entry_price", "entry_bar_index", "entry_time", "entry_id", "entry_comment", "size", "commission", "profit", "profit_percent", "max_runup", "max_drawdown",
  "exit_price", "exit_bar_index", "exit_time", "exit_id", "exit_comment",
]);

/** Parameter names, for named arguments. */
const SIG: Record<string, string[]> = {
  strategy: [
    "title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding", "calc_on_order_fills", "calc_on_every_tick", "max_bars_back",
    "backtest_fill_limits_assumption", "default_qty_type", "default_qty_value", "initial_capital", "currency", "slippage", "commission_type",
    "commission_value", "process_orders_on_close", "close_entries_rule", "margin_long", "margin_short", "explicit_plot_zorder", "max_lines_count",
    "max_labels_count", "max_boxes_count", "calc_bars_count", "risk_free_rate", "use_bar_magnifier", "fill_orders_on_standard_ohlc",
    "max_polylines_count", "dynamic_requests", "behind_chart", "calc_on_every_history_tick",
  ],
  "strategy.entry": ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  "strategy.order": ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  "strategy.close": ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert"],
  "strategy.close_all": ["comment", "alert_message", "immediately", "disable_alert"],
  "strategy.exit": [
    "id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment",
    "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "disable_alert",
  ],
  "strategy.cancel": ["id"],
  "strategy.cancel_all": [],
  indicator: ["title", "shorttitle", "overlay", "format", "precision", "scale", "max_bars_back", "timeframe", "timeframe_gaps", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "calc_bars_count", "max_polylines_count", "dynamic_requests", "behind_chart"],
  plot: ["series", "title", "color", "linewidth", "style", "trackprice", "histbase", "offset", "join", "editable", "show_last", "display", "format", "precision", "force_overlay", "linestyle"],
  plotshape: ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"],
  plotchar: ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"],
  hline: ["price", "title", "color", "linestyle", "linewidth", "editable", "display"],
  fill: ["hline1", "hline2", "color", "title", "editable", "show_last", "fillgaps", "display"],
  bgcolor: ["color", "offset", "editable", "show_last", "title", "display", "force_overlay"],
  barcolor: ["color", "offset", "editable", "show_last", "title", "display"],
  alertcondition: ["condition", "title", "message"],
  alert: ["message", "freq"],
  nz: ["source", "replacement"],
  "input.int": ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "options", "active"],
  "input.float": ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "options", "active"],
  "input.bool": ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"],
  "input.string": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"],
  "input.source": ["defval", "title", "tooltip", "inline", "group", "display", "active", "confirm"],
  "input.color": ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"],
  "input.enum": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"],
  "input.price": ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"],
  "input.timeframe": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"],
  input: ["defval", "title", "tooltip", "inline", "group", "display", "active"],
  "label.new": ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"],
  "line.new": ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width", "force_overlay"],
  "box.new": ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay"],
  "table.new": ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"],
  "table.cell": ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"],
  "color.new": ["color", "transp"],
  "color.rgb": ["red", "green", "blue", "transp"],
  "color.from_gradient": ["value", "bottom_value", "top_value", "bottom_color", "top_color"],
  "str.tostring": ["value", "format"],
  "math.round": ["number", "precision"],
};
/** ta.* functions: Pine's parameter names, and the call shape for the runtime. */
const TA: Record<string, { params: string[]; emit?: (st: string, a: string[]) => string }> = {
  sma: { params: ["source", "length"] },
  ema: { params: ["source", "length"] },
  rma: { params: ["source", "length"] },
  wma: { params: ["source", "length"] },
  stdev: { params: ["source", "length", "biased"] },
  median: { params: ["source", "length"] },
  dev: { params: ["source", "length"] },
  linreg: { params: ["source", "length", "offset"] },
  percentrank: { params: ["source", "length"] },
  percentile_nearest_rank: { params: ["source", "length", "percentage"] },
  change: { params: ["source", "length"] },
  mom: { params: ["source", "length"] },
  roc: { params: ["source", "length"] },
  rsi: { params: ["source", "length"] },
  macd: { params: ["source", "fastlen", "slowlen", "siglen"] },
  bb: { params: ["series", "length", "mult"] },
  bbw: { params: ["series", "length", "mult"] },
  stoch: { params: ["source", "high", "low", "length"] },
  cci: { params: ["source", "length"] },
  cum: { params: ["source"] },
  correlation: { params: ["source1", "source2", "length"] },
  crossover: { params: ["source1", "source2"] },
  crossunder: { params: ["source1", "source2"] },
  cross: { params: ["source1", "source2"] },
  rising: { params: ["source", "length"] },
  falling: { params: ["source", "length"] },
  barssince: { params: ["condition"] },
  valuewhen: { params: ["condition", "source", "occurrence"] },
  vwma: { params: ["source", "length"], emit: (st, a) => `P.ta.vwma(${st}, ${a[0]}, P.volume, ${a[1]})` },
  atr: { params: ["length"] },
  dmi: { params: ["diLength", "adxSmoothing"] },
  tr: { params: ["handle_na"], emit: (_st, a) => `P.ta.trf(${a[0] ?? "false"})` },
  // One-argument forms read the bar's high or low.
  highest: { params: ["source", "length"], emit: (st, a) => (a.length === 1 ? `P.ta.highest(${st}, P.high, ${a[0]})` : `P.ta.highest(${st}, ${a[0]}, ${a[1]})`) },
  lowest: { params: ["source", "length"], emit: (st, a) => (a.length === 1 ? `P.ta.lowest(${st}, P.low, ${a[0]})` : `P.ta.lowest(${st}, ${a[0]}, ${a[1]})`) },
  highestbars: { params: ["source", "length"], emit: (st, a) => (a.length === 1 ? `P.ta.highestbars(${st}, P.high, ${a[0]})` : `P.ta.highestbars(${st}, ${a[0]}, ${a[1]})`) },
  lowestbars: { params: ["source", "length"], emit: (st, a) => (a.length === 1 ? `P.ta.lowestbars(${st}, P.low, ${a[0]})` : `P.ta.lowestbars(${st}, ${a[0]}, ${a[1]})`) },
  pivothigh: { params: ["source", "leftbars", "rightbars"], emit: (st, a) => (a.length === 2 ? `P.ta.pivothigh(${st}, P.high, ${a[0]}, ${a[1]})` : `P.ta.pivothigh(${st}, ${a[0]}, ${a[1]}, ${a[2]})`) },
  pivotlow: { params: ["source", "leftbars", "rightbars"], emit: (st, a) => (a.length === 2 ? `P.ta.pivotlow(${st}, P.low, ${a[0]}, ${a[1]})` : `P.ta.pivotlow(${st}, ${a[0]}, ${a[1]}, ${a[2]})`) },
  hma: { params: ["source", "length"] },
  alma: { params: ["series", "length", "offset", "sigma", "floor"] },
  supertrend: { params: ["factor", "atrPeriod"] },
  mfi: { params: ["series", "length"] },
  wpr: { params: ["length"] },
  kc: { params: ["series", "length", "mult", "useTrueRange"] },
  kcw: { params: ["series", "length", "mult", "useTrueRange"] },
  cog: { params: ["source", "length"] },
  range: { params: ["source", "length"] },
  cmo: { params: ["series", "length"] },
  max: { params: ["source"] },
  min: { params: ["source"] },
  mode: { params: ["source", "length"] },
  percentile_linear_interpolation: { params: ["source", "length", "percentage"] },
  variance: { params: ["source", "length", "biased"] },
  swma: { params: ["source"] },
  tsi: { params: ["source", "short_length", "long_length"] },
  rci: { params: ["source", "length"] },
  sar: { params: ["start", "inc", "max"] },
  pivot_point_levels: { params: ["type", "anchor", "developing"] },
  vwap: { params: ["source", "anchor", "stdev_mult"], emit: (st, a) => `P.ta.vwapf(${[st, ...a].join(", ")})` },
};

/** A built-in's parameter names: ours where the runtime needs its own order, else the language reference's. */
const ref = (name: string): string[] | null => SIG[name] ?? PARAMS[name] ?? null;
/** Namespaces whose functions can be called as methods on their objects (\`a.push(x)\` is \`array.push(a, x)\`). */
const METHOD_NS = ["array", "matrix", "map", "label", "line", "box", "table", "linefill", "polyline", "str", "chart.point"];
/** A method's parameters after the object, from the first namespace that has it with every named argument used. */
function methodParams(name: string, named: string[]): string[] | null {
  for (const ns of METHOD_NS) {
    const p = PARAMS[`${ns}.${name}`];
    if (p && named.every((n) => p.includes(n))) return p.slice(1);
  }
  return null;
}

const SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"];

// ---------------- the generator ----------------

interface Binding {
  js: string;
  hist: string | null;
}
interface Ctx {
  /** "S" in every body: the state of this call site. */
  slots: number;
  scopes: Map<string, Binding>[];
  /** Names used with `[k]` in this body. */
  hist: Set<string>;
  top: boolean;
}

interface InputSpec {
  key: string;
  spec: Record<string, unknown>;
}

const js = (name: string) => `$${name}`;
const q = (s: string) => JSON.stringify(s);

export function convert(source: string, options: ConvertOptions = {}): Converted {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let script: A.Script;
  try {
    script = parse(source);
  } catch (e) {
    if (e instanceof ResinSyntaxError) return { ok: false, code: "", name: "", overlay: false, version: null, errors: [{ line: e.line, col: e.col, message: e.message }], warnings, library: false, libraryName: null, missingLibraries: [] };
    throw e;
  }
  const library = isLibrary(script);
  const linked = link(script, options.libraries ?? []);
  const g = new Generator(linked.script, errors, warnings);
  g.notices = licenceNotices(source);
  // What a missing library's alias reads is said once, at its import, not again at each use.
  for (const m of linked.missing) g.missingAliases.add(m.alias ?? m.path.split("/")[1]!);
  const code = g.module();
  const ok = errors.length === 0;
  return {
    ok,
    code: ok ? code : "",
    name: g.name,
    overlay: g.overlay,
    version: script.version,
    errors,
    warnings: options.host ? warnings.map((w) => ({ ...w, message: w.message.replace(/\bthe Terminal\b/g, options.host!) })) : warnings,
    library,
    libraryName: libraryTitle(script),
    missingLibraries: linked.missing.map((m) => m.path),
  };
}

/**
 * The original script's licence and copyright lines (its "// This source code
 * is subject to the terms of the Mozilla Public License 2.0 …", "// © author"),
 * carried to the top of the converted module: a conversion is the script
 * changed, and its licence and author go with it.
 */
export function licenceNotices(source: string): string[] {
  const out: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const m = /^\s*\/\/(.*)$/.exec(raw);
    if (!m) continue;
    const text = m[1]!.trim();
    if (/^@version/.test(text)) continue;
    if (/licen[cs]e|copyright|©|\(c\)\s|mozilla|creativecommons|cc by|spdx|all rights reserved/i.test(text)) out.push(text.slice(0, 200));
    if (out.length >= 10) break;
  }
  return out;
}

class Generator {
  name = "Converted indicator";
  /** The original's licence and copyright lines, kept at the top of the module. */
  notices: string[] = [];
  readonly missingAliases = new Set<string>();
  /** For each method the script declares: the type its object parameter takes, per declaration (null: untyped). */
  private readonly methodTypes = new Map<string, (string | null)[]>();
  overlay = false;
  private maxes: Record<string, number> = {};
  private readonly inputs: InputSpec[] = [];
  private readonly functions = new Map<string, A.FunctionDecl>();
  private readonly methods = new Map<string, A.FunctionDecl>();
  private readonly types = new Map<string, A.TypeDecl>();
  private readonly enums = new Map<string, A.EnumDecl>();
  private readonly hoisted = new Set<string>();
  private readonly topHist = new Set<string>();
  private site = 0;
  private varId = 0;
  private tmp = 0;
  /** The script's top-level variables, which functions may read. */
  private globals = new Map<string, Binding>();
  /** Set while generating a top-level declaration's value: an `input.*` there takes the variable's name. */
  private inputKey: string | null = null;

  constructor(
    private readonly script: A.Script,
    private readonly errors: Issue[],
    private readonly warnings: Issue[],
  ) {}

  private warn(at: { line: number; col: number }, message: string) {
    if (!this.warnings.some((w) => w.line === at.line && w.message === message)) this.warnings.push({ line: at.line, col: at.col, message });
  }
  private unsupported(at: { line: number; col: number }, message: string): never {
    throw new Unsupported(message, at);
  }
  /** Run one statement's generation; an unsupported construct becomes an error and the rest goes on. */
  private guard(at: { line: number; col: number }, fn: () => string[]): string[] {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      if (!this.errors.some((x) => x.line === e.at.line && x.message === e.message)) this.errors.push({ line: e.at.line, col: e.at.col, message: e.message });
      return [];
    }
  }

  // ---------------- the module ----------------

  module(): string {
    const body = this.script.body;
    for (const s of body) {
      if (s.kind === "FunctionDecl") (s.method ? this.methods : this.functions).set(s.name, s);
      if (s.kind === "FunctionDecl" && s.method && !this.functions.has(s.name)) this.functions.set(s.name, s);
      if (s.kind === "FunctionDecl" && s.method) {
        const t = s.params[0]?.type;
        this.methodTypes.set(s.name, [...(this.methodTypes.get(s.name) ?? []), t ? (t.array ? "array" : t.name) : null]);
      }
      if (s.kind === "TypeDecl") this.types.set(s.name, s);
      if (s.kind === "EnumDecl") this.enums.set(s.name, s);
      if (s.kind === "ImportStmt") this.guard(s, () => this.unsupported(s, `The library ${s.path} isn't added: add its source to My libraries, then convert again`));
    }
    const main: Ctx = { slots: 0, scopes: [new Map()], hist: collectHistory(body), top: true };
    for (const n of main.hist) this.topHist.add(n);

    // The script first: functions may read its top-level variables, so they're generated knowing them.
    const loop = this.block(body.filter((s) => s.kind !== "FunctionDecl" && s.kind !== "TypeDecl" && s.kind !== "EnumDecl" && s.kind !== "ImportStmt"), main, false, true);
    this.globals = main.scopes[0]!;
    const types = [...this.types.values()].map((t) => this.typeDecl(t));
    // Overloads: one name declared more than once (by parameter types). Each becomes its own function,
    // and the name a dispatcher that picks one by the arguments it's given (P.overload).
    const groups = new Map<string, A.FunctionDecl[]>();
    for (const s of body) if (s.kind === "FunctionDecl") groups.set(s.name, [...(groups.get(s.name) ?? []), s]);
    const overloaded = new Set([...groups].filter(([, g]) => g.length > 1).map(([n]) => n));
    const overloads = [...overloaded].flatMap((name) => {
      const group = groups.get(name)!;
      const sigs = group.map((f) => f.params.map((p) => (p.type ? (p.type.array ? "array" : p.type.name) : null)));
      const required = group.map((f) => f.params.filter((p) => !p.default).length);
      return [
        ...group.flatMap((f, k) => this.guard(f, () => this.functionDecl(f, `$o_${name}_${k}`))),
        `function $f_${name}(S, ...a) {`,
        `  const k = P.overload(a, ${JSON.stringify(sigs)}, ${JSON.stringify(required)});`,
        `  return [${group.map((_, k) => `$o_${name}_${k}`).join(", ")}][k]((S["o" + k] ??= {}), ...a);`,
        "}",
        `const $m_${name} = $f_${name};`,
      ];
    });
    const fns = [...this.functions.values()].filter((f) => !overloaded.has(f.name)).flatMap((f) => this.guard(f, () => this.functionDecl(f)));
    const methods = [...this.methods.values()].filter((m) => this.functions.get(m.name) !== m && !overloaded.has(m.name)).flatMap((f) => this.guard(f, () => this.functionDecl(f)));

    const opts = [`overlay: ${this.overlay}`, ...Object.entries(this.maxes).map(([k, v]) => `${k}: ${v}`)].join(", ");
    const inputs = this.inputs.map((i) => `    ${q(i.key)}: ${JSON.stringify(i.spec)},`).join("\n");
    const lines = [
      ...(this.notices.length
        ? [
            `// ${this.name}: converted by AlphaResin from a Pine-compatible v${this.script.version} script, under the original's licence:`,
            ...this.notices.map((n) => `//   ${n}`),
          ]
        : [`// ${this.name}: converted by AlphaResin from a Pine-compatible v${this.script.version} script. Edit freely.`]),
      ...this.warnings.map((w) => `// Note (line ${w.line}): ${w.message}`),
      "export default {",
      `  name: ${q(this.name)},`,
      `  overlay: ${this.overlay},`,
      `  inputs: {${inputs ? `\n${inputs}\n  ` : ""}},`,
      "  run(ctx, sdk) {",
      "    const { color: C, math: M, isNa: N, nz: NZ } = sdk.pine;",
      "    const I = ctx.inputs;",
      "    // The script, on whichever bars P holds: the chart's, or a higher timeframe's for request.security.",
      "    const exec = (P) => {",
      "      const S0 = {};",
      "      const S = S0;",
      ...indent([...types, ...fns, ...overloads, ...methods], 3),
      ...(this.hoisted.size ? [`      let ${[...this.hoisted].join(", ")};`] : []),
      ...[...this.topHist].map((n) => `      const $h_${n} = P.ser();`),
      "      for (let __i = 0; __i < P.n; __i++) {",
      "        P.bar(__i);",
      ...indent(loop, 4),
      "      }",
      "    };",
      `    const P = sdk.pine.start(ctx, { ${opts} });`,
      "    P.exec = exec;",
      "    exec(P);",
      "    return P.output();",
      "  },",
      "};",
      "",
    ];
    return lines.join("\n");
  }

  private typeDecl(t: A.TypeDecl): string {
    const defaults = t.fields.map((f) => {
      if (f.default) return `() => ${this.guardExpr(f.default, { slots: 0, scopes: [new Map()], hist: new Set(), top: false })}`;
      const base = f.type.array || f.type.args.length ? "NaN" : f.type.name === "bool" ? "false" : f.type.name === "string" ? '""' : "NaN";
      return `() => ${base}`;
    });
    return `const $T_${t.name} = P.udt(${JSON.stringify(t.fields.map((f) => f.name))}, [${defaults.join(", ")}], ${q(t.name)});`;
  }

  private guardExpr(e: A.Expr, ctx: Ctx): string {
    try {
      return this.expr(e, ctx);
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      this.errors.push({ line: err.at.line, col: err.at.col, message: err.message });
      return "NaN";
    }
  }

  private functionDecl(f: A.FunctionDecl, as?: string): string[] {
    // History kept per call site: for the function's own parameters and variables (a global's is the script's).
    const own = new Set([...f.params.map((p) => p.name), ...declaredIn(f.body)]);
    const hist = new Set([...collectHistory(f.body)].filter((n) => own.has(n)));
    const ctx: Ctx = { slots: 0, scopes: [new Map(this.globals), new Map()], hist, top: false };
    const params = f.params.map((p) => {
      ctx.scopes[1]!.set(p.name, { js: js(p.name), hist: hist.has(p.name) ? `$h_${p.name}` : null });
      return p.default ? `${js(p.name)} = ${this.expr(p.default, ctx)}` : js(p.name);
    });
    const head = [...hist].map((n) => `const $h_${n} = (S.h_${n} ??= P.ser());`);
    const sets = f.params.filter((p) => ctx.hist.has(p.name)).map((p) => `$h_${p.name}.set(${js(p.name)});`);
    const body = this.blockValue(f.body, ctx);
    const name = as ?? (f.method && this.functions.get(f.name) !== f ? `$m_${f.name}` : `$f_${f.name}`);
    return [`function ${name}(S, ${params.join(", ")}) {`, ...indent([...head, ...sets, ...body], 1), "}"];
  }

  // ---------------- statements ----------------

  private block(stmts: A.Stmt[], ctx: Ctx, scoped = true, top = false): string[] {
    if (scoped) ctx.scopes.push(new Map());
    const out = stmts.flatMap((s) => this.guard(s, () => this.stmt(s, ctx, top)));
    if (scoped) ctx.scopes.pop();
    return out;
  }

  /** A block whose last statement is its value: it ends in `return`. */
  private blockValue(stmts: A.Stmt[], ctx: Ctx): string[] {
    ctx.scopes.push(new Map());
    const head = stmts.slice(0, -1).flatMap((s) => this.guard(s, () => this.stmt(s, ctx, false)));
    const last = stmts[stmts.length - 1];
    const tail = last ? this.guard(last, () => this.valueOf(last, ctx)) : ["return NaN;"];
    ctx.scopes.pop();
    return [...head, ...tail];
  }

  private valueOf(s: A.Stmt, ctx: Ctx): string[] {
    switch (s.kind) {
      case "ExprStmt":
        return [`return ${this.expr(s.expr, ctx)};`];
      case "VarDecl": {
        const lines = this.stmt(s, ctx, false);
        return [...lines, `return ${this.lookup(s.name, ctx, s).js};`];
      }
      case "Assign":
        return [...this.stmt(s, ctx, false), `return ${this.target(s.target, ctx)};`];
      case "TupleDecl": {
        // `[a, b] = f()` as a function's last line: its value is the tuple.
        const lines = this.stmt(s, ctx, false);
        return [...lines, `return [${s.names.map((n) => (n === "_" ? "NaN" : this.lookup(n, ctx, s).js)).join(", ")}];`];
      }
      case "If":
        return [...this.ifChain(s, ctx, true), "return NaN;"];
      case "Switch":
        return [...this.switchStmt(s, ctx, true), "return NaN;"];
      default:
        return [...this.stmt(s, ctx, false), "return NaN;"];
    }
  }

  private bind(name: string, ctx: Ctx, b: Binding) {
    ctx.scopes[ctx.scopes.length - 1]!.set(name, b);
  }

  private lookup(name: string, ctx: Ctx, at: { line: number; col: number }): Binding {
    for (let k = ctx.scopes.length - 1; k >= 0; k--) {
      const b = ctx.scopes[k]!.get(name);
      if (b) return b;
    }
    return this.unsupported(at, `"${name}" is used before it is declared`);
  }
  private bound(name: string, ctx: Ctx): Binding | null {
    for (let k = ctx.scopes.length - 1; k >= 0; k--) {
      const b = ctx.scopes[k]!.get(name);
      if (b) return b;
    }
    return null;
  }

  private stmt(s: A.Stmt, ctx: Ctx, top: boolean): string[] {
    switch (s.kind) {
      case "VarDecl":
        return this.varDecl(s, ctx, top);
      case "TupleDecl": {
        const names = s.names.map((n) => {
          // `_` discards a value: each one its own throwaway name.
          if (n === "_") {
            const name = `$_${this.site++}`;
            if (top) this.hoisted.add(name);
            return name;
          }
          const hist = ctx.hist.has(n) ? `$h_${n}` : null;
          if (top) this.hoisted.add(js(n));
          this.bind(n, ctx, { js: js(n), hist });
          return js(n);
        });
        // A tuple that came back as na (a branch that didn't run) reads as na in each place.
        const value = `P.tuple(${this.expr(s.value, ctx)}, ${names.length})`;
        const sets = s.names.filter((n) => ctx.hist.has(n)).map((n) => `$h_${n}.set(${js(n)});`);
        return [`${top ? "" : "let "}[${names.join(", ")}] = ${value};`, ...sets];
      }
      case "Assign": {
        if (s.target.kind === "Ident") this.consts.delete(s.target.name);
        const target = this.target(s.target, ctx);
        const value = this.expr(s.value, ctx);
        const line = `${target} ${s.op === ":=" ? "=" : s.op} ${value};`;
        const hist = s.target.kind === "Ident" ? this.bound(s.target.name, ctx)?.hist : null;
        return hist ? [line, `${hist}.set(${target});`] : [line];
      }
      case "ExprStmt":
        return this.exprStmt(s.expr, ctx);
      case "If":
        return this.ifChain(s, ctx, false);
      case "Switch":
        return this.switchStmt(s, ctx, false);
      case "For": {
        const k = this.tmp++;
        const from = this.expr(s.from, ctx);
        const to = this.expr(s.to, ctx);
        const step = s.step ? this.expr(s.step, ctx) : `(__f${k} <= __t${k} ? 1 : -1)`;
        ctx.scopes.push(new Map([[s.counter, { js: js(s.counter), hist: null }]]));
        const body = this.block(s.body, ctx);
        ctx.scopes.pop();
        return [
          `{ const __f${k} = ${from}, __t${k} = ${to}, __s${k} = ${step};`,
          `  for (let ${js(s.counter)} = __f${k}; __s${k} > 0 ? ${js(s.counter)} <= __t${k} : ${js(s.counter)} >= __t${k}; ${js(s.counter)} += __s${k}) {`,
          ...indent(body, 2),
          "  }",
          "}",
        ];
      }
      case "ForIn": {
        const it = this.expr(s.iterable, ctx);
        ctx.scopes.push(new Map(s.names.map((n) => [n, { js: js(n), hist: null }])));
        const body = this.block(s.body, ctx);
        ctx.scopes.pop();
        const head = s.names.length === 2 ? `for (const [${js(s.names[0]!)}, ${js(s.names[1]!)}] of (${it}).entries())` : `for (const ${js(s.names[0]!)} of ${it})`;
        return [`${head} {`, ...indent(body, 1), "}"];
      }
      case "While":
        return [`while (${this.expr(s.cond, ctx)}) {`, ...indent(this.block(s.body, ctx), 1), "}"];
      case "Break":
        return ["break;"];
      case "Continue":
        return ["continue;"];
      case "FunctionDecl":
        return this.unsupported(s, "Functions are declared at the top level only");
      case "TypeDecl":
      case "EnumDecl":
      case "ImportStmt":
        return [];
    }
  }

  private varDecl(s: A.VarDecl, ctx: Ctx, top: boolean): string[] {
    if (s.mode === "varip") this.warn(s, "varip runs like var: the Terminal computes on closed bars");
    const hist = ctx.hist.has(s.name) ? `$h_${s.name}` : null;
    // Bound before its value is read: a value that can't be converted is one error, not one per later use.
    const holder = ctx.top ? "S0" : "S";
    const key = s.mode ? `v${this.varId++}` : "";
    // A second declaration of a name in the same scope (often a function's own parameter) is a new variable.
    // (A function body's first level shares JavaScript's scope with its parameters.)
    const params = !ctx.top && ctx.scopes.length === 3 ? ctx.scopes[1]! : null;
    const again = !top && !s.mode && (ctx.scopes[ctx.scopes.length - 1]!.has(s.name) || !!params?.has(s.name));
    const target = s.mode ? `${holder}.${key}` : again ? `${js(s.name)}_${this.tmp++}` : js(s.name);
    if (top && !s.mode) this.hoisted.add(js(s.name));
    // A redeclaration reads the earlier variable in its own value: `x = f(x)`.
    const early = again ? this.expr(s.value, ctx) : null;
    this.bind(s.name, ctx, { js: target, hist });
    // An input on a top-level line takes the variable's name as its key.
    this.inputKey = top ? s.name : null;
    let value: string;
    try {
      value = early ?? this.expr(s.value, ctx);
    } finally {
      this.inputKey = null;
    }
    if (top && !s.mode) {
      const folded = this.fold(s.value);
      if (folded !== undefined) this.consts.set(s.name, folded);
    }
    const set = hist ? [`${hist}.set(${target});`] : [];
    // The script's own `var`s live in its root state (S0), so functions reading them see the same value.
    if (s.mode) return [`if (!(${q(key)} in ${holder})) ${target} = ${value};`, ...set];
    return [`${top ? "" : "let "}${target} = ${value};`, ...set];
  }

  private target(t: A.Ident | A.Member, ctx: Ctx): string {
    if (t.kind === "Ident") return this.lookup(t.name, ctx, t).js;
    return `${this.expr(t.object, ctx)}.${t.name}`;
  }

  private ifChain(s: A.IfNode, ctx: Ctx, value: boolean): string[] {
    const body = (stmts: A.Stmt[]) => (value ? this.blockValue(stmts, ctx) : this.block(stmts, ctx));
    const out = [`if (${this.expr(s.cond, ctx)}) {`, ...indent(body(s.then), 1)];
    let rest = s.else;
    while (rest) {
      if (Array.isArray(rest)) {
        out.push("} else {", ...indent(body(rest), 1));
        rest = null;
      } else {
        out.push(`} else if (${this.expr(rest.cond, ctx)}) {`, ...indent(body(rest.then), 1));
        rest = rest.else;
      }
    }
    out.push("}");
    return out;
  }

  private switchStmt(s: A.SwitchNode, ctx: Ctx, value: boolean): string[] {
    const k = this.tmp++;
    const subject = s.subject ? this.expr(s.subject, ctx) : null;
    const out: string[] = subject ? [`const __w${k} = ${subject};`] : [];
    let first = true;
    for (const c of s.cases) {
      const body = value ? this.blockValue(c.body, ctx) : this.block(c.body, ctx);
      if (c.match === null) out.push(first ? "{" : "} else {", ...indent(body, 1));
      else {
        const cond = subject ? `__w${k} === ${this.expr(c.match, ctx)}` : this.expr(c.match, ctx);
        out.push(`${first ? "" : "} else "}if (${cond}) {`, ...indent(body, 1));
      }
      first = false;
    }
    if (!first) out.push("}");
    return subject ? ["{", ...indent(out, 1), "}"] : out;
  }

  private exprStmt(e: A.Expr, ctx: Ctx): string[] {
    if (e.kind === "If") return this.ifChain(e, ctx, false);
    if (e.kind === "Switch") return this.switchStmt(e, ctx, false);
    if (e.kind === "Call" && e.callee.kind === "Ident" && (e.callee.name === "indicator" || e.callee.name === "library")) {
      this.indicator(e, ctx);
      return [];
    }
    if (e.kind === "Call" && e.callee.kind === "Ident" && e.callee.name === "strategy" && !this.functions.has("strategy")) return [`${this.strategyDecl(e, ctx)};`];
    const code = this.expr(e, ctx);
    return code ? [`${code};`] : [];
  }

  private indicator(call: A.Call, ctx: Ctx) {
    const a = this.argsOf(call, SIG.indicator!);
    const title = a[0] ?? a[1];
    if (title?.kind === "String") this.name = title.value.slice(0, 60);
    const overlay = a[2];
    if (overlay?.kind === "Bool") this.overlay = overlay.value;
    const max = (k: number, key: string) => {
      const v = a[k];
      if (v?.kind === "Number") this.maxes[key] = v.value;
    };
    max(10, "maxLines");
    max(11, "maxLabels");
    max(12, "maxBoxes");
    void ctx;
  }

  /**
   * `strategy(...)`: declared like an indicator, and its settings go to the
   * broker (pyramiding, order size, capital, slippage, commission, fills on close).
   */
  private strategyDecl(call: A.Call, ctx: Ctx): string {
    const params = SIG.strategy!;
    const a = this.argsOf(call, params);
    const title = a[0] ?? a[1];
    if (title?.kind === "String") this.name = title.value.slice(0, 60);
    if (a[2]?.kind === "Bool") this.overlay = a[2].value;
    for (const [k, key] of [[23, "maxLines"], [24, "maxLabels"], [25, "maxBoxes"]] as const) {
      const v = a[k];
      if (v?.kind === "Number") this.maxes[key] = v.value;
    }
    if (a[28]?.kind === "Bool" && a[28].value) this.warn(call, "The bar magnifier isn't emulated: orders fill on the chart's own bars");
    const keep = ["pyramiding", "default_qty_type", "default_qty_value", "initial_capital", "slippage", "commission_type", "commission_value", "process_orders_on_close"];
    const fields = keep.flatMap((name) => {
      const v = a[params.indexOf(name)];
      return v ? [`${name}: ${this.expr(v, ctx)}`] : [];
    });
    return `P.strategy.setup({ ${fields.join(", ")} })`;
  }

  // ---------------- expressions ----------------

  private expr(e: A.Expr, ctx: Ctx): string {
    switch (e.kind) {
      case "Number": {
        // Pine reads 00.050 as 0.05; JavaScript wouldn't.
        const raw = e.raw.replace(/^0+(?=\d)/, "");
        return raw.startsWith(".") ? `0${raw}` : raw;
      }
      case "String":
        return q(e.value);
      case "Bool":
        return String(e.value);
      case "Color":
        return q(e.value.length === 7 ? `${e.value}ff` : e.value);
      case "Ident":
        return this.ident(e, ctx);
      case "Member":
        return this.member(e, ctx);
      case "Call":
        return this.call(e, ctx);
      case "Index":
        return this.index(e, ctx);
      case "Unary":
        return `(${e.op === "not" ? "!" : e.op}${this.expr(e.operand, ctx)})`;
      case "Binary": {
        const op = e.op === "and" ? "&&" : e.op === "or" ? "||" : e.op === "==" ? "===" : e.op === "!=" ? "!==" : e.op;
        return `(${this.expr(e.left, ctx)} ${op} ${this.expr(e.right, ctx)})`;
      }
      case "Ternary":
        return `(${this.expr(e.cond, ctx)} ? ${this.expr(e.then, ctx)} : ${this.expr(e.else, ctx)})`;
      case "Tuple":
        return `[${e.items.map((x) => this.expr(x, ctx)).join(", ")}]`;
      case "If":
        return `(() => {\n${indent([...this.ifChain(e, ctx, true), "return NaN;"], 1).join("\n")}\n})()`;
      case "Switch":
        return `(() => {\n${indent([...this.switchStmt(e, ctx, true), "return NaN;"], 1).join("\n")}\n})()`;
      case "For":
      case "ForIn":
      case "While":
        this.warn(e, "A loop's value is na here; assign inside the loop instead");
        return `(() => {\n${indent([...this.stmt(e as A.Stmt, ctx, false), "return NaN;"], 1).join("\n")}\n})()`;
    }
  }

  private ident(e: A.Ident, ctx: Ctx): string {
    const b = this.bound(e.name, ctx);
    if (b) return b.js;
    if (SERIES.has(e.name)) return `P.${e.name}`;
    if (e.name in BAR_VARS) return BAR_VARS[e.name]!;
    if (this.functions.has(e.name)) return this.unsupported(e, `Functions can't be passed as values ("${e.name}")`);
    return this.unsupported(e, `Unknown name "${e.name}"`);
  }

  private nsOf(e: A.Expr, ctx: Ctx): string | null {
    return e.kind === "Ident" && !this.bound(e.name, ctx) ? e.name : null;
  }

  private member(e: A.Member, ctx: Ctx): string {
    if (this.missingAliases.has(this.rootName(e.object) ?? "") && !this.bound(this.rootName(e.object)!, ctx)) return "NaN";
    const sub = this.strategySub(e.object, ctx);
    if (sub) {
      if (["commission", "direction", "oca"].includes(sub)) return q(`strategy.${sub}.${e.name}`);
      if (sub === "closedtrades" && e.name === "first_index") return "0";
      return this.unsupported(e, `strategy.${sub}.${e.name} isn't converted yet`);
    }
    const ns = this.nsOf(e.object, ctx) ?? (e.object.kind === "Ident" && MEMBERS.has(`${e.object.name}.${e.name}`) ? e.object.name : null);
    if (ns === "strategy") {
      if (STRATEGY_CONSTS.has(e.name)) return q(`strategy.${e.name}`);
      if (STRATEGY_VARS.has(e.name)) return `P.strategy.${e.name}`;
      return this.unsupported(e, `strategy.${e.name} isn't converted yet`);
    }
    if (ns) {
      if (ns in UNSUPPORTED_NS) return this.unsupported(e, UNSUPPORTED_NS[ns]!);
      if (this.enums.has(ns)) return q(e.name);
      if (ns === "color") return COLOR_NAMES.has(e.name) ? `C.${e.name}` : this.unsupported(e, `color.${e.name} isn't known`);
      if (ns === "barstate") return `P.barstate.${e.name}`;
      if (ns === "syminfo") return `P.syminfo.${e.name}`;
      if (ns === "timeframe") return `P.timeframe.${e.name}`;
      if (ns === "math" && ["pi", "e", "phi"].includes(e.name)) return `M.${e.name}`;
      if (ns === "ta" && ["tr", "vwap", "obv", "accdist", "pvt", "pvi", "nvi", "wad", "iii", "wvad"].includes(e.name)) return `P.ta.${e.name}`;
      if (ns === "ta") return this.unsupported(e, `ta.${e.name} isn't converted yet`);
      if (e.name === "all" && ["label", "line", "box", "table", "polyline", "linefill"].includes(ns)) return `P.${ns}.all`;
      if (CONSTANT_NS.has(ns)) return q(`${ns}.${e.name}`);
      if (ns === "dayofweek") return String(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(e.name) + 1);
      // Any other built-in constant the language reference lists (earnings.actual, adjustment.splits…): its name.
      if (MEMBERS.has(`${ns}.${e.name}`) && !this.bound(ns, ctx)) return q(`${ns}.${e.name}`);
    }
    return `${this.expr(e.object, ctx)}.${e.name}`;
  }

  private index(e: A.Index, ctx: Ctx): string {
    const k = this.expr(e.offset, ctx);
    if (e.object.kind === "Ident") {
      const b = this.bound(e.object.name, ctx);
      if (b?.hist) return `${b.hist}.get(${k})`;
      if (!b && (SERIES.has(e.object.name) || e.object.name === "bar_index")) return `P.src(${q(e.object.name)}, ${k})`;
    }
    return `P.hist(${this.slot(ctx)}, ${this.expr(e.object, ctx)}, ${k})`;
  }

  private slot(ctx: Ctx): string {
    return `(S[${ctx.slots++}] ??= {})`;
  }

  /**
   * Arguments in parameter order, named ones placed by name; null where none was given.
   * For drawing and settings functions an unknown name is only presentation: it's noted and left out.
   */
  private argsOf(call: A.Call, params: string[]): (A.Expr | null)[] {
    const out: (A.Expr | null)[] = [];
    let pos = 0;
    const lenient = params !== SIG.indicator && Object.values(SIG).includes(params);
    for (const a of call.args) {
      if (a.name === null) out[pos++] = a.value;
      else {
        const k = params.indexOf(a.name);
        if (k < 0) {
          if (lenient) {
            this.warn(a.value, `The "${a.name}" argument isn't used`);
            continue;
          }
          this.unsupported(a.value, `Unknown argument "${a.name}"`);
        }
        out[k] = a.value;
      }
    }
    return Array.from({ length: out.length }, (_, k) => out[k] ?? null);
  }
  private args(call: A.Call, params: string[] | null, ctx: Ctx, upto?: number): string[] {
    if (!params) {
      if (call.args.some((a) => a.name !== null)) return this.unsupported(call, "Named arguments aren't supported for this function");
      return call.args.map((a) => this.expr(a.value, ctx));
    }
    const list = this.argsOf(call, params).slice(0, upto);
    while (list.length && list[list.length - 1] === null) list.pop();
    return list.map((x) => (x ? this.expr(x, ctx) : "undefined"));
  }

  /**
   * A built-in namespace a script's own variable shares a name with
   * (\`var table = table.new(…)\`, then \`table.cell(table_id = table, …)\`): the
   * built-in where only it fits: namespaces without methods always, others
   * when the object is passed by its parameter name or there are more
   * arguments than the method form takes.
   */
  private shadowedNs(obj: A.Expr, fn: string, call: A.Call): string | null {
    if (obj.kind !== "Ident") return null;
    const params = PARAMS[`${obj.name}.${fn}`] ?? PARAMS[`${obj.name}.${fn}<type>`] ?? PARAMS[`${obj.name}.${fn}<type,type>`];
    if (!params) return null;
    if (!METHOD_NS.includes(obj.name) || fn === "new" || fn.startsWith("new_")) return obj.name;
    return call.args.some((a) => a.name === params[0]) || call.args.length > params.length - 1 ? obj.name : null;
  }

  /** `strategy.<sub>` as the object of a member: the name of the sub-namespace (opentrades, risk…). */
  private strategySub(e: A.Expr, ctx: Ctx): string | null {
    return e.kind === "Member" && this.nsOf(e.object, ctx) === "strategy" ? e.name : null;
  }

  /** The name an expression's member chain starts from: `h` for `h.Band.new`. */
  private rootName(e: A.Expr): string | null {
    return e.kind === "Ident" ? e.name : e.kind === "Member" ? this.rootName(e.object) : null;
  }

  private call(e: A.Call, ctx: Ctx): string {
    const c = e.callee;
    if (c.kind === "Member" && this.missingAliases.has(this.rootName(c.object) ?? "") && !this.bound(this.rootName(c.object)!, ctx)) return "NaN";
    const sub = c.kind === "Member" ? this.strategySub(c.object, ctx) : null;
    if (c.kind === "Member" && sub) {
      if ((sub === "opentrades" || sub === "closedtrades") && TRADE_FIELDS.has(c.name)) {
        return `P.strategy.trade(${q(sub === "opentrades" ? "open" : "closed")}, ${q(c.name)}, ${this.args(e, ["trade_num"], ctx)[0] ?? "0"})`;
      }
      if (sub === "risk") {
        this.warn(e, `strategy.risk.${c.name}() isn't emulated; the strategy runs without that limit`);
        return "";
      }
      return this.unsupported(e, `strategy.${sub}.${c.name}() isn't converted yet`);
    }
    if (c.kind === "Member" && c.object.kind === "Member" && c.object.name === "point" && this.nsOf(c.object.object, ctx) === "chart") {
      if (!PARAMS[`chart.point.${c.name}`]) return this.unsupported(e, `chart.point.${c.name}() isn't converted yet`);
      return `P.point.${c.name}(${this.args(e, ref(`chart.point.${c.name}`), ctx).join(", ")})`;
    }
    if (c.kind === "Member") {
      const ns = this.nsOf(c.object, ctx) ?? this.shadowedNs(c.object, c.name, e);
      if (ns) return this.namespaced(ns, c.name, e, ctx);
      // A method on a value: the user's own first, then the built-in objects'.
      const obj = this.expr(c.object, ctx);
      const user = this.methods.get(c.name) ?? (this.functions.get(c.name)?.method ? this.functions.get(c.name) : undefined);
      if (user) {
        const fn = this.functions.get(c.name) === user ? `$f_${c.name}` : `$m_${c.name}`;
        const args = this.args(e, user.params.slice(1).map((p) => p.name), ctx);
        // A built-in method of the same name (a script's own \`delete\` for its type, then \`line.delete()\`):
        // the script's applies to the types its declarations take, the built-in to everything else.
        const types = this.methodTypes.get(c.name) ?? [];
        if (METHOD_NS.some((ns) => PARAMS[`${ns}.${c.name}`]) && types.length && types.every((t) => t !== null)) {
          return `((o, a) => P.isOfAny(o, ${JSON.stringify(types)}) ? ${fn}(${this.slot(ctx)}, o, ...a) : P.method(o, ${q(c.name)}, a))(${obj}, [${args.join(", ")}])`;
        }
        return `${fn}(${this.slot(ctx)}, ${[obj, ...args].join(", ")})`;
      }
      if (/^(set_|cell_set_)/.test(c.name) && ![...Object.values(DRAW_FNS)].some((fns) => fns.has(c.name))) {
        this.warn(e, `.${c.name}() only styles a drawing; it's left out`);
        return "";
      }
      return `P.method(${obj}, ${q(c.name)}, [${this.args(e, methodParams(c.name, e.args.flatMap((x) => (x.name ? [x.name] : []))), ctx).join(", ")}])`;
    }
    if (c.kind !== "Ident") return this.unsupported(e, "Only named functions can be called");
    const name = c.name;
    const user = this.functions.get(name);
    if (user && !this.bound(name, ctx)) {
      const params = user.params.map((p) => p.name);
      return `$f_${name}(${[this.slot(ctx), ...this.args(e, params, ctx)].join(", ")})`;
    }
    const site = () => q(`s${this.site++}`);
    switch (name) {
      case "plot": {
        // series, title, color, linewidth, style … offset (7) … display (11)
        const a = this.args(e, SIG.plot!, ctx, 12);
        const u = (k: number, d = "undefined") => a[k] ?? d;
        return `P.plot(${site()}, ${[u(0, "NaN"), u(1), u(2), u(3), u(4), u(7), u(11)].join(", ")})`;
      }
      case "plotshape": {
        // series, title, style, location, color, offset (5), text (6) … display (11)
        const a = this.args(e, SIG.plotshape!, ctx, 12);
        const u = (k: number, d = "undefined") => a[k] ?? d;
        return `P.shape(${site()}, ${[u(0, "false"), u(2), u(3), u(4), u(6), "false", u(1), u(5), u(11)].join(", ")})`;
      }
      case "plotchar": {
        // series, title, char, location, color, offset (5), text (6) … display (11)
        const a = this.args(e, SIG.plotchar!, ctx, 12);
        const u = (k: number, d = "undefined") => a[k] ?? d;
        return `P.shape(${site()}, ${[u(0, "false"), "undefined", u(3), u(4), a[6] ?? u(2), "true", u(1), u(5), u(11)].join(", ")})`;
      }
      case "hline": {
        const a = this.args(e, SIG.hline!, ctx, 4);
        return `P.hline(${site()}, ${[a[0] ?? "NaN", a[1] ?? "undefined", a[2] ?? "undefined", a[3] ?? "undefined"].join(", ")})`;
      }
      case "fill": {
        if (e.args.some((x) => x.name === "top_value" || x.name === "top_color") || (e.args.length >= 6 && e.args.every((x) => !x.name))) {
          // A gradient fill: drawn in its top colour.
          this.warn(e, "A gradient fill is drawn in one colour, its top one");
          const g = this.args(e, PARAMS.fill!, ctx);
          return `P.fill(${site()}, ${[g[0] ?? "NaN", g[1] ?? "NaN", g[4] ?? "undefined"].join(", ")})`;
        }
        const a = this.args(e, SIG.fill!, ctx, 3);
        return `P.fill(${site()}, ${[a[0] ?? "NaN", a[1] ?? "NaN", a[2] ?? "undefined"].join(", ")})`;
      }
      case "alertcondition": {
        const a = this.args(e, SIG.alertcondition!, ctx);
        return `P.alert(${site()}, ${[a[0] ?? "false", a[1] ?? "undefined", a[2] ?? "undefined"].join(", ")})`;
      }
      case "alert": {
        const a = this.args(e, SIG.alert!, ctx, 1);
        return `P.alert(${site()}, true, ${a[0] ?? '"Alert"'})`;
      }
      case "bgcolor":
      case "barcolor": {
        // The pane's background behind each bar; the candle's own colour.
        const a = this.args(e, SIG[name]!, ctx, 6);
        return `P.${name}(${[a[0] ?? "NaN", a[1] ?? "undefined", a[5] ?? "undefined"].join(", ")})`;
      }
      case "plotarrow": {
        const a = this.args(e, PARAMS.plotarrow!, ctx, 10);
        const u = (k: number) => a[k] ?? "undefined";
        return `P.plotarrow(${[site(), a[0] ?? "NaN", u(1), u(2), u(3), u(4), u(9)].join(", ")})`;
      }
      case "plotcandle":
      case "plotbar":
        this.warn(e, `${name} isn't drawn: the Terminal draws the market's own candles`);
        return "";
      case "time":
      case "time_close": {
        const a = this.args(e, ["timeframe", "session", "timezone", "bars_back"], ctx);
        if (a[1] && a[1] !== '""' && a[1] !== "undefined") this.warn(e, `${name}() with a session isn't filtered by it yet: every bar counts as in session`);
        return `P.timeAt(${a[0] ?? '""'}, ${name === "time_close"})`;
      }
      case "indicator":
        this.indicator(e, ctx);
        return "";
      case "strategy":
        return this.strategyDecl(e, ctx);
      case "library":
        // A library converts like an indicator with no outputs: its functions are what's checked.
        this.indicator(e, ctx);
        return "";
      case "max_bars_back":
        return "";
      case "timestamp":
        return `P.timestamp(${this.args(e, null, ctx).join(", ")})`;
      case "color":
      case "line":
      case "label":
      case "box":
      case "table":
      case "linefill":
      case "polyline":
        // Type casts: color(na), line(na), label(x).
        return this.args(e, null, ctx)[0] ?? "NaN";
      case "nz": {
        const a = this.args(e, SIG.nz!, ctx);
        return `NZ(${a.join(", ")})`;
      }
      case "na":
        return `N(${this.args(e, null, ctx)[0] ?? "NaN"})`;
      case "fixnan":
        return `P.fixnan(${this.slot(ctx)}, ${this.args(e, null, ctx)[0]})`;
      case "int":
        return `Math.trunc(${this.args(e, null, ctx)[0]})`;
      case "float":
        return `(+${this.args(e, null, ctx)[0]})`;
      case "bool":
        return `Boolean(${this.args(e, null, ctx)[0]})`;
      case "string":
        return `String(${this.args(e, null, ctx)[0]})`;
      case "input":
        return this.input("input", e, ctx);
      case "hour":
      case "minute":
      case "second":
      case "dayofweek":
      case "dayofmonth":
      case "month":
      case "year":
      case "weekofyear":
        return `P.dt(${q(name)}, ${this.args(e, null, ctx)[0] ?? "P.time"})`;
    }
    return this.unsupported(e, `${name}() isn't converted yet`);
  }

  private strategyCall(fn: string, e: A.Call, ctx: Ctx): string {
    if (STRATEGY_ORDERS.has(fn)) {
      const params = SIG[`strategy.${fn}`]!;
      if (e.args.some((x) => x.name === "oca_name")) this.warn(e, "OCA groups aren't emulated: each order fills on its own");
      // Up to the last parameter the broker reads (alerts and their messages aren't sent from here).
      const upto = { entry: 8, order: 8, close: 6, close_all: 3, exit: 13, cancel: 1, cancel_all: 0 }[fn as "entry"];
      return `P.strategy.${fn}(${this.args(e, params, ctx, upto).join(", ")})`;
    }
    if (fn === "convert_to_account" || fn === "convert_to_symbol") return `(+${this.args(e, ["value"], ctx)[0]})`;
    if (fn === "default_entry_qty") return `P.strategy.default_entry_qty(${this.args(e, ["fill_price"], ctx)[0] ?? "P.close"})`;
    return this.unsupported(e, `strategy.${fn}() isn't converted yet`);
  }

  private namespaced(ns: string, fn: string, e: A.Call, ctx: Ctx): string {
    if (ns === "request" && fn === "security") return this.security(e, ctx);
    if (ns === "request" && fn === "security_lower_tf") return this.securityLower(e, ctx);
    if (ns === "syminfo" && (fn === "prefix" || fn === "ticker")) {
      // The exchange, or the symbol, of "EXCHANGE:SYMBOL".
      const a = this.args(e, ["symbol"], ctx)[0] ?? '""';
      return fn === "prefix" ? `(String(${a}).includes(":") ? String(${a}).split(":")[0] : "")` : `String(${a}).split(":").pop()`;
    }
    if (ns === "ticker") {
      const a = this.args(e, ref(`ticker.${fn}`), ctx);
      if (fn === "heikinashi") return `("HA:" + ${a[0] ?? '""'})`;
      if (fn === "standard" || fn === "modify") return `String(${a[0] ?? '""'})`;
      if (fn === "new") return `(${a[0] ?? '""'} + ":" + ${a[1] ?? '""'})`;
      if (!PARAMS[`ticker.${fn}`]) return this.unsupported(e, `ticker.${fn}() isn't a Pine function`);
      this.warn(e, `ticker.${fn}() reads the Terminal's regular bars: it draws no ${fn} charts`);
      return `String(${a[0] ?? '""'})`;
    }
    if (ns === "timeframe" && fn === "change") return `P.tfChange(${this.args(e, ["timeframe"], ctx)[0] ?? '""'})`;
    // What has no place in the Terminal is left out with a note, and the rest of the script converts:
    // data it doesn't carry reads as na, chart types it doesn't draw read its regular bars.
    if (ns === "request") {
      if (!PARAMS[`request.${fn}`]) return this.unsupported(e, `request.${fn}() isn't a Pine function`);
      if (fn === "currency_rate") {
        this.warn(e, "request.currency_rate() reads 1 between the same currency and na otherwise: the Terminal prices in one currency");
        const a = this.args(e, ref("request.currency_rate"), ctx);
        return `(String(${a[0] ?? '""'}) === String(${a[1] ?? '""'}) ? 1 : NaN)`;
      }
      this.warn(e, `request.${fn}() reads data the Terminal doesn't carry: it's na here`);
      return "NaN";
    }
    if (ns === "footprint") {
      this.warn(e, `footprint.${fn}() needs footprint data the Terminal doesn't carry: it's na here`);
      return "NaN";
    }
    if (ns in UNSUPPORTED_NS) return this.unsupported(e, UNSUPPORTED_NS[ns]!);
    if (ns === "strategy") return this.strategyCall(fn, e, ctx);
    const type = this.types.get(ns);
    if (type) {
      if (fn !== "new" && fn !== "copy") return this.unsupported(e, `${ns}.${fn}() isn't converted yet`);
      if (fn === "copy") return `P.copy(${this.args(e, null, ctx)[0]})`;
      return `$T_${ns}.new([${this.args(e, type.fields.map((f) => f.name), ctx).join(", ")}])`;
    }
    switch (ns) {
      case "ta": {
        const t = TA[fn];
        if (!t) return this.unsupported(e, `ta.${fn}() isn't converted yet`);
        const a = this.args(e, t.params, ctx);
        const st = this.slot(ctx);
        return t.emit ? t.emit(st, a) : `P.ta.${fn}(${[st, ...a].join(", ")})`;
      }
      case "math":
        if (fn === "sum") return `P.msum(${[this.slot(ctx), ...this.args(e, ["source", "length"], ctx)].join(", ")})`;
        if (fn === "round_to_mintick") return `M.round(${this.args(e, null, ctx)[0]} / P.syminfo.mintick) * P.syminfo.mintick`;
        if (!MATH_FNS.has(fn)) return this.unsupported(e, `math.${fn}() isn't converted yet`);
        return `M.${fn}(${this.args(e, ref(`math.${fn}`), ctx).join(", ")})`;
      case "str":
        if (fn === "format_time") return `P.str.format_time(${this.args(e, ["time", "format", "timezone"], ctx).join(", ")})`;
        if (!STR_FNS.has(fn)) return this.unsupported(e, `str.${fn}() isn't converted yet`);
        return `P.str.${fn}(${this.args(e, ref(`str.${fn}`), ctx).join(", ")})`;
      case "color":
        if (!["new", "rgb", "r", "g", "b", "t", "from_gradient"].includes(fn)) return this.unsupported(e, `color.${fn}() isn't converted yet`);
        return `C.${fn}(${this.args(e, ref(`color.${fn}`), ctx).join(", ")})`;
      case "array": {
        if (fn.startsWith("new_")) {
          const kind = fn.slice(4);
          const a = this.args(e, ["size", "initial_value"], ctx);
          return `P.array.new(${a[0] ?? "0"}, ${a[1] ?? (kind === "bool" ? "false" : kind === "string" ? '""' : "NaN")})`;
        }
        if (!ARRAY_FNS.has(fn)) return this.unsupported(e, `array.${fn}() isn't converted yet`);
        if (fn === "new") {
          const kind = e.typeArgs[0]?.name;
          const a = this.args(e, ["size", "initial_value"], ctx);
          return `P.array.new(${a[0] ?? "0"}, ${a[1] ?? (kind === "bool" ? "false" : kind === "string" ? '""' : "NaN")})`;
        }
        return `P.array.${fn}(${this.args(e, ref(`array.${fn}`), ctx).join(", ")})`;
      }
      case "matrix": {
        if (!MATRIX_FNS.has(fn)) return this.unsupported(e, `matrix.${fn}() isn't converted yet`);
        if (fn === "new") {
          const kind = e.typeArgs[0]?.name;
          const a = this.args(e, ["rows", "columns", "initial_value"], ctx);
          return `P.matrix.new(${a[0] ?? "0"}, ${a[1] ?? "0"}, ${a[2] ?? (kind === "bool" ? "false" : kind === "string" ? '""' : "NaN")})`;
        }
        return `P.matrix.${fn}(${this.args(e, ref(`matrix.${fn}`), ctx).join(", ")})`;
      }
      case "map":
        if (!MAP_FNS.has(fn)) return this.unsupported(e, `map.${fn}() isn't converted yet`);
        return `P.map.${fn}(${this.args(e, ref(`map.${fn}`), ctx).join(", ")})`;
      case "label":
      case "line":
      case "box":
      case "table":
      case "polyline":
      case "linefill": {
        if (!DRAW_FNS[ns]!.has(fn)) {
          if (/^(set_|cell_set_)|^merge_cells$/.test(fn)) {
            this.warn(e, `${ns}.${fn}() only styles the drawing; it's left out`);
            return "";
          }
          return this.unsupported(e, `${ns}.${fn}() isn't converted yet`);
        }
        const sig = ref(`${ns}.${fn}`);
        return `P.${ns}.${fn}(${this.args(e, sig, ctx).join(", ")})`;
      }
      case "input":
        return this.input(`input.${fn}`, e, ctx);
      case "timeframe":
        if (fn === "in_seconds") return `P.timeframe.in_seconds(${this.args(e, ["timeframe"], ctx)[0] ?? ""})`;
        if (fn === "from_seconds") return `P.tfFromSeconds(${this.args(e, ["seconds"], ctx)[0]})`;
        return this.unsupported(e, `timeframe.${fn}() isn't converted yet`);
      case "runtime":
        if (fn === "error") return `(() => { throw new Error(String(${this.args(e, null, ctx)[0]})); })()`;
        return this.unsupported(e, `runtime.${fn}() isn't converted yet`);
      case "log":
        this.warn(e, "log.* messages are dropped");
        return "";
    }
    if (this.enums.has(ns)) return this.unsupported(e, `${ns}.${fn}() isn't converted yet`);
    return this.unsupported(e, `${ns}.${fn}() isn't converted yet`);
  }

  /** request.security on this market: the expression runs again on the higher timeframe's bars (packages/engine pine.ts `sec`). */
  private security(e: A.Call, ctx: Ctx): string {
    const params = ["symbol", "timeframe", "expression", "gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count"];
    const a = this.argsOf(e, params);
    const sym = a[0];
    const sameMarket = sym?.kind === "Member" && sym.object.kind === "Ident" && sym.object.name === "syminfo" && ["tickerid", "ticker", "prefix"].includes(sym.name);
    if (!a[2]) return this.unsupported(e, "request.security needs an expression");
    if (a[6]) this.warn(e, "request.security's currency conversion isn't applied");
    const site = q(`r${this.site++}`);
    const tf = a[1] ? this.expr(a[1], ctx) : '""';
    const expr = this.expr(a[2], ctx);
    const gaps = a[3] ? this.expr(a[3], ctx) : "undefined";
    const look = a[4] ? this.expr(a[4], ctx) : "undefined";
    if (sameMarket) return `P.sec(${site}, ${tf}, () => (${expr}), ${look}, ${gaps})`;
    // This market through ticker.* (its Heikin Ashi bars, its standard ticker) isn't another market.
    const own = (x: A.Expr | null | undefined): boolean =>
      !!x && ((x.kind === "Member" && x.object.kind === "Ident" && x.object.name === "syminfo") || (x.kind === "Call" && x.callee.kind === "Member" && x.callee.object.kind === "Ident" && x.callee.object.name === "ticker" && own(x.args[0]?.value)));
    if (!this.otherMarkets && !own(sym)) {
      this.otherMarkets = true;
      this.warn(e, "Other markets are read from the Terminal's own (BINANCE:ETHUSDT as ETHUSD); a market it doesn't carry reads as na");
    }
    return `P.secm(${site}, ${sym ? this.expr(sym, ctx) : '""'}, ${tf}, () => (${expr}), ${look}, ${gaps})`;
  }
  private otherMarkets = false;

  /** `request.security_lower_tf`: an array per chart bar of the lower timeframe's values inside it. */
  private securityLower(e: A.Call, ctx: Ctx): string {
    const a = this.argsOf(e, ["symbol", "timeframe", "expression", "ignore_invalid_symbol", "currency", "ignore_invalid_timeframe", "calc_bars_count"]);
    if (!a[2]) return this.unsupported(e, "request.security_lower_tf needs an expression");
    const site = q(`r${this.site++}`);
    return `P.secLower(${site}, ${a[0] ? this.expr(a[0], ctx) : '""'}, ${a[1] ? this.expr(a[1], ctx) : '""'}, () => (${this.expr(a[2], ctx)}))`;
  }

  // ---------------- inputs ----------------

  /** Top-level variables whose value is a constant, for inputs that refer to them (`group = GRP`, `defval = LEN`). */
  private readonly consts = new Map<string, unknown>();

  /** An expression's constant value, if it has one: literals, arithmetic, string joins, constant variables. */
  private fold(e: A.Expr | null): unknown {
    if (!e) return undefined;
    switch (e.kind) {
      case "Number":
      case "Bool":
      case "String":
      case "Color":
        return e.value;
      case "Unary": {
        const v = this.fold(e.operand);
        return typeof v === "number" ? (e.op === "-" ? -v : v) : undefined;
      }
      case "Binary": {
        const l = this.fold(e.left);
        const r = this.fold(e.right);
        if (typeof l === "number" && typeof r === "number") return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : e.op === "/" ? l / r : undefined;
        if (typeof l === "string" && typeof r === "string" && e.op === "+") return l + r;
        return undefined;
      }
      case "Ident":
        if (this.consts.has(e.name)) return this.consts.get(e.name);
        return SOURCES.includes(e.name) ? { source: e.name } : undefined;
      case "Member":
        if (e.object.kind === "Ident" && this.enums.has(e.object.name)) return { member: `${e.object.name}.${e.name}`, enum: e.name };
        return undefined;
      case "Tuple": {
        const items = e.items.map((x) => this.fold(x));
        return items.every((x) => x !== undefined) ? items : undefined;
      }
    }
    return undefined;
  }

  /** A constant written in the script: a number, bool, string, colour or a source/enum name. */
  private constant(e: A.Expr | null): unknown {
    const v = this.fold(e);
    if (v !== undefined || !e) return v;
    if (!e) return undefined;
    switch (e.kind) {
      case "Number":
        return e.value;
      case "Bool":
        return e.value;
      case "String":
        return e.value;
      case "Color":
        return e.value;
      case "Unary":
        if (e.op === "-" && e.operand.kind === "Number") return -e.operand.value;
        break;
      case "Ident":
        return { source: e.name };
      case "Member":
        if (e.object.kind === "Ident") return { member: `${e.object.name}.${e.name}`, enum: this.enums.has(e.object.name) ? e.name : undefined };
        break;
      case "Tuple":
        return e.items.map((x) => this.constant(x));
    }
    return this.unsupported(e, "An input's default and limits must be written as constants");
  }

  private input(kind: string, e: A.Call, ctx: Ctx): string {
    const sig = ref(kind);
    if (!sig) return this.unsupported(e, `${kind}() isn't converted yet`);
    const a = this.argsOf(e, sig);
    const key = this.inputKey && !this.inputs.some((i) => i.key === this.inputKey) ? this.inputKey : `input${this.inputs.length + 1}`;
    if (kind === "input.color" || (kind === "input" && a[0] && this.fold(a[0]) === undefined && a[0].kind !== "Ident")) {
      this.warn(e, "Colour inputs aren't adjustable; they keep their default");
      return a[0] ? this.expr(a[0], ctx) : "NaN";
    }
    if (["input.time", "input.session"].includes(kind)) {
      // Kept at their default for now: the value the script was written with.
      const title = this.fold(a[1] ?? null);
      this.warn(e, `The ${kind.slice(6).replace("_", " ")} input "${typeof title === "string" && title ? title : key}" isn't adjustable yet; it keeps its default`);
      return a[0] ? this.expr(a[0], ctx) : '""';
    }
    const def = this.constant(a[0] ?? null);
    const titleArg = this.fold(a[1] ?? null);
    const label = typeof titleArg === "string" && titleArg ? titleArg.slice(0, 60) : key;
    const opt = (name: string) => {
      const k = sig.indexOf(name);
      return k >= 0 ? this.fold(a[k] ?? null) : undefined;
    };
    let type = kind === "input" ? (typeof def === "number" ? (Number.isInteger(def) && a[0]?.kind === "Number" && a[0].int ? "int" : "float") : typeof def === "boolean" ? "bool" : typeof def === "string" ? "string" : def && typeof def === "object" && "source" in def ? "source" : "other") : kind.slice(6);
    if (type === "price") type = "float";
    const spec: Record<string, unknown> = { label };
    const options = opt("options");
    let code = `I[${q(key)}]`;
    if (type === "int" || type === "float") {
      if (Array.isArray(options)) {
        Object.assign(spec, { type: "select", default: String(def), options: options.map(String) });
        code = `Number(${code})`;
      } else {
        const min = opt("minval");
        const max = opt("maxval");
        const step = opt("step");
        Object.assign(spec, { type, default: def, ...(typeof min === "number" ? { min } : {}), ...(typeof max === "number" ? { max } : {}), ...(typeof step === "number" ? { step } : {}) });
      }
    } else if (type === "bool") Object.assign(spec, { type: "bool", default: def });
    else if (type === "string" || type === "timeframe" || type === "symbol" || type === "text_area") {
      if (Array.isArray(options)) Object.assign(spec, { type: "select", default: String(def), options: options.map(String) });
      else if (type === "timeframe") {
        // A timeframe as Pine writes it ("60", "D"); timeframe.period, or "", is the chart's own.
        const d = def && typeof def === "object" && "member" in def ? ((def as { member: string }).member === "timeframe.period" ? "" : undefined) : def;
        if (typeof d !== "string") return this.unsupported(e, "input.timeframe needs a timeframe string as its default");
        Object.assign(spec, { type: "text", default: d, maxLength: 10, timeframe: true });
        code = `String(${code})`;
      } else {
        // Free text: a symbol is a market name, so a host can offer its own markets beside it.
        Object.assign(spec, { type: "text", default: String(def ?? ""), maxLength: type === "text_area" ? 2000 : 200, ...(type === "symbol" ? { symbol: true } : {}) });
        code = `String(${code})`;
      }
    } else if (type === "source") {
      const name = def && typeof def === "object" && "source" in def ? String((def as { source: string }).source) : "close";
      if (!SOURCES.includes(name)) return this.unsupported(e, `input.source(${name}) isn't converted yet; use a price source`);
      Object.assign(spec, { type: "select", default: name, options: SOURCES });
      code = `P.src(${code})`;
    } else if (type === "enum") {
      const d = def as { member?: string; enum?: string };
      const en = d?.member ? this.enums.get(d.member.split(".")[0]!) : undefined;
      if (!en || !d.enum) return this.unsupported(e, "input.enum needs an enum member as its default");
      Object.assign(spec, { type: "select", default: d.enum, options: en.members.map((m) => m.name) });
    } else if (type === "color") {
      this.warn(e, `The colour input "${label}" isn't adjustable; it keeps its default`);
      return this.expr(a[0]!, ctx);
    } else return this.unsupported(e, `${kind}() isn't converted yet`);
    this.inputs.push({ key, spec });
    return code;
  }
}

/** Names used with the history operator in a body (not inside nested functions). */
function collectHistory(stmts: A.Stmt[]): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as { kind?: string };
    if (n.kind === "FunctionDecl") return;
    if (n.kind === "Index" && (node as A.Index).object.kind === "Ident") out.add(((node as A.Index).object as A.Ident).name);
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
  };
  visit(stmts);
  return out;
}

/** Names a body declares (not inside nested functions). */
function declaredIn(stmts: A.Stmt[]): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as { kind?: string };
    if (n.kind === "FunctionDecl") return;
    if (n.kind === "VarDecl") out.add((node as A.VarDecl).name);
    if (n.kind === "TupleDecl") for (const x of (node as A.TupleDecl).names) out.add(x);
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
  };
  visit(stmts);
  return out;
}

function indent(lines: string[], depth: number): string[] {
  const pad = "  ".repeat(depth);
  return lines.flatMap((l) => l.split("\n")).map((l) => (l ? pad + l : l));
}
