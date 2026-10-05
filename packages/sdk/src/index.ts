/**
 * The AlphaPine indicator SDK, version 1: what an indicator module is, what
 * its `run` receives and what it may return. A module is plain JavaScript:
 *
 *   export default {
 *     name: "My RSI",
 *     overlay: false,
 *     inputs: { length: { type: "int", default: 14, min: 1, max: 500, label: "Length" } },
 *     run({ close, inputs }, { ta }) {
 *       const rsi = ta.rsi(close, inputs.length);
 *       return { lines: [{ title: "RSI", values: rsi }], levels: [{ value: 70 }, { value: 30 }] };
 *     },
 *   };
 *
 * A host runs it on its bars and checks everything it returns: values that
 * don't fit are dropped, not trusted. Indices are bar positions in `bars`.
 * Tables are shown beside the chart, never on it; colours are tones.
 */

export const SDK_VERSION = 1;

/** How a value reads: rising, falling, neither, a caution, or plain information. */
export type Tone = "bull" | "bear" | "neutral" | "warn" | "info";

export interface SdkBar {
  /** Bar open, UNIX ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** null where the market reports none. */
  volume: number | null;
}

/** A setting the user can change; `run` gets its value under the same key. */
export type UserInput =
  | { type: "int" | "float"; default: number; min?: number; max?: number; step?: number; label?: string }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "select"; default: string; options: string[]; label?: string };

/** What `run` receives: the bars, as rows and as columns, and the inputs' values. */
export interface RunContext {
  bars: SdkBar[];
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  /** NaN where the market reports no volume. */
  volume: number[];
  inputs: Record<string, number | boolean | string>;
  /** Bar period in ms. */
  periodMs: number;
  /** The market's price step (Pine's syminfo.mintick), when known. */
  mintick?: number;
  /** The chart's market, e.g. "BTCUSD". */
  symbol?: string;
  /** Other markets' bars at the chart's timeframe, by market ("ETHUSD"). */
  markets?: Record<string, SdkBar[]>;
  /** This market's bars on other timeframes, by Pine timeframe ("240", "D", "W", "15"). */
  higher?: Record<string, SdkBar[]>;
}

export type MarkerShape = "arrowUp" | "arrowDown" | "triangleUp" | "triangleDown" | "circle" | "ring" | "cross" | "check" | "label";

/** Everything `run` may return; every part is optional. */
export interface SdkOutput {
  /** One value per bar (null: none), drawn as a line. */
  lines?: { title: string; values: (number | null)[]; tone?: Tone; tones?: (Tone | null)[]; style?: "solid" | "dashed" | "step"; width?: number }[];
  /** The space between two lines (by title) or a line and a value. */
  fills?: { from: string | number; to: string | number; tone?: Tone; tones?: (Tone | null)[] }[];
  /** Horizontal levels across the pane. */
  levels?: ({ value: number; title?: string; tone?: Tone; style?: "solid" | "dashed" } | number)[];
  /** A mark on one bar; without a price it sits above or below the bar. */
  markers?: { index: number; price?: number; shape?: MarkerShape; tone?: Tone; text?: string; placement?: "above" | "below" }[];
  /** Columns on one bar each, such as a histogram. */
  bodies?: { index: number; top: number; bottom: number; tone?: Tone }[];
  /** A price range over bars; `to` may run past the newest bar. */
  zones?: { from: number; to: number; top: number; bottom: number; tone?: Tone; label?: string }[];
  /** A line between two points. */
  segments?: { from: number; to: number; fromPrice: number; toPrice: number; tone?: Tone; style?: "solid" | "dashed"; label?: string }[];
  /** Moments the host can measure (what followed them) and alert on. */
  events?: { index: number; code: string; label: string; tone?: Tone; price?: number }[];
  /** Readings beside the chart: label · value. */
  dashboard?: { label: string; value: string; tone?: Tone }[];
  /** Grids beside the chart; `span` columns wide when merged. */
  tables?: { rows: { text: string; tone?: Tone; span?: number }[][] }[];
  /** The pane's background behind each bar. */
  backgrounds?: (Tone | null)[];
  /** A tint per candle, −1 (bearish) … +1 (bullish); null leaves it as drawn. */
  candleTint?: (number | null)[];
  /** One short status for the indicator's header. */
  headline?: { text: string; tone?: Tone };
  /** The indicator's directional read and how strong it is (0–1). */
  bias?: Tone;
  strength?: number | null;
}

/** An indicator module: its default export. */
export interface SdkModule {
  name: string;
  /** Drawn on the price chart (true) or in its own pane. */
  overlay?: boolean;
  inputs?: Record<string, UserInput>;
  run(ctx: RunContext, sdk: unknown): SdkOutput | Promise<SdkOutput>;
}
