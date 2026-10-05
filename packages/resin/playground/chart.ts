import type { Bar } from "../src/runner";

/**
 * A small SVG chart of a run: candles, the script's plots over them (overlay
 * scripts) or in a pane below (the rest), and a legend with the last values.
 * Built with DOM calls, never markup strings: plot titles come from the
 * user's script.
 */

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const PRICE_H = 300;
const PANE_H = 150;
const GAP = 16;
const AXIS = 64;
/** Bars shown: the newest ones, enough to read candles at this width. */
export const SHOWN = 180;

type Column = { title: string; values: (number | null)[] };

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
};

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function range(values: number[]): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

const fmt = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.001 ? v.toFixed(5) : v.toPrecision(3);
};

/** Columns that are constant reference lines (hline-like) are drawn too; columns with no values at all are skipped. */
export function renderChart(host: HTMLElement, bars: readonly Bar[], columns: readonly Column[], overlay: boolean): void {
  host.replaceChildren();
  const from = Math.max(0, bars.length - SHOWN);
  const shown = bars.slice(from);
  const all = columns.map((c) => ({ title: c.title, values: c.values.slice(from) })).filter((c) => c.values.some(finite));
  // Markers and alert conditions come out as 0/1 per bar: drawn as ticks under the candles, not as lines on a price scale.
  const isEvent = (c: Column) => c.values.every((v) => !finite(v) || v === 0 || v === 1);
  const events = all.filter(isEvent);
  const cols = all.filter((c) => !isEvent(c));
  const priceCols = overlay ? cols : [];
  const paneCols = overlay ? [] : cols;
  const height = PRICE_H + (paneCols.length ? GAP + PANE_H : 0);
  const svg = el("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": `Chart of the last ${shown.length} bars with the script's plots`, class: "chart-svg" });
  const plotW = W - AXIS;
  const step = plotW / Math.max(shown.length, 1);
  const x = (i: number) => i * step + step / 2;

  const pane = (top: number, h: number, values: number[]) => {
    const [lo, hi] = range(values);
    const y = (v: number) => top + h - ((v - lo) / (hi - lo)) * h;
    el("rect", { x: 0, y: top, width: plotW, height: h, class: "pane" }, svg);
    for (const v of [hi - (hi - lo) * 0.06, (hi + lo) / 2, lo + (hi - lo) * 0.06]) {
      el("line", { x1: 0, x2: plotW, y1: y(v), y2: y(v), class: "grid" }, svg);
      const t = el("text", { x: plotW + 6, y: y(v) + 4, class: "axis" }, svg);
      t.textContent = fmt(v);
    }
    return y;
  };

  // Price pane: candles, and the overlay plots on the same scale.
  const priceValues = shown.flatMap((b) => [b.high, b.low]).concat(priceCols.flatMap((c) => c.values.filter(finite)));
  const yp = pane(0, PRICE_H, priceValues);
  const bodyW = Math.max(1, step * 0.6);
  shown.forEach((b, i) => {
    const up = b.close >= b.open;
    el("line", { x1: x(i), x2: x(i), y1: yp(b.high), y2: yp(b.low), class: up ? "wick up" : "wick down" }, svg);
    const top = yp(Math.max(b.open, b.close));
    el("rect", { x: x(i) - bodyW / 2, y: top, width: bodyW, height: Math.max(1, yp(Math.min(b.open, b.close)) - top), class: up ? "body up" : "body down" }, svg);
  });

  const lines = (list: typeof cols, y: (v: number) => number, offset: number) =>
    list.forEach((c, k) => {
      let run: string[] = [];
      const flush = () => {
        if (run.length > 1) el("polyline", { points: run.join(" "), class: `plot c${(k + offset) % 6}` }, svg);
        else if (run.length === 1) {
          const [px, py] = run[0]!.split(",");
          el("circle", { cx: px!, cy: py!, r: 2.5, class: `dot c${(k + offset) % 6}` }, svg);
        }
        run = [];
      };
      c.values.forEach((v, i) => (finite(v) ? run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`) : flush()));
      flush();
    });
  lines(priceCols, yp, 0);

  // Events: a tick under the bar each time one fires, a row per event at the foot of the price pane.
  events.forEach((c, k) => {
    const y = PRICE_H - 6 - k * 7;
    c.values.forEach((v, i) => {
      if (v === 1) el("rect", { x: x(i) - 1.5, y: y - 5, width: 3, height: 5, class: `tick c${(cols.length + k) % 6}` }, svg);
    });
  });

  if (paneCols.length) {
    const yl = pane(PRICE_H + GAP, PANE_H, paneCols.flatMap((c) => c.values.filter(finite)));
    lines(paneCols, yl, 0);
  }
  host.appendChild(svg);

  // Legend: each plot's colour, title and last value; each event's count over the bars shown.
  const legend = document.createElement("ul");
  legend.className = "legend";
  const item = (k: number, title: string, value: string) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = `swatch c${k % 6}`;
    const name = document.createElement("span");
    name.textContent = title;
    const val = document.createElement("span");
    val.className = "value";
    val.textContent = value;
    li.append(sw, name, val);
    legend.appendChild(li);
  };
  cols.forEach((c, k) => {
    const last = [...c.values].reverse().find(finite);
    item(k, c.title, last === undefined ? "na" : fmt(last));
  });
  events.forEach((c, k) => {
    const n = c.values.filter((v) => v === 1).length;
    item(cols.length + k, c.title, `${n}×`);
  });
  if (all.length) host.appendChild(legend);
}
