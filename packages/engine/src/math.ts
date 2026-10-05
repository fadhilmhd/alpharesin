/** Pine's `math.*` helpers whose NaN behaviour differs from JavaScript's. */

export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
