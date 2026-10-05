// End-to-end check of the built playground in Chromium: serves dist/playground
// on a throwaway port inside this process, then converts, runs and charts each
// kind of script, and stops a script that never ends. Screenshots go to
// SHOTS_DIR when it is set.
//   node packages/resin/scripts/build.mjs playground && node packages/resin/scripts/check-playground.mjs
import { chromium } from "@playwright/test";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/playground");
const shots = process.env.SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = normalize(join(dir, p));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

// The installed Chrome when there is one (as the e2e suite does locally); Playwright's own Chromium otherwise (CI).
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  const status = page.locator("#status");

  await status.filter({ hasText: "Converts" }).waitFor();
  check(true, "the first sample converts");
  await page.locator("#inputs label").first().waitFor({ state: "attached" });
  check((await page.locator("#inputs label").allTextContents()).join("|").includes("Fast length"), "its inputs are listed");

  await page.click("#t-code");
  check((await page.locator("#code").textContent()).includes("export default {"), "the module is shown");

  await page.click("#t-run");
  await page.click("#run");
  await page.locator("#chart svg").waitFor();
  const legend = (await page.locator(".legend").textContent()) ?? "";
  check(legend.includes("Fast") && legend.includes("Slow"), "a run draws the plots, with a legend");
  check(/600 bars in \d+ ms/.test((await page.locator("#run-status").textContent()) ?? ""), "the run says what it ran on");
  if (shots) await page.screenshot({ path: join(shots, "playground-run.png"), fullPage: true });

  // A strategy: results summed up.
  await page.selectOption("#sample", { label: "Breakout strategy" });
  // Run straight away: it waits for the conversion it hasn't seen yet.
  await page.click("#run");
  await page.locator(".stats").waitFor();
  check((await page.locator(".stats").textContent()).includes("Closed trades"), "a strategy's results are summed up");

  // What gets left out: four notes, each pointing at its line.
  await page.selectOption("#sample", { label: "What gets left out" });
  await status.filter({ hasText: "4 left out" }).waitFor();
  await page.click("#t-notes");
  check((await page.locator(".issues.warning li").count()) === 4, "the left-out notes are listed");
  await page.locator(".issues.warning .line").first().click();
  const selected = await page.evaluate(() => {
    const s = document.getElementById("source");
    return s.value.slice(s.selectionStart, s.selectionEnd);
  });
  check(selected.includes("request.financial"), "a note's line button selects that line");
  if (shots) await page.screenshot({ path: join(shots, "playground-notes.png") });

  // A script that doesn't convert.
  page.once("dialog", (d) => d.accept());
  await page.selectOption("#sample", { label: "Your own script" });
  await page.fill("#source", '//@version=6\nindicator("x")\nplot(ta.nosuchthing(close))\n');
  await status.filter({ hasText: "Doesn't convert yet" }).waitFor();
  check((await page.locator(".issues.error .line").first().textContent()) === "Line 3", "errors name their line");
  check(await page.locator("#run").isDisabled(), "Run is off until it converts");

  // A loop that never ends is stopped, and the page keeps working.
  await page.fill("#source", '//@version=6\nindicator("forever")\nx = 0\nwhile true\n    x += 1\nplot(x)\n');
  await status.filter({ hasText: "Converts" }).waitFor();
  await page.click("#t-run");
  await page.locator("#run:not([disabled])").waitFor();
  await page.click("#run");
  await page.locator("#run-status", { hasText: "Stopped after 10 s" }).waitFor({ timeout: 20_000 });
  check(true, "a never-ending loop is stopped after 10 s");
  await page.fill("#source", '//@version=6\nindicator("after")\nplot(close)\n');
  await status.filter({ hasText: "Converts" }).waitFor();
  await page.locator("#run:not([disabled])").waitFor();
  await page.click("#run");
  await page.locator("#chart svg").waitFor();
  check(true, "the next run works after a stopped one");

  // Nothing leaves the page: no requests beyond its own files.
  check(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);

  // Phone width and dark mode, for the eye.
  if (shots) {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await phone.goto(url);
    await phone.locator("#status", { hasText: "Converts" }).waitFor();
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!wide, "no sideways scrolling at phone width");
    await phone.screenshot({ path: join(shots, "playground-phone-dark.png"), fullPage: true });
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("Playground checks pass.");
