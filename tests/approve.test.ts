// G6, G7, G12, G13, G15 and G18 in docs/failure-modes.md: the user's decision.
import { describe, expect, it } from "vitest";
import { PAGE_MAX_GRANT_SECONDS, ScopeError } from "../src/index.js";
import { SIZES, setup, shop } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof ScopeError ? e.code : String(e)));

async function asked(ttlSeconds?: number) {
  const s = await setup();
  const answer = await s.scope.request({ ...shop, ...(ttlSeconds ? { ttlSeconds } : {}) });
  if (answer.status !== "pending") throw new Error("expected pending");
  const [request] = await s.scope.pending();
  return { ...s, requestId: answer.requestId, request: request! };
}

describe("approve and deny", () => {
  it("approves the exact request, for the time the agent asked", async () => {
    const { scope, requestId, request, clock, kinds } = await asked(600);
    const grant = await scope.approve(requestId, { digest: request.digest });
    expect(grant).toMatchObject({ agent: shop.agent, fields: SIZES, purpose: shop.purpose, via: "user", derive: false, requestId });
    expect(Date.parse(grant.expiresAt) - clock.now()).toBe(600_000);
    expect(await scope.pending()).toEqual([]);
    expect(await scope.read(grant.id)).toEqual({ "demo.shopping.size.top": "M", "demo.shopping.size.shoe": "42 EU" });
    expect(await kinds()).toEqual(["scent.request", "scent.grant", "scent.read"]);
  });

  it("lets the user pick a shorter time and the smaller answers", async () => {
    const { scope, requestId, clock } = await asked(86_400);
    const grant = await scope.approve(requestId, { ttlSeconds: 60, derive: true });
    expect(Date.parse(grant.expiresAt) - clock.now()).toBe(60_000);
    expect(grant.derive).toBe(true);
  });

  it("uses one hour when nobody gives a time", async () => {
    const { scope, requestId, clock } = await asked();
    const grant = await scope.approve(requestId);
    expect(Date.parse(grant.expiresAt) - clock.now()).toBe(3_600_000);
  });

  it("G6: refuses an approval for a digest the page did not show", async () => {
    const { scope, requestId } = await asked();
    expect(await code(scope.approve(requestId, { digest: "0".repeat(64) }))).toBe("request-changed");
    expect(await scope.pending()).toHaveLength(1);
  });

  it("G7: a changed request needs a new approval", async () => {
    const { scope, requestId } = await asked();
    await scope.approve(requestId);
    expect(await scope.request(shop)).toMatchObject({ status: "granted" });
    expect(await scope.request({ ...shop, purpose: "Sell my data" })).toMatchObject({ status: "pending" });
    expect(await scope.request({ ...shop, fields: [...SIZES, "demo.travel.home"] })).toMatchObject({ status: "pending" });
    expect(await scope.request({ ...shop, fields: ["demo.shopping.size.top"] })).toMatchObject({ status: "granted", values: { "demo.shopping.size.top": "M" } });
  });

  it("G12: a request expires after 10 minutes", async () => {
    const { scope, requestId, clock } = await asked();
    clock.advance(601);
    expect(await scope.pending()).toEqual([]);
    expect(await code(scope.approve(requestId))).toBe("expired");
  });

  it("G13: a decision removes the request", async () => {
    const { scope, requestId, kinds } = await asked();
    await scope.deny(requestId);
    expect(await code(scope.approve(requestId))).toBe("not-found");
    expect(await code(scope.deny(requestId))).toBe("not-found");
    expect(await kinds()).toEqual(["scent.request", "scent.deny"]);
    const again = await scope.request(shop);
    if (again.status !== "pending") throw new Error("expected pending");
    await scope.approve(again.requestId);
    expect(await code(scope.approve(again.requestId))).toBe("not-found");
  });

  it("G15: refuses a time over 30 days", async () => {
    const { scope, requestId } = await asked();
    for (const ttlSeconds of [0, 1.5, 30 * 24 * 3600 + 1]) expect(await code(scope.approve(requestId, { ttlSeconds }))).toBe("bad-ttl");
  });

  it("refuses to approve a field that became private while it waited", async () => {
    const fields = [{ name: "x.a", label: "A", sensitivity: "ask" as const }];
    const s = await setup({ resolvers: [{ namespace: "x", list: async () => fields, read: async () => ({ "x.a": 1 }) }] });
    const answer = await s.scope.request({ agent: "a", fields: ["x.a"], purpose: "p" });
    if (answer.status !== "pending") throw new Error("expected pending");
    fields[0] = { ...fields[0]!, sensitivity: "private" as never };
    expect(await code(s.scope.approve(answer.requestId))).toBe("private-field");
  });

  it("G18: a scope with a grant cap gives no grant longer than the cap", async () => {
    expect(PAGE_MAX_GRANT_SECONDS).toBe(3600);
    const { scope, clock } = await setup({ maxGrantSeconds: PAGE_MAX_GRANT_SECONDS, grantPublic: true });
    const month = await scope.request({ ...shop, ttlSeconds: 2_592_000 });
    if (month.status !== "pending") throw new Error("expected pending");
    expect(await code(scope.approve(month.requestId, { ttlSeconds: 86_400 }))).toBe("bad-ttl");
    const grant = await scope.approve(month.requestId);
    expect(Date.parse(grant.expiresAt) - clock.now()).toBe(3_600_000);
    expect(await code(scope.addRule({ agent: shop.agent, fields: "demo.travel.*", maxTtlSeconds: 86_400 }))).toBe("bad-rule");
    await scope.addRule({ agent: shop.agent, fields: "demo.travel.*", maxTtlSeconds: 3600 });
    const byRule = await scope.request({ ...shop, fields: ["demo.travel.home"], purpose: "Trip", ttlSeconds: 2_592_000 });
    expect(byRule.status === "granted" && Date.parse(byRule.expiresAt) - clock.now()).toBe(3_600_000);
    const pub = await scope.request({ ...shop, fields: ["demo.profile.name"], purpose: "Hi", ttlSeconds: 2_592_000 });
    expect(pub.status === "granted" && Date.parse(pub.expiresAt) - clock.now()).toBe(3_600_000);
  });
});
