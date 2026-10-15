// S1-S5, R5 and R6 in docs/failure-modes.md: the Node store and the optional resolvers.
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoResolver } from "../src/index.js";
import { fileStore, foxscopeHome, loadResolvers, openScope } from "../src/node.js";

const missing = (name: string) => Promise.reject(Object.assign(new Error(`Cannot find package '${name}' imported from x`), { code: "ERR_MODULE_NOT_FOUND" }));
const inner = () => Promise.reject(Object.assign(new Error("Cannot find package 'zod' imported from foxprefs"), { code: "ERR_MODULE_NOT_FOUND" }));
const temp = () => mkdtempSync(join(tmpdir(), "fsc-node-"));
const mode = (path: string) => statSync(path).mode & 0o777;

describe("foxscope/node", () => {
  it("S5: uses FOXSCOPE_HOME, else ~/.foxscope, with private modes", async () => {
    expect(foxscopeHome({})).toBe(join(homedir(), ".foxscope"));
    expect(foxscopeHome({ FOXSCOPE_HOME: "/tmp/x" })).toBe("/tmp/x");
    const home = join(temp(), "home");
    const scope = await openScope({ home, resolvers: [demoResolver()] });
    await scope.addRule({ agent: "a", fields: "demo.*", maxTtlSeconds: 60 });
    expect(mode(home)).toBe(0o700);
    expect(readdirSync(home).toSorted()).toEqual(["state.json", "trail.jsonl", "trail.key"]);
    for (const f of ["state.json", "trail.key"]) expect(mode(join(home, f))).toBe(0o600);
    expect(await scope.verifyTrail()).toMatchObject({ ok: true, count: 1 });
  });

  it("keeps grants and the trail across processes", async () => {
    const home = temp();
    const agent = await openScope({ home, resolvers: [demoResolver()] });
    const asked = await agent.request({ agent: "cli", fields: ["demo.travel.home"], purpose: "p" });
    const user = await openScope({ home, resolvers: [demoResolver()] });
    if (asked.status !== "pending") throw new Error("expected pending");
    const grant = await user.approve(asked.requestId);
    expect(await agent.read(grant.id)).toEqual({ "demo.travel.home": "Toronto" });
    expect(await user.verifyTrail()).toMatchObject({ ok: true, count: 3 });
  });

  it("S1: refuses a corrupt state.json and leaves it as it is", async () => {
    const home = temp();
    for (const text of ["{not json", JSON.stringify({ version: 9 })]) {
      writeFileSync(join(home, "state.json"), text);
      const scope = await openScope({ home, resolvers: [demoResolver()] });
      await expect(scope.list()).rejects.toMatchObject({ code: "corrupt-store", message: expect.stringContaining(join(home, "state.json")) });
      expect(readdirSync(home).includes("state.json.lock")).toBe(false);
      expect(statSync(join(home, "state.json")).size).toBe(text.length);
    }
  });

  it("S2: two writers lose no change", async () => {
    const home = temp();
    const a = await openScope({ home, resolvers: [demoResolver()] });
    const b = await openScope({ home, resolvers: [demoResolver()] });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).addRule({ agent: `agent-${i}`, fields: "demo.*", maxTtlSeconds: 60 })));
    expect(await a.rules()).toHaveLength(20);
    expect(await b.verifyTrail()).toMatchObject({ ok: true, count: 20 });
  });

  it("S3: writes through a temp file and leaves none behind", async () => {
    const dir = temp();
    const store = fileStore(join(dir, "state.json"));
    writeFileSync(join(dir, "state.json.123.tmp"), "half a write");
    await store.lock!(async () => store.save({ version: 1, lastNow: 1, rules: [], grants: [], requests: [], rate: {} }));
    expect(await store.load()).toMatchObject({ version: 1, lastNow: 1 });
    expect(readdirSync(dir).toSorted()).toEqual(["state.json", "state.json.123.tmp"]);
  });

  it("S4: takes a lock that a crashed writer left, and waits for a live one", async () => {
    const dir = temp();
    const lock = join(dir, "state.json.lock");
    const store = fileStore(join(dir, "state.json"), { lockTimeoutMs: 200 });
    writeFileSync(lock, "someone");
    await expect(store.lock!(async () => "ran")).rejects.toMatchObject({ code: "store-busy" });
    const old = (Date.now() - 11_000) / 1000;
    utimesSync(lock, old, old);
    expect(await store.lock!(async () => "ran")).toBe("ran");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("R5: runs without foxprefs and foxpack and says so", async () => {
    const none = await loadResolvers({ demo: false, importModule: missing });
    expect(none).toEqual({ resolvers: [], status: { foxprefs: "not installed", foxpack: "not installed" } });
    const demo = await loadResolvers({ demo: true, importModule: missing });
    expect(demo.resolvers.map((r) => r.namespace)).toEqual(["demo"]);
    const fake = { namespace: "prefs", list: async () => [], read: async () => ({}) };
    const one = await loadResolvers({ demo: false, importModule: (name) => (name === "foxprefs" ? Promise.resolve({ prefsResolver: () => fake }) : missing(name)) });
    expect(one).toEqual({ resolvers: [fake], status: { foxprefs: "installed", foxpack: "not installed" } });
  });

  it("R7: loads foxpack from its npm name, @pooriaarab/foxpack", async () => {
    const fake = { namespace: "memory", list: async () => [], read: async () => ({}) };
    const asked: string[] = [];
    const got = await loadResolvers({ demo: false, importModule: (name) => { asked.push(name); return name === "@pooriaarab/foxpack" ? Promise.resolve({ memoryResolver: () => fake }) : missing(name); } });
    expect(asked).toEqual(["foxprefs", "@pooriaarab/foxpack"]);
    expect(got).toEqual({ resolvers: [fake], status: { foxprefs: "not installed", foxpack: "installed" } });
  });

  it("R6: stops when a peer is there but broken", async () => {
    await expect(loadResolvers({ demo: false, importModule: async () => ({}) })).rejects.toThrow(/foxprefs is installed but has no prefsResolver\(\) export/);
    await expect(loadResolvers({ demo: false, importModule: inner })).rejects.toThrow(/zod/);
  });
});
