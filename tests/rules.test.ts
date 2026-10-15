// G8-G11, G14 and G16 in docs/failure-modes.md: standing rules and revoking an agent.
import { describe, expect, it } from "vitest";
import { ScopeError } from "../src/index.js";
import { SIZES, setup, shop } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof ScopeError ? e.code : String(e)));

describe("standing rules", () => {
  it("grants at once when rules cover every field, and logs the rule", async () => {
    const { scope, entries } = await setup();
    const rule = await scope.addRule({ agent: shop.agent, fields: "demo.shopping.size.*", maxTtlSeconds: 600 });
    expect(rule).toMatchObject({ source: "user", derive: false });
    expect(await scope.request(shop)).toMatchObject({ status: "granted", values: { "demo.shopping.size.top": "M" } });
    const grant = (await entries()).find((e) => e.kind === "scent.grant");
    expect(grant).toMatchObject({ actor: "rule", data: { via: "rule", ruleIds: [rule.id], fields: SIZES } });
  });

  it("G16: removing a rule ends the grants it made, and only those", async () => {
    const { scope, entries } = await setup();
    const rule = await scope.addRule({ agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 86_400 });
    const byRule = await scope.request(shop);
    if (byRule.status !== "granted") throw new Error("expected granted");
    const asked = await scope.request({ ...shop, fields: ["demo.travel.home"], purpose: "Trip" });
    if (asked.status !== "pending") throw new Error("expected pending");
    const byUser = await scope.approve(asked.requestId);
    await scope.removeRule(rule.id);
    expect(await code(scope.read(byRule.grantId))).toBe("revoked");
    expect((await scope.list()).map((g) => g.id)).toEqual([byUser.id]);
    expect((await entries()).find((e) => e.kind === "scent.rule.remove")?.data).toMatchObject({ ruleId: rule.id, grants: 1 });
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
  });

  it("G8: a rule that covers some fields gives pending for all", async () => {
    const { scope } = await setup({ rules: [{ agent: shop.agent, fields: "demo.shopping.size.top", maxTtlSeconds: 600 }] });
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
  });

  it("G9: the grant gets the shorter time", async () => {
    const { scope, clock } = await setup({ rules: [{ agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 600 }] });
    const long = await scope.request({ ...shop, ttlSeconds: 86_400 });
    expect(long.status === "granted" && Date.parse(long.expiresAt) - clock.now()).toBe(600_000);
    const short = await scope.request({ ...shop, purpose: "Again", ttlSeconds: 60 });
    expect(short.status === "granted" && Date.parse(short.expiresAt) - clock.now()).toBe(60_000);
  });

  it("G10: a rule names one agent exactly", async () => {
    const { scope } = await setup({ rules: [{ agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 600 }] });
    expect(await scope.request({ ...shop, agent: "https://shop.example.evil" })).toMatchObject({ status: "pending" });
    expect(await scope.request({ ...shop, agent: "*" })).toMatchObject({ status: "pending" });
  });

  it("G11: refuses a rule with no fixed namespace, no agent or no time", async () => {
    const { scope } = await setup();
    expect(await code(scope.addRule({ agent: "a", fields: "**", maxTtlSeconds: 60 }))).toBe("bad-rule");
    expect(await code(scope.addRule({ agent: "", fields: "demo.*", maxTtlSeconds: 60 }))).toBe("bad-rule");
    expect(await code(scope.addRule({ agent: "a", fields: "demo.*", maxTtlSeconds: 0 }))).toBe("bad-rule");
    expect(await scope.rules()).toEqual([]);
  });

  it("removes a user rule, but not a config rule", async () => {
    const { scope, kinds } = await setup({ rules: [{ agent: "a", fields: "demo.*", maxTtlSeconds: 60 }] });
    const rule = await scope.addRule({ agent: "b", fields: "demo.*", maxTtlSeconds: 60 });
    expect((await scope.rules()).map((r) => r.source)).toEqual(["config", "user"]);
    const config = (await scope.rules())[0]!;
    expect(await code(scope.removeRule(config.id))).toBe("not-found");
    await scope.removeRule(rule.id);
    expect((await scope.rules()).map((r) => r.agent)).toEqual(["a"]);
    expect(await kinds()).toEqual(["scent.rule.add", "scent.rule.remove"]);
  });

  it("G14: revoking an agent ends its grants, requests and rules", async () => {
    const { scope } = await setup();
    await scope.addRule({ agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 600 });
    const granted = await scope.request(shop);
    await scope.request({ ...shop, fields: ["demo.travel.home"] });
    await scope.request({ ...shop, agent: "other" });
    expect(await scope.revokeAgent(shop.agent)).toEqual({ grants: 1, requests: 1, rules: 1 });
    expect(granted.status === "granted" && (await code(scope.read(granted.grantId)))).toBe("revoked");
    expect((await scope.pending()).map((r) => r.agent)).toEqual(["other"]);
    expect(await scope.rules()).toEqual([]);
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
  });
});
