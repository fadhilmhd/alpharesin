import { convert, type Converted, type Issue } from "../src/convert";
import { columnsCsv, parseBars, type Bar, type InputSpec, type InputValue } from "../src/runner";
import { renderChart } from "./chart";
import { SAMPLES } from "./samples";
import type { Answer, Ask } from "./worker";

/**
 * The AlphaResin playground: paste a script, see what converts and what is
 * left out, read the module, run it on sample bars or your own CSV. Nothing
 * leaves the page: conversion runs here, the module runs in a worker.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = $<HTMLTextAreaElement>("source");
const sample = $<HTMLSelectElement>("sample");
const status = $("status");
const notes = $("notes");
const code = $("code");
const inputsBox = $("inputs");
const runStatus = $("run-status");
const chart = $("chart");
const strategyBox = $("strategy");
const libList = $("lib-list");
const libCount = $("lib-count");

const STORE = "alpharesin.playground.v1";
/** A run that takes longer than this is stopped: most likely a loop that never ends. */
const RUN_LIMIT_MS = 10_000;

// ---------------- sample bars ----------------

/** Synthetic hourly bars from a seeded walk: the same every time, and plainly not market data. */
function sampleBars(n = 600): Bar[] {
  let seed = 20261005;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const start = Date.UTC(2026, 0, 1);
  let price = 100;
  let drift = 0;
  return Array.from({ length: n }, (_, i) => {
    if (i % 80 === 0) drift = (rnd() - 0.5) * 0.25;
    const open = price;
    price = Math.max(5, price + drift + (rnd() - 0.5) * 1.6);
    const high = Math.max(open, price) + rnd() * 0.8;
    const low = Math.min(open, price) - rnd() * 0.8;
    const r = (v: number) => Math.round(v * 100) / 100;
    return { time: start + i * 3_600_000, open: r(open), high: r(high), low: r(low), close: r(price), volume: Math.round(500 + rnd() * 1500) };
  });
}

let bars: { bars: Bar[]; periodMs: number; tick: number; label: string } = { bars: sampleBars(), periodMs: 3_600_000, tick: 0.01, label: "Sample bars (synthetic, hourly)" };

// ---------------- the worker ----------------

let worker: Worker | null = null;
let asked = 0;
const waiting = new Map<number, (a: Answer) => void>();

function startWorker(): Worker {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<Answer>) => {
    waiting.get(e.data.id)?.(e.data);
    waiting.delete(e.data.id);
  };
  return w;
}

/** Omit over each member of a union, not over their common keys. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function ask(message: Without<Ask, "id">, limit = RUN_LIMIT_MS): Promise<Answer> {
  worker ??= startWorker();
  const id = ++asked;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Stuck: stop it, and start afresh next time.
      worker?.terminate();
      worker = null;
      for (const [k, done] of waiting) done({ id: k, ok: false, error: `Stopped after ${limit / 1000} s. Does the script have a loop that never ends?` });
      waiting.clear();
    }, limit);
    waiting.set(id, (a) => {
      clearTimeout(timer);
      resolve(a);
    });
    worker!.postMessage({ ...message, id } as Ask);
  });
}

// ---------------- libraries ----------------

function libraries(): { source: string }[] {
  return [...libList.querySelectorAll("textarea")].map((t) => ({ source: t.value })).filter((l) => l.source.trim() !== "");
}

function addLibrary(text = "") {
  const row = document.createElement("div");
  row.className = "lib";
  const area = document.createElement("textarea");
  area.spellcheck = false;
  area.value = text;
  area.rows = 6;
  area.setAttribute("aria-label", "Library source");
  area.placeholder = '//@version=6\nlibrary("MyLibrary")\n…';
  area.addEventListener("input", schedule);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    schedule();
  });
  row.append(area, remove);
  libList.appendChild(row);
  libCount.textContent = String(libList.children.length);
  area.focus();
}

// ---------------- converting ----------------

let current: Converted | null = null;
let module: { name: string; overlay: boolean; inputs: Record<string, InputSpec>; defaults: Record<string, InputValue> } | null = null;
let lastRun: { bars: Bar[]; columns: { title: string; values: (number | null)[] }[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The conversion (and module load) in progress, so Run can wait for the latest one. */
let updating: Promise<void> = Promise.resolve();

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    updating = update();
  }, 250);
  try {
    localStorage.setItem(STORE, source.value);
  } catch {
    // Private mode or full storage: the page works without it.
  }
}

