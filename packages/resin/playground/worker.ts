import { inputDefaults, runScript, type Bar, type InputSpec, type InputValue, type ResinModule } from "../src/runner";

/**
 * Runs a converted script off the page's thread, so a long run (or a loop
 * that never ends) can't freeze the page: the page stops this worker when
 * it takes too long. The script is the user's own, loaded from a blob: URL.
 */

export type Ask =
  | { id: number; kind: "describe"; code: string }
  | { id: number; kind: "run"; code: string; bars: Bar[]; periodMs: number; mintick: number; inputs: Record<string, InputValue> };

export type Answer =
  | { id: number; ok: true; kind: "describe"; name: string; overlay: boolean; inputs: Record<string, InputSpec>; defaults: Record<string, InputValue> }
  | { id: number; ok: true; kind: "run"; columns: { title: string; values: (number | null)[] }[]; strategy: ReturnType<typeof runScript>["strategy"]; ms: number }
  | { id: number; ok: false; error: string };

const cache = new Map<string, Promise<ResinModule>>();

function load(code: string): Promise<ResinModule> {
  let mod = cache.get(code);
  if (!mod) {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    mod = (import(/* @vite-ignore */ url) as Promise<ResinModule>).finally(() => URL.revokeObjectURL(url));
    cache.clear();
    cache.set(code, mod);
  }
  return mod;
}

self.onmessage = async (e: MessageEvent<Ask>) => {
  const ask = e.data;
  let answer: Answer;
  try {
    const mod = await load(ask.code);
    if (ask.kind === "describe") {
      answer = { id: ask.id, ok: true, kind: "describe", name: mod.default.name, overlay: mod.default.overlay === true, inputs: mod.default.inputs ?? {}, defaults: inputDefaults(mod) };
    } else {
      const t0 = performance.now();
      const r = runScript(mod, ask.bars, { inputs: ask.inputs, periodMs: ask.periodMs, mintick: ask.mintick });
      answer = { id: ask.id, ok: true, kind: "run", columns: r.columns, strategy: r.strategy, ms: Math.round(performance.now() - t0) };
    }
  } catch (err) {
    answer = { id: ask.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(answer);
};
