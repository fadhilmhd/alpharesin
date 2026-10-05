// Writes src/reference/params.ts from notes taken on TradingView's public Pine
// Script v6 Reference Manual (https://www.tradingview.com/pine-script-reference/v6/):
// each built-in function's parameter names (its longest form) and the
// namespaced variables and constants. These are names, facts of the language,
// noted from the manual as it reads on the page; no text of it is kept.
//
// To take the notes: open the manual in a browser, and in its developer
// console run the snippet below; save what it prints as a .json file.
//
//   const fns = {}; const members = [];
//   for (const el of document.querySelectorAll("main [id]")) {
//     const [kind, ...rest] = el.id.split("_"); const name = rest.join("_");
//     if (kind === "var" || kind === "const") { if (name.includes(".")) members.push(name); continue; }
//     if (kind !== "fun") continue;
//     let best = null;
//     for (const l of el.innerText.split("\n")) {
//       const m = /^([\w.]+(?:<[^>]*>)?)\((.*)\)\s*→/.exec(l.trim()); if (!m) continue;
//       const params = m[2].split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
//       if (!best || params.length > best.length) best = params;
//     }
//     fns[name] = best ?? [];
//   }
//   copy(JSON.stringify({ fns, members: members.sort() }));
//
// Then: node packages/resin/scripts/note-reference.mjs <notes.json>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/note-reference.mjs <notes.json>");
  process.exit(2);
}
const { fns, members } = JSON.parse(readFileSync(file, "utf8"));
const body = Object.keys(fns)
  .sort()
  .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(fns[k])},`)
  .join("\n");
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/reference/params.ts");
writeFileSync(
  out,
  `// Noted from TradingView's public Pine Script v6 Reference Manual by scripts/note-reference.mjs. Do not edit.
/** Built-in functions' parameter names (longest form), for placing named arguments. */
export const PARAMS: Record<string, string[]> = {
${body}
};

/** Built-in namespaced variables and constants (\`color.red\`, \`strategy.long\`). */
export const MEMBERS: ReadonlySet<string> = new Set(${JSON.stringify([...members].sort())});
`,
);
console.log(`${Object.keys(fns).length} functions, ${members.length} variables and constants`);