function setStatus(kind: "ok" | "bad" | "busy", text: string) {
  status.className = `pill ${kind}`;
  status.textContent = text;
}

function jumpTo(lineNo: number) {
  const lines = source.value.split("\n");
  const start = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length + 1, 0);
  source.focus();
  source.setSelectionRange(start, start + (lines[lineNo - 1]?.length ?? 0));
  // Bring the line into view: about one line height per line above it.
  const lh = parseFloat(getComputedStyle(source).lineHeight) || 20;
  source.scrollTop = Math.max(0, (lineNo - 4) * lh);
}

function issueList(title: string, issues: Issue[], kind: "error" | "warning"): HTMLElement {
  const box = document.createElement("section");
  box.className = `issues ${kind}`;
  const h = document.createElement("h3");
  h.textContent = title;
  const ul = document.createElement("ul");
  for (const i of issues) {
    const li = document.createElement("li");
    const at = document.createElement("button");
    at.type = "button";
    at.className = "line";
    at.textContent = `Line ${i.line}`;
    at.addEventListener("click", () => jumpTo(i.line));
    const msg = document.createElement("span");
    msg.textContent = i.message;
    li.append(at, msg);
    ul.appendChild(li);
  }
  box.append(h, ul);
  return box;
}

function para(text: string, className = ""): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

async function update() {
  const text = source.value;
  if (!text.trim()) {
    current = null;
    module = null;
    setStatus("busy", "Waiting for a script");
    notes.replaceChildren(para("Paste a version 5 or 6 script, or start from a sample above.", "muted"));
    code.textContent = "";
    inputsBox.replaceChildren();
    return;
  }
  let c: Converted;
  try {
    c = convert(text, { libraries: libraries(), host: "the host" });
  } catch (e) {
    setStatus("bad", "Couldn't read it");
    notes.replaceChildren(para(e instanceof Error ? e.message : String(e)));
    return;
  }
  current = c;
  const parts: HTMLElement[] = [];
  if (c.ok) {
    const kind = c.library ? "library" : c.code.includes("P.strategy.") ? "strategy" : "indicator";
    setStatus("ok", c.warnings.length ? `Converts · ${c.warnings.length} left out` : "Converts");
    parts.push(para(`${c.name ?? "Script"}: ${kind}${c.overlay ? ", drawn over the price" : ", in its own pane"}.`, "lead"));
    if (c.library) parts.push(para("A library converts on its own; add it under “Libraries” to run the scripts that import it."));
  } else {
    setStatus("bad", `Doesn't convert yet · ${c.errors.length}`);
  }
  if (c.missingLibraries.length) parts.push(para(`It imports ${c.missingLibraries.join(", ")}. Add each one under “Libraries” (paste its source).`, "callout"));
  if (c.errors.length) parts.push(issueList("To address", c.errors, "error"));
  if (c.warnings.length) parts.push(issueList("Left out, with the reason", c.warnings, "warning"));
  if (c.ok && !c.warnings.length && !c.library) parts.push(para("Everything in it converted.", "muted"));
  notes.replaceChildren(...parts);
  code.textContent = c.ok ? c.code : "";
  $<HTMLButtonElement>("copy").disabled = !c.ok;
  $<HTMLButtonElement>("download").disabled = !c.ok;
  $<HTMLButtonElement>("run").disabled = !c.ok || c.library;

  module = null;
  inputsBox.replaceChildren();
  if (!c.ok || c.library) return;
  const a = await ask({ kind: "describe", code: c.code }, 5_000);
  if (current !== c) return; // edited meanwhile
  if (!a.ok || a.kind !== "describe") {
    notes.appendChild(para(`It converted, but the module didn't load: ${a.ok ? "unexpected answer" : a.error}`, "callout"));
    return;
  }
  module = a;
  renderInputs(a.inputs, a.defaults);
}

