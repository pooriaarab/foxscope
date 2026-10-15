// T1-T5 and P5 in docs/failure-modes.md: the tamper-evident trail.
import { describe, expect, it } from "vitest";
import { MemoryStore, type Entry, type Store } from "foxtrail";
import { SIZES, setup, shop } from "./helpers.js";

describe("trail", () => {
  it("T1: logs each step of a full exchange", async () => {
    const { scope, kinds, entries } = await setup();
    await scope.request({ ...shop, fields: ["demo.health.allergies"] });
    const asked = await scope.request(shop);
    if (asked.status !== "pending") throw new Error("expected pending");
    const grant = await scope.approve(asked.requestId);
    await scope.read(grant.id);
    await scope.revoke(grant.id);
    await scope.read(grant.id).catch(() => {});
    const denied = await scope.request({ ...shop, purpose: "other" });
    if (denied.status === "pending") await scope.deny(denied.requestId);
    expect(await kinds()).toEqual(["scent.refuse", "scent.request", "scent.grant", "scent.read", "scent.revoke", "scent.read.refused", "scent.request", "scent.deny"]);
    const actors = (await entries()).map((e) => e.actor);
    expect(actors).toEqual([shop.agent, shop.agent, "user", shop.agent, "user", shop.agent, shop.agent, "user"]);
    expect(await scope.verifyTrail()).toMatchObject({ ok: true, count: 8 });
  });

  it("T4: each grant entry says which agent got it, and why", async () => {
    const { scope, entries } = await setup({ grantPublic: true, rules: [{ agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 600 }] });
    await scope.request(shop);
    await scope.request({ ...shop, agent: "mcp-agent", fields: ["demo.profile.name"], purpose: "Say hello" });
    const asked = await scope.request({ ...shop, fields: ["demo.travel.home"], purpose: "Plan a trip" });
    if (asked.status !== "pending") throw new Error("expected pending");
    await scope.approve(asked.requestId);
    const grants = (await entries()).filter((e) => e.kind === "scent.grant").map((e) => [e.actor, (e.data as Record<string, unknown>).agent, (e.data as Record<string, unknown>).purpose]);
    expect(grants).toEqual([
      ["rule", shop.agent, shop.purpose],
      ["public", "mcp-agent", "Say hello"],
      ["user", shop.agent, "Plan a trip"],
    ]);
  });

  it("T5: how much one site can add to the trail: 31 request entries a minute, one per read of its own grant, none for a guessed id", async () => {
    const { scope, kinds, clock } = await setup({ rules: [{ agent: "https://shop.example", fields: "demo.travel.*", maxTtlSeconds: 600 }] });
    for (let i = 0; i < 200; i++) await scope.request({ ...shop, agent: `https://s${i}.shop.example`, fields: ["demo.nope"] });
    expect((await kinds()).length).toBe(31);
    clock.advance(61);
    const granted = await scope.request({ ...shop, fields: ["demo.travel.home"] });
    if (granted.status !== "granted") throw new Error("expected granted");
    const before = (await kinds()).length;
    for (let i = 0; i < 50; i++) await scope.read(granted.grantId, undefined, { agent: shop.agent });
    expect((await kinds()).length - before).toBe(50);
    for (let i = 0; i < 50; i++) await scope.read(`g-guess${i}`, undefined, { agent: shop.agent }).catch(() => {});
    expect((await kinds()).length - before).toBe(50);
  });

  it("P5: the trail holds field names, not values", async () => {
    const { scope, trail } = await setup({ rules: [{ agent: shop.agent, fields: "demo.**", maxTtlSeconds: 60 }] });
    const answer = await scope.request({ ...shop, fields: [...SIZES, "demo.shopping.budget"] });
    expect(answer).toMatchObject({ values: { "demo.shopping.budget": "180 CAD" } });
    const text = await trail.exportJsonl();
    expect(text).toContain("demo.shopping.budget");
    expect(text).not.toContain("180 CAD");
    expect(text).not.toContain("42 EU");
  });

  it("T2: no trail, no values", async () => {
    class BrokenStore extends MemoryStore {
      broken = false;
      override async append(entry: Entry) {
        if (this.broken) throw new Error("disk full");
        return super.append(entry);
      }
    }
    const trailStore = new BrokenStore();
    const { scope, notices } = await setup({ trailStore, rules: [{ agent: shop.agent, fields: "demo.**", maxTtlSeconds: 60 }] });
    const answer = await scope.request(shop);
    if (answer.status !== "granted") throw new Error("expected a grant");
    trailStore.broken = true;
    await expect(scope.read(answer.grantId)).rejects.toThrow("disk full");
    expect(notices).toHaveLength(1);
  });

  it("T3: finds an edited entry", async () => {
    const rows: Entry[] = [];
    const trailStore: Store = {
      count: async () => rows.length,
      last: async () => rows.at(-1),
      all: async () => structuredClone(rows),
      append: async (entry) => void rows.push(structuredClone(entry)),
    };
    const { scope } = await setup({ trailStore });
    await scope.request(shop);
    await scope.request({ ...shop, purpose: "second" });
    expect(await scope.verifyTrail()).toMatchObject({ ok: true, count: 2 });
    rows[1] = { ...rows[1]!, data: { ...(rows[1]!.data as object), purpose: "harmless" } };
    expect(await scope.verifyTrail()).toMatchObject({ ok: false, index: 1, reason: "bad-hash" });
  });
});
