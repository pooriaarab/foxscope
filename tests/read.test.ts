// G1-G5, P2, P7 and N1 in docs/failure-modes.md: what a grant gives back.
// tests/resolvers.test.ts covers P3, P8 and R2-R3 below the scope.
import { describe, expect, it } from "vitest";
import { ScopeError, type ScentField } from "../src/index.js";
import { SIZES, fakeResolver, setup, shop } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof ScopeError ? e.code : String(e)));
const rule = { agent: shop.agent, fields: "demo.shopping.**", maxTtlSeconds: 3600 };

async function granted(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ rules: [rule], ...o });
  const answer = await s.scope.request(shop);
  if (answer.status !== "granted") throw new Error(`expected a grant, got ${JSON.stringify(answer)}`);
  return { ...s, grantId: answer.grantId, answer };
}

describe("read", () => {
  it("gives the granted values, with a notice for each read", async () => {
    const { scope, grantId, answer, notices } = await granted();
    expect(answer.values).toEqual({ "demo.shopping.size.top": "M", "demo.shopping.size.shoe": "42 EU" });
    expect(await scope.read(grantId, ["demo.shopping.size.top"])).toEqual({ "demo.shopping.size.top": "M" });
    expect(notices.map((n) => n.fields)).toEqual([SIZES, ["demo.shopping.size.top"]]);
    expect(notices[0]).toMatchObject({ agent: shop.agent, grantId, purpose: shop.purpose, derive: false });
  });

  it("G1: refuses an expired grant", async () => {
    const { scope, clock, grantId } = await granted();
    clock.advance(3599);
    expect(await code(scope.read(grantId))).toBe("no error");
    clock.advance(1);
    expect(await code(scope.read(grantId))).toBe("expired");
  });

  it("G2: refuses a revoked grant", async () => {
    const { scope, grantId, kinds } = await granted();
    await scope.revoke(grantId);
    expect(await code(scope.read(grantId))).toBe("revoked");
    expect(await scope.list()).toEqual([]);
    expect((await kinds()).slice(-2)).toEqual(["scent.revoke", "scent.read.refused"]);
  });

  it("G1, G2: a revoke or an expiry while the resolver answers gives no values", async () => {
    const gate = { hold: false, entered: () => {}, release: () => {} };
    const { resolver } = fakeResolver("x", [{ name: "x.size", label: "Size", sensitivity: "ask" }], async (names) => {
      if (gate.hold) {
        gate.entered();
        await new Promise<void>((r) => (gate.release = r));
      }
      return Object.fromEntries(names.map((n) => [n, "secret"]));
    });
    const { scope, clock, kinds } = await setup({ resolvers: [resolver], rules: [{ agent: shop.agent, fields: "x.*", maxTtlSeconds: 60 }] });
    const slowRead = async (grantId: string, during: () => Promise<unknown> | void) => {
      gate.hold = true;
      const entered = new Promise<void>((r) => (gate.entered = r));
      const read = code(scope.read(grantId));
      await entered;
      gate.hold = false;
      await during();
      gate.release();
      return read;
    };
    const grant = async (purpose: string) => {
      const answer = await scope.request({ agent: shop.agent, fields: ["x.size"], purpose });
      if (answer.status !== "granted") throw new Error(`expected a grant, got ${JSON.stringify(answer)}`);
      return answer.grantId;
    };
    const revoked = await grant("one");
    expect(await slowRead(revoked, () => scope.revoke(revoked))).toBe("revoked");
    expect((await kinds()).slice(-2)).toEqual(["scent.revoke", "scent.read.refused"]);
    const expiring = await grant("two");
    expect(await slowRead(expiring, () => clock.advance(60))).toBe("expired");
  });

  it("G3: refuses a field the grant does not hold", async () => {
    const { scope, grantId } = await granted();
    expect(await code(scope.read(grantId, ["demo.travel.home"]))).toBe("field-not-granted");
  });

  it("G4: an unknown grant and another agent's grant look the same", async () => {
    const { scope, grantId } = await granted();
    expect(await code(scope.read("g-nothing"))).toBe("no-grant");
    expect(await code(scope.read(grantId, undefined, { agent: "someone-else" }))).toBe("no-grant");
    expect(await code(scope.revoke(grantId, { agent: "someone-else" }))).toBe("no-grant");
    expect(await code(scope.read(grantId, undefined, { agent: shop.agent }))).toBe("no error");
  });

  it("G5: a clock that goes back does not revive a grant", async () => {
    const { scope, clock, grantId } = await granted();
    clock.advance(3600);
    expect(await code(scope.read(grantId))).toBe("expired");
    clock.advance(-7200);
    expect(await code(scope.read(grantId))).toBe("expired");
  });

  it("P2: refuses a field that became private after the grant", async () => {
    const fields: ScentField[] = [{ name: "x.a", label: "A", sensitivity: "ask" }, { name: "x.b", label: "B", sensitivity: "ask" }];
    const { resolver } = fakeResolver("x", fields);
    const s = await setup({ resolvers: [resolver], rules: [{ agent: "a", fields: "x.*", maxTtlSeconds: 60 }] });
    const answer = await s.scope.request({ agent: "a", fields: ["x.a", "x.b"], purpose: "p" });
    if (answer.status !== "granted") throw new Error("expected a grant");
    fields[1] = { ...fields[1]!, sensitivity: "private" };
    expect(await code(s.scope.read(answer.grantId))).toBe("private-field");
    expect(await s.scope.read(answer.grantId, ["x.a"])).toEqual({ "x.a": "value of x.a" });
  });

  it("P7: a derive grant asks for the smaller answers", async () => {
    const { scope } = await setup({ rules: [{ ...rule, derive: true }] });
    const answer = await scope.request({ ...shop, fields: ["demo.shopping.budget", "demo.shopping.size.top"] });
    expect(answer).toMatchObject({ status: "granted", values: { "demo.shopping.budget": "100-250 CAD", "demo.shopping.size.top": "M" } });
  });

  it("N1: no notice, no values", async () => {
    const s = await setup({ rules: [rule], notify: () => { throw new Error("no notifications"); } });
    await expect(s.scope.request(shop)).rejects.toMatchObject({ code: "notice-failed" });
    expect((await s.kinds()).at(-1)).toBe("scent.read.refused");
  });
});