// ---------------- inputs ----------------

function renderInputs(specs: Record<string, InputSpec>, defaults: Record<string, InputValue>) {
  const fields = Object.entries(specs).map(([key, spec]) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const name = document.createElement("span");
    name.textContent = spec.label ?? key;
    let control: HTMLInputElement | HTMLSelectElement;
    if (spec.type === "bool") {
      control = document.createElement("input");
      control.type = "checkbox";
      control.checked = defaults[key] === true;
      wrap.classList.add("check");
    } else if (spec.options?.length) {
      control = document.createElement("select");
      for (const o of spec.options) control.add(new Option(o, o, false, String(defaults[key]) === o));
    } else {
      control = document.createElement("input");
      control.type = spec.type === "int" || spec.type === "float" ? "number" : "text";
      if (spec.type === "int") control.step = "1";
      if (spec.type === "float") control.step = "any";
      if (spec.min !== undefined) control.min = String(spec.min);
      if (spec.max !== undefined) control.max = String(spec.max);
      control.value = String(defaults[key]);
    }
    control.dataset.key = key;
    control.dataset.type = spec.type;
    wrap.append(name, control);
    return wrap;
  });
  if (fields.length) {
    const h = document.createElement("h3");
    h.textContent = "Inputs";
    inputsBox.replaceChildren(h, ...fields);
  } else inputsBox.replaceChildren();
}

function readInputs(): Record<string, InputValue> {
  const values: Record<string, InputValue> = { ...(module?.defaults ?? {}) };
  for (const control of inputsBox.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
    const key = control.dataset.key!;
    const type = control.dataset.type;
    if (control instanceof HTMLInputElement && control.type === "checkbox") values[key] = control.checked;
    else if (type === "int" || type === "float" || typeof module?.defaults[key] === "number") {
      const n = Number(control.value);
      if (Number.isFinite(n)) values[key] = n;
    } else values[key] = control.value;
  }
  return values;
}

// ---------------- running ----------------

/** Bring the conversion up to date with the editor, and wait for its module. */
async function settled() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    updating = update();
  }
  await updating;
}

