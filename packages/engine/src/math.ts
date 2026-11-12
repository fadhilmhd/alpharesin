/** Pine's `math.*` helpers whose NaN behaviour differs from JavaScript's. */

export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);


/**
 * Measured against reference values from external chart exports (several studies,
 * daily and hourly bars), Pine's comparison operators treated floats within a
 * small tolerance as equal. The runtime uses 1e-10, a value chosen inside the
 * bounds measured, not a documented rule:
 * - a line 1.03e-11 above a band is not counted as above it (`line > upper` is
 *   false), while one 1.13e-6 above is; so the tolerance lies in [1.03e-11, 1.13e-6];
 * - a high equal to a barrier in decimal, but one ulp below the barrier's float64
 *   value (`a + 1.5 × b` rounds up), counts as touching it (`high >= barrier`);
 * - in ta.dmi, an up-move and a down-move that are equal in decimal but differ by
 *   about 1e-17 in float64 are a tie: neither move counts.
 * 1e-10 sits inside every bound measured. Absolute or relative can't be told
 * apart yet (the 1.03e-11 case is 1.2e-10 relative). Not every built-in follows
 * it: ta.pivothigh/ta.pivotlow compare exactly (a pivot whose right neighbour is
 * one ulp higher still counts).
 */
const CMP_EPS = 1e-10;

/** `a == b` as Pine evaluates it for floats. False when either is NaN. */
export const floatEq = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= CMP_EPS;
/** Pine's `a >= b` on floats. */
export const pineGe = (a: number, b: number): boolean => a >= b || floatEq(a, b);
/** Pine's `a <= b` on floats. */
export const pineLe = (a: number, b: number): boolean => a <= b || floatEq(a, b);
/** Pine's `a > b` on floats. */
export const pineGt = (a: number, b: number): boolean => a > b && !floatEq(a, b);

/**
 * One bar's directional movement for Pine's `ta.dmi`: [+DM, −DM] from the up-move
 * (high − high[1]) and the down-move (low[1] − low). Equal moves (to rounding,
 * see floatEq) count neither.
 */
export function directionalMove(up: number, down: number): [number, number] {
  const plus = Number.isNaN(up) ? NaN : pineGt(up, down) && up > 0 ? up : 0;
  const minus = Number.isNaN(down) ? NaN : pineGt(down, up) && down > 0 ? down : 0;
  return [plus, minus];
}

/**
 * One step of Pine's exponential smoothing, in the order that matched reference
 * values from external chart exports bit for bit (inferred from those values,
 * not a documented rule):
 * an oscillator built on two ta.ema agrees on every bar with `prev + α·(x − prev)`
 * and on fewer than half with `α·x + (1 − α)·prev`; an ATR (ta.rma) agrees on
 * every bar with `(prev·(L − 1) + x) / L` and on about one in sixteen with the
 * other order. The last bit decides ties (a pivot with an equal bar beside it),
 * so the order matters.
 */
export const emaStep = (prev: number, x: number, length: number): number => prev + (2 / (length + 1)) * (x - prev);
/** ta.rma's step (Wilder): see emaStep. */
export const rmaStep = (prev: number, x: number, length: number): number => (prev * (length - 1) + x) / length;
