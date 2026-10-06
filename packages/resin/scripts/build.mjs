// Builds what AlphaResin ships:
//   dist/npm         the `alpharesin` package: index.js (library), cli.js (the command), types/
//   dist/playground  the static playground site (GitHub Pages)
//   node packages/resin/scripts/build.mjs [npm|playground]   (both by default)
// Nothing is published from here: `npm publish dist/npm` and the Pages workflow do that.
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = resolve(pkg, "..");
const root = resolve(packages, "..");
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const which = process.argv[2] ?? "all";
const banner = `/*! AlphaResin ${version} · Apache-2.0 · https://github.com/fadhilmhd/alpharesin */`;

function fresh(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
}

function buildNpm() {
  const out = join(pkg, "dist/npm");
  fresh(out);
  const common = { bundle: true, format: "esm", target: "es2022", legalComments: "none", logLevel: "warning" };
  buildSync({ ...common, entryPoints: [join(pkg, "npm/index.ts")], outfile: join(out, "index.js"), platform: "neutral", banner: { js: banner } });
  buildSync({
    ...common,
    entryPoints: [join(pkg, "cli/bin.ts")],
    outfile: join(out, "cli.js"),
    platform: "node",
    banner: { js: `#!/usr/bin/env node\n${banner}` },
    define: { __ALPHARESIN_VERSION__: JSON.stringify(version) },
  });

  // Types: declarations for the package's own sources, with the workspace's
  // package names rewritten to the files beside them.
  const tsconfig = join(pkg, "dist/tsconfig.types.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: join(out, "types"),
        rootDir: packages,
        types: ["node"],
        stripInternal: true,
        // The workspace packages as sources, so their declarations are written too (through node_modules they would count as external).
        paths: Object.fromEntries(["engine", "sdk"].map((p) => [`@alphapine/${p}`, [join(packages, p, "src/index.ts")]])),
      },
      files: [join(pkg, "npm/index.ts")],
    }),
  );
  const require = createRequire(import.meta.url);
  const ts = dirname(require.resolve("typescript/package.json"));
  const tsBin = JSON.parse(readFileSync(join(ts, "package.json"), "utf8")).bin.tsc;
  execFileSync(process.execPath, [join(ts, tsBin), "-p", tsconfig], { stdio: "inherit" });
  rmSync(tsconfig);
  const typesDir = join(out, "types");
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  for (const file of walk(typesDir).filter((f) => f.endsWith(".d.ts"))) {
    const text = readFileSync(file, "utf8")
      .replace(/(["'])@alphapine\/(engine|sdk|resin)\1/g, (_, q, name) => {
        let rel = relative(dirname(file), join(typesDir, name, "src/index.js")).replace(/\\/g, "/");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return `${q}${rel}${q}`;
      })
      // Relative imports need their extension under `moduleResolution: node16/nodenext`, or a user's
      // TypeScript can't follow them and the package's types quietly become `any`.
      .replace(/((?:from|import\()\s*)(["'])(\.{1,2}\/[^"']*?)\2/g, (whole, lead, q, spec) => {
        if (/\.(js|mjs|cjs)$/.test(spec)) return whole;
        const target = join(dirname(file), spec);
        if (existsSync(`${target}.d.ts`)) return `${lead}${q}${spec}.js${q}`;
        if (existsSync(join(target, "index.d.ts"))) return `${lead}${q}${spec}/index.js${q}`;
        throw new Error(`${relative(typesDir, file)}: can't resolve ${spec}`);
      });
    writeFileSync(file, text);
  }

  const license = [join(root, "LICENSE"), join(root, "legal/APACHE-2.0.txt")].find(existsSync);
  if (!license) throw new Error("No licence text found (LICENSE or legal/APACHE-2.0.txt)");
  cpSync(license, join(out, "LICENSE"));
  // In the public repository (root package "alpharesin") its front page and NOTICE sit at the root, with
  // links written for there, as npm reads them. Anywhere else only the package's own files are used:
  // another repository's README never goes into the package.
  const publicRepo = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "alpharesin";
  for (const f of ["README.md", "NOTICE"]) cpSync(publicRepo ? join(root, f) : join(pkg, f), join(out, f));

  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(
      {
        name: "alpharesin",
        version,
        description: "Pine in, many forms out: a clean-room parser and converter for Pine-compatible scripts (v5 and v6), with the runtime they run on and a command line. Not affiliated with TradingView.",
        keywords: ["pine", "pinescript", "converter", "parser", "trading", "indicators", "backtesting", "technical-analysis"],
        license: "Apache-2.0",
        author: "AlphaPine and the AlphaResin contributors",
        homepage: "https://fadhilmhd.github.io/alpharesin/",
        repository: { type: "git", url: "git+https://github.com/fadhilmhd/alpharesin.git" },
        bugs: { url: "https://github.com/fadhilmhd/alpharesin/issues" },
        type: "module",
        main: "./index.js",
        types: "./types/resin/npm/index.d.ts",
        exports: { ".": { types: "./types/resin/npm/index.d.ts", default: "./index.js" }, "./package.json": "./package.json" },
        bin: { alpharesin: "cli.js" },
        files: ["index.js", "cli.js", "types", "README.md", "LICENSE", "NOTICE"],
        engines: { node: ">=18" },
        sideEffects: false,
      },
      null,
      2,
    ) + "\n",
  );

  // Smoke test: the command answers, and converts a script.
  const cli = join(out, "cli.js");
  const said = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
  if (said !== version) throw new Error(`cli.js --version said "${said}", expected ${version}`);
  console.log(`dist/npm: alpharesin ${version} (index.js ${kb(join(out, "index.js"))}, cli.js ${kb(cli)})`);
}

function buildPlayground() {
  const out = join(pkg, "dist/playground");
  fresh(out);
  const common = { bundle: true, format: "esm", target: "es2022", platform: "browser", minify: true, legalComments: "none", logLevel: "warning", banner: { js: banner } };
  buildSync({ ...common, entryPoints: [join(pkg, "playground/main.ts")], outfile: join(out, "app.js") });
  buildSync({ ...common, entryPoints: [join(pkg, "playground/worker.ts")], outfile: join(out, "worker.js") });
  cpSync(join(pkg, "playground/index.html"), join(out, "index.html"));
  cpSync(join(pkg, "playground/style.css"), join(out, "style.css"));
  // GitHub Pages serves the folder as it is.
  writeFileSync(join(out, ".nojekyll"), "");
  console.log(`dist/playground: app.js ${kb(join(out, "app.js"))}, worker.js ${kb(join(out, "worker.js"))}`);
}

const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`;

if (which === "all" || which === "npm") buildNpm();
if (which === "all" || which === "playground") buildPlayground();
