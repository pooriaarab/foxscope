// T1-T3 and P5 in docs/failure-modes.md: the tamper-evident trail.
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
