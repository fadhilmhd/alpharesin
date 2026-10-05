import { readFileSync, writeFileSync } from "node:fs";
import { loadModule } from "../src/runner";
import { main } from "./main";

/** Set by the build (scripts/build.mjs) from package.json. */
declare const __ALPHARESIN_VERSION__: string;

const status = await main(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text) => writeFileSync(path, text),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  load: loadModule,
  version: typeof __ALPHARESIN_VERSION__ === "string" ? __ALPHARESIN_VERSION__ : "dev",
});
process.exitCode = status;