async function run() {
  await settled();
  if (!current?.ok || !module) {
    runStatus.textContent = current?.ok ? "The module didn't load: see Notes." : "Nothing to run: the script doesn't convert yet.";
    return;
  }
  const c = current;
  runStatus.textContent = "Running…";
  strategyBox.replaceChildren();
  const a = await ask({ kind: "run", code: c.code, bars: bars.bars, periodMs: bars.periodMs, mintick: bars.tick, inputs: readInputs() });
  if (!a.ok || a.kind !== "run") {
    runStatus.textContent = a.ok ? "Unexpected answer" : a.error;
    chart.replaceChildren();
    lastRun = null;
    $<HTMLButtonElement>("download-csv").disabled = true;
    return;
  }
  lastRun = { bars: bars.bars, columns: a.columns };
  runStatus.textContent = `${bars.label}: ${bars.bars.length} bars in ${a.ms} ms. The chart shows the latest ones.`;
  renderChart(chart, bars.bars, a.columns, module.overlay);
  $<HTMLButtonElement>("download-csv").disabled = false;
  if (a.strategy) {
    const s = a.strategy;
    const stat = (label: string, value: string) => {
      const d = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      d.append(dt, dd);
      return d;
    };
    const dl = document.createElement("dl");
    dl.className = "stats";
    dl.append(
      stat("Net profit", `${s.netProfit.toFixed(2)} (${s.netProfitPct.toFixed(2)}%)`),
      stat("Closed trades", String(s.trades)),
      stat("Profit factor", s.profitFactor === null ? "–" : s.profitFactor.toFixed(2)),
      stat("Initial capital", s.initialCapital.toLocaleString("en")),
    );
    const h = document.createElement("h3");
    h.textContent = "Strategy results";
    strategyBox.replaceChildren(h, dl, para("A simulation on these bars, filled the way the strategy's settings describe. Not a record of real trades.", "muted"));
  }
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = () => (current?.name ?? "script").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "script";

// ---------------- wiring ----------------

for (const [k, s] of SAMPLES.entries()) sample.add(new Option(s.name, String(k)));
sample.add(new Option("Your own script", "blank"));
let shown = sample.value;
sample.addEventListener("change", () => {
  // Never drop the user's own work without asking.
  const own = source.value.trim() !== "" && !SAMPLES.some((s) => s.source === source.value);
  if (own && !confirm(sample.value === "blank" ? "Clear your script?" : "Replace your script with this sample?")) {
    sample.value = shown;
    return;
  }
  shown = sample.value;
  source.value = sample.value === "blank" ? "" : SAMPLES[Number(sample.value)]!.source;
  schedule();
});

source.addEventListener("input", schedule);
source.addEventListener("keydown", (e) => {
  // Tab indents (four spaces, as Pine blocks are written) instead of leaving the editor; Esc then Tab leaves it.
  if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && source.dataset.tabs !== "off") {
    e.preventDefault();
    source.setRangeText("    ", source.selectionStart, source.selectionEnd, "end");
    schedule();
  } else if (e.key === "Escape") source.dataset.tabs = "off";
});
source.addEventListener("focus", () => delete source.dataset.tabs);

const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")!).hidden = !on;
    }
  });
  tab.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(tab);
    const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : null;
    if (next) {
      next.click();
      next.focus();
    }
  });
}

$("add-lib").addEventListener("click", () => addLibrary());
$("copy").addEventListener("click", async () => {
  if (!current?.ok) return;
  try {
    await navigator.clipboard.writeText(current.code);
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  } catch {
    download(`${fileName()}.js`, current.code, "text/javascript");
  }
});
$("download").addEventListener("click", () => current?.ok && download(`${fileName()}.js`, current.code, "text/javascript"));
$("run").addEventListener("click", run);
$("download-csv").addEventListener("click", () => lastRun && download(`${fileName()}-values.csv`, columnsCsv(lastRun.bars, lastRun.columns), "text/csv"));

const barsChoice = $<HTMLSelectElement>("bars-choice");
const barsFile = $<HTMLInputElement>("bars-file");
barsChoice.addEventListener("change", () => {
  if (barsChoice.value === "file") barsFile.click();
  else {
    bars = { bars: sampleBars(), periodMs: 3_600_000, tick: 0.01, label: "Sample bars (synthetic, hourly)" };
    runStatus.textContent = "";
  }
});
barsFile.addEventListener("change", async () => {
  const f = barsFile.files?.[0];
  if (!f) {
    barsChoice.value = "sample";
    return;
  }
  try {
    const parsed = parseBars(await f.text());
    bars = { ...parsed, label: f.name };
    runStatus.textContent = `${f.name}: ${parsed.bars.length} bars read. Press Run.`;
  } catch (e) {
    runStatus.textContent = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
    barsChoice.value = "sample";
  }
});

let saved: string | null = null;
try {
  saved = localStorage.getItem(STORE);
} catch {
  // No storage: start from the first sample.
}
source.value = saved ?? SAMPLES[0]!.source;
if (saved !== null) {
  const k = SAMPLES.findIndex((s) => s.source === saved);
  sample.value = k >= 0 ? String(k) : "blank";
}
shown = sample.value;
updating = update();
