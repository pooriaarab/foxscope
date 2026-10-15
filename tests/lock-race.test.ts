// S6 in docs/failure-modes.md: a slow resolver must not hold the lock, and a
// change made while it runs (a revoke, a rule removal) is never undone.
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log } from "foxtrail";
import { FileStore, loadOrCreateKeyFile } from "foxtrail/node";
import { describe, expect, it } from "vitest";
import { createScope, demoResolver, type ScentResolver } from "../src/index.js";
import { fileStore } from "../src/node.js";

/** The demo resolver, whose list() waits for the test while `hold` is on. */
function gated() {
  const demo = demoResolver();
  const state = { hold: false, inside: Promise.resolve(), entered: () => {}, release: () => {} };
  const resolver: ScentResolver = {
    namespace: "demo",
    list: async () => {
      if (state.hold) {
        state.hold = false;
        state.entered();
        await new Promise<void>((r) => (state.release = r));
      }
      return demo.list();
    },
    read: (fields, opts) => demo.read(fields, opts),
  };
  const arm = () => {
    state.hold = true;
    state.inside = new Promise<void>((r) => (state.entered = r));
  };
  return { resolver, arm, inside: () => state.inside, release: () => state.release() };
}

async function twoProcesses() {
  const home = mkdtempSync(join(tmpdir(), "fsc-race-"));
  const key = await loadOrCreateKeyFile(join(home, "trail.key"));
  const open = (resolver: ScentResolver) =>
    createScope({ resolvers: [resolver], store: fileStore(join(home, "state.json"), { lockTimeoutMs: 500 }), trail: new Log({ store: new FileStore(join(home, "trail.jsonl")), key }) });
  const slow = gated();
  return { lock: join(home, "state.json.lock"), slow, mcp: open(slow.resolver), cli: open(demoResolver()) };
}

/** What the reviewer saw: the lock held over the resolver call goes stale, and the CLI takes it. */
function ageLock(lock: string) {
  if (!existsSync(lock)) return false;
  const old = (Date.now() - 11_000) / 1000;
  utimesSync(lock, old, old);
  return true;
}

describe("the lock and slow resolvers", () => {
  it("S6: a rule removed while a request waits on a resolver stays removed", async () => {
    const { lock, slow, mcp, cli } = await twoProcesses();
    const rule = await cli.addRule({ agent: "agent", fields: "demo.shopping.**", maxTtlSeconds: 600 });
    slow.arm();
    const asked = mcp.request({ agent: "agent", fields: ["demo.shopping.size.top"], purpose: "Fit" });
    await slow.inside();
    const held = ageLock(lock);
    await cli.removeRule(rule.id);
    slow.release();
    expect(await asked).toMatchObject({ status: "pending" });
    expect(await cli.rules()).toEqual([]);
    expect(await cli.list()).toEqual([]);
    expect(held, "the lock is free during the resolver call").toBe(false);
  });

  it("S6: a grant revoked while a read waits on a resolver stays revoked and gives nothing", async () => {
    const { lock, slow, mcp, cli } = await twoProcesses();
    await cli.addRule({ agent: "agent", fields: "demo.shopping.**", maxTtlSeconds: 600 });
    const granted = await cli.request({ agent: "agent", fields: ["demo.shopping.size.top"], purpose: "Fit" });
    if (granted.status !== "granted") throw new Error("expected granted");
    slow.arm();
    const read = mcp.read(granted.grantId, undefined, { agent: "agent" });
    await slow.inside();
    const held = ageLock(lock);
    await cli.revoke(granted.grantId);
    slow.release();
    await expect(read).rejects.toMatchObject({ code: "revoked" });
    expect(await cli.list()).toEqual([]);
    expect(held, "the lock is free during the resolver call").toBe(false);
  });

  it("S6: a request denied while an approval waits on a resolver is not granted", async () => {
    const { lock, slow, mcp, cli } = await twoProcesses();
    const asked = await cli.request({ agent: "agent", fields: ["demo.travel.home"], purpose: "Trip" });
    if (asked.status !== "pending") throw new Error("expected pending");
    slow.arm();
    const approved = mcp.approve(asked.requestId);
    await slow.inside();
    const held = ageLock(lock);
    await cli.deny(asked.requestId);
    slow.release();
    await expect(approved).rejects.toMatchObject({ code: "not-found" });
    expect(await cli.list()).toEqual([]);
    expect(held, "the lock is free during the resolver call").toBe(false);
  });
});
