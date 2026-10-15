// The Firefox E2E test. It installs the E2E build (dist-e2e/: the release
// extension, with the page API also on 127.0.0.1 and localhost) and plays a
// shop agent page (e2e/site/index.html) against it, as a user would:
//
//   1. The page asks for a private field: refused at once, nothing waits (P1, E4).
//   2. A hostile call with a getter, a proxy or a made-up agent gets nothing (E1, E2).
//   3. The page asks for two sizes and a budget. The request shows in the
//      manager page; the test approves it with smaller answers on the approval page.
//   4. The page gets exactly those three values, the budget as a band (P7).
//   5. Each read leaves a notice: a Firefox notification and a line in the manager (N2).
//   6. Another origin cannot read the grant (E3, local run only: Ichabod
//      serves both pages from one tunnel origin).
//   7. Revoke in the manager page; the next read fails (G2).
//   8. The trail verifies in the manager page (T3).
//
// Usage: pnpm e2e [--headed] [--shots <dir>]. FOXKIT_BROWSER=ichabod runs it
// on Ichabod. --shots saves PNGs of the agent page. Writes artifacts/e2e-<date>.json.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserMode, launch, poll, serve, writeArtifact } from "create-foxkit/e2e";

const args = process.argv.slice(2);
const shots = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1]) : null;
const remote = browserMode() === "ichabod";
const record = { startedAt: new Date().toISOString(), mode: remote ? "ichabod" : "local", checks: [], skipped: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (p, selector) => p.evaluate((s) => document.querySelector(s).click(), selector);

const site = await serve("e2e/site");
let fox;
try {
  // Firefox's own alert windows, so a local run needs no desktop notification service. Ichabod takes no prefs.
  fox = await launch({ extension: "dist-e2e", headless: !args.includes("--headed"), ...(remote ? {} : { prefs: { "alerts.useSystemBackend": false } }) });
  record.firefox = await fox.browser.version();
  const page = await fox.open(`${site.url}/index.html`);
  const origin = await page.evaluate(() => location.origin);
  await poll(page, () => typeof window.scent?.request === "function");
  const status = (state) => poll(page, (s) => document.getElementById("status").dataset.state === s && JSON.parse(document.getElementById("result").textContent), state, 60_000);

  // 1. A private field: refused at once.
  await click(page, "#ask-private");
  check("a private field is refused", { status: "denied", reason: "private-field: demo.health.allergies" }, await status("denied"));

  // 2. Hostile calls.
  const hostile = await page.evaluate(async () => {
    // It runs in the page, so it must be defined in the page.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const settle = (p) => p.then((v) => ({ value: v }), (e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return {
      getter: await settle(window.scent.request({ get fields() { return ["demo.profile.name"]; }, purpose: "x" })),
      proxy: await settle(window.scent.request(new Proxy({ fields: ["demo.profile.name"], purpose: "x" }, {}))),
      spoof: await settle(window.scent.request({ agent: "https://bank.example", fields: ["demo.profile.name"], purpose: "Say hello" })),
      replaced: (() => { window.scent = { request: () => "fake" }; return typeof window.scent.request === "function" && window.scent.request.toString().includes("native"); })(),
    };
  });
  check("a getter on the request gives nothing", { status: "denied", reason: "bad-request: fields must be a non-empty array" }, hostile.getter.value);
  check("a proxy request is rejected", "foxscope: purpose must be a string", hostile.proxy.error);
  check("a public field is granted without asking", { "demo.profile.name": "Sam Fox" }, hostile.spoof.value?.values);
  check("the page cannot replace window.scent", true, hostile.replaced);

  // 3. Ask for sizes and a budget; approve in the extension with smaller answers.
  await click(page, "#ask");
  await status("waiting");
  const manager = await fox.openExtensionPage("manager.html");
  const requestId = await poll(manager, () => document.querySelector("[data-request]")?.dataset.request, undefined, 30_000);
  const managerShows = await manager.evaluate((id) => {
    const card = document.querySelector(`[data-request="${id}"]`);
    return { agent: card.querySelector(".site").textContent, fields: [...card.querySelectorAll(".chip")].map((c) => c.textContent) };
  }, requestId);
  check("the manager shows the request from the page origin only", { agent: origin, fields: ["demo.shopping.size.top", "demo.shopping.size.shoe", "demo.shopping.budget"] }, managerShows);
  check("a made-up agent is ignored: each grant is for the page origin", [origin], await manager.evaluate(() => [...new Set([...document.querySelectorAll("[data-grant] .site")].map((s) => s.textContent))]));
  check("only one request waits (the private one never did)", 1, await manager.evaluate(() => document.querySelectorAll("[data-request]").length));
  const approve = await fox.openExtensionPage(`approve.html#${requestId}`);
  const shown = await poll(approve, () => !document.getElementById("request").hidden && { agent: document.getElementById("agent").textContent, purpose: document.getElementById("purpose").textContent, labels: [...document.querySelectorAll("#fields .label")].map((l) => l.textContent), smaller: !document.getElementById("smaller").hidden });
  check("the approval page shows origin, purpose and each field", { agent: origin, purpose: "Find clothes that fit you, inside your budget", labels: ["Top size", "Shoe size", "Monthly clothes budget"], smaller: true }, shown);
  await click(approve, "#smaller");
  check("the approval page confirms", true, (await poll(approve, () => document.getElementById("decision").textContent)).startsWith("Approved with smaller answers"));

  // 4. The page got only those values.
  const values = await status("granted");
  check("the page gets exactly the granted values, the budget as a band", { "demo.shopping.size.top": "M", "demo.shopping.size.shoe": "42 EU", "demo.shopping.budget": "100-250 CAD" }, values);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "site-granted.png"), fullPage: true });
  }
  await click(page, "#read");
  check("a second read gives the same values", values, await status("read"));
  const grantId = await page.evaluate(() => grantId);

  // 5. Notices.
  const reads = await poll(manager, (n) => document.querySelectorAll("#notices li:not(.empty)").length >= n && [...document.querySelectorAll("#notices li")].map((li) => li.textContent), 3);
  check("the manager lists each read (public, approval, read again)", [true, true, true], reads.slice(0, 3).map((t) => t.includes(origin)));
  const shownNotices = await manager.evaluate(async () => Object.keys(await browser.notifications.getAll()).filter((k) => k.startsWith("fsc-read:")).length).catch((e) => `error: ${e.message}`);
  if (shownNotices === 3 || !remote) check("Firefox shows a notification for each read", 3, shownNotices);
  else record.skipped.push({ name: "Firefox shows a notification for each read", actual: shownNotices, reason: "Ichabod: notifications.getAll through the frame relay" });

  // 6. Another origin cannot read this grant.
  if (!remote) {
    const other = await fox.open(`${site.url.replace("127.0.0.1", "localhost")}/index.html`);
    await poll(other, () => typeof window.scent?.read === "function");
    check("another origin cannot read the grant", true, (await other.evaluate((id) => window.scent.read(id).then(() => "read", (e) => e.message), grantId)).includes("no-grant"));
    await other.close();
  } else record.skipped.push({ name: "another origin cannot read the grant", reason: "Ichabod: both pages share the tunnel origin; tests/read.test.ts G4 covers it" });

  // 7. Revoke in the manager; the next read fails.
  await poll(manager, (id) => Boolean(document.querySelector(`[data-grant="${id}"] .revoke`)), grantId);
  await click(manager, `[data-grant="${grantId}"] .revoke`);
  await poll(manager, (id) => !document.querySelector(`[data-grant="${id}"]`), grantId);
  await click(page, "#read");
  const refused = await status("error");
  check("a read after the revoke fails", true, refused.error?.includes("revoked"));

  // 8. The trail verifies.
  await sleep(500);
  await click(manager, "#verify");
  const verified = await poll(manager, () => document.getElementById("verify-status").textContent);
  check("the trail verifies", true, /^Trail OK: \d+ entries/.test(verified));
  record.trail = verified;
  record.trailKinds = await manager.evaluate(() => [...document.querySelectorAll("#trail tbody tr td:nth-child(3)")].map((td) => td.textContent).toReversed());
  // A read with an unknown grant id (step 6) is not logged, so a page cannot flood the trail with guesses.
  const expectedKinds = ["refuse", "refuse", "grant", "read", "request", "grant", "read", "read", "revoke", "read.refused"];
  check("the trail holds every step, oldest first", expectedKinds, record.trailKinds);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site.close();
}

record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
for (const s of record.skipped) console.log(`SKIP ${s.name}: ${s.reason}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.filter((c) => c.ok).length}/${record.checks.length} (${record.mode})${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
