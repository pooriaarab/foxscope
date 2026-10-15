// I1, I5-I9, P1 and G17 in docs/failure-modes.md: what an agent can ask for.
// tests/fields.test.ts checks each bad shape; here the scope must refuse and log.
import { describe, expect, it } from "vitest";
import { createScope, demoResolver, parseState } from "../src/index.js";
import { setup, shop } from "./helpers.js";

const denied = (reason: string) => ({ status: "denied", reason: expect.stringMatching(new RegExp(`^${reason}`)) });

describe("request", () => {
  it("I1-I4: denies a bad request and logs the refusal without its content", async () => {
    const { scope, entries } = await setup();
    expect(await scope.request({ ...shop, agent: "" })).toEqual(denied("bad-request: agent"));
    expect(await scope.request({ ...shop, fields: ["nodot"] })).toEqual(denied("bad-request: fields"));
    expect(await scope.request({ ...shop, purpose: "x".repeat(501) })).toEqual(denied("bad-request: purpose"));
    expect(await scope.request({ ...shop, ttlSeconds: 0 })).toEqual(denied("bad-request: ttlSeconds"));
    expect((await entries()).map((e) => [e.actor, e.kind, e.data])).toEqual([
      ["unknown", "scent.refuse", { reason: "bad-request" }],
      ...Array.from({ length: 3 }, () => [shop.agent, "scent.refuse", { reason: "bad-request" }]),
    ]);
  });

  it("I5: refuses a field that no resolver lists", async () => {
    const { scope, kinds } = await setup();
    expect(await scope.request({ ...shop, fields: ["demo.shopping.size.hat"] })).toEqual(denied("unknown-field: demo.shopping.size.hat"));
    expect(await scope.request({ ...shop, fields: ["prefs.shopping.size.top"] })).toEqual(denied("unknown-field: prefs.shopping.size.top"));
    expect(await kinds()).toEqual(["scent.refuse", "scent.refuse"]);
  });

  it("asks the user for an ask field, and logs the request", async () => {
    const { scope, entries } = await setup();
    const answer = await scope.request(shop);
    expect(answer.status).toBe("pending");
    const [pending] = await scope.pending();
    expect(pending).toMatchObject({ agent: shop.agent, purpose: shop.purpose, fields: [{ name: "demo.shopping.size.top", label: "Top size", sensitivity: "ask" }, { name: "demo.shopping.size.shoe", label: "Shoe size", sensitivity: "ask" }] });
    expect(pending?.digest).toMatch(/^[0-9a-f]{64}$/);
    const [entry] = await entries();
    expect(entry).toMatchObject({ actor: shop.agent, kind: "scent.request", data: { requestId: pending?.id, fields: shop.fields, purpose: shop.purpose } });
  });

  it("G17: a public field waits for the user, unless the scope grants public fields", async () => {
    const page = await setup();
    expect(await page.scope.request({ ...shop, fields: ["demo.profile.name"] })).toMatchObject({ status: "pending" });
    expect(page.notices).toHaveLength(0);
    const local = await setup({ grantPublic: true });
    const answer = await local.scope.request({ ...shop, fields: ["demo.profile.name"] });
    expect(answer).toMatchObject({ status: "granted", values: { "demo.profile.name": "Sam Fox" } });
    expect(local.notices).toHaveLength(1);
  });

  it("I6: gives the same id for the same waiting request", async () => {
    const { scope } = await setup();
    const a = await scope.request(shop);
    const b = await scope.request({ ...shop, fields: shop.fields.toReversed() });
    expect(b).toEqual(a);
    expect(await scope.pending()).toHaveLength(1);
    const c = await scope.request({ ...shop, purpose: "Something else" });
    expect(c).not.toEqual(a);
  });

  it("I7: limits a flood, logs only the first refusal, and keeps 30 times at most", async () => {
    const { scope, clock, kinds, store } = await setup();
    for (let i = 0; i < 30; i++) expect((await scope.request({ ...shop, fields: ["demo.nope"] })).status).toBe("denied");
    for (let i = 0; i < 100; i++) expect(await scope.request(shop)).toEqual(denied("rate-limited"));
    expect((await kinds()).length).toBe(31);
    expect(Object.values(parseState(await store.load()).rate).map((r) => r.times.length)).toEqual([30]);
    expect(await scope.request({ ...shop, agent: "other" })).toMatchObject({ status: "pending" });
    clock.advance(61);
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
  });

  it("I9: subdomains of one site share one limit, and other sites are not touched", async () => {
    const { scope, kinds } = await setup();
    for (let i = 0; i < 30; i++) expect((await scope.request({ ...shop, agent: `https://s${i}.evil.example`, fields: ["demo.nope"] })).status).toBe("denied");
    expect(await scope.request({ ...shop, agent: "https://new.evil.example" })).toEqual(denied("rate-limited"));
    expect(await scope.request({ ...shop, agent: "https://evil.example" })).toEqual(denied("rate-limited"));
    expect((await kinds()).length).toBe(31);
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
  });

  it("I9: the limit holds after a restart (a new scope on the same store)", async () => {
    const { scope, store, trail, clock } = await setup();
    for (let i = 0; i < 30; i++) await scope.request({ ...shop, fields: ["demo.nope"] });
    const again = createScope({ resolvers: [demoResolver()], store, trail, now: clock.now });
    expect(await again.request(shop)).toEqual(denied("rate-limited"));
    clock.advance(61);
    expect(await again.request(shop)).toMatchObject({ status: "pending" });
  });

  it("I9: one site cannot hold more than 3 waiting requests, so it cannot block the others", async () => {
    const { scope, kinds } = await setup();
    for (let i = 0; i < 3; i++) expect((await scope.request({ ...shop, agent: `https://s${i}.evil.example`, purpose: `p${i}` })).status).toBe("pending");
    expect(await scope.request({ ...shop, agent: "https://s9.evil.example", purpose: "p9" })).toEqual(denied("too-many-pending"));
    expect(await scope.request(shop)).toMatchObject({ status: "pending" });
    expect((await kinds()).filter((k) => k === "scent.refuse")).toHaveLength(1);
  });

  it("I8: refuses a 51st waiting request", async () => {
    const { scope } = await setup();
    for (let i = 0; i < 50; i++) expect((await scope.request({ ...shop, agent: `agent-${i}` })).status).toBe("pending");
    expect(await scope.request({ ...shop, agent: "agent-50" })).toEqual(denied("too-many-pending"));
  });

  it("P1: refuses a private field, also when a rule matches it", async () => {
    const { scope, kinds } = await setup({ rules: [{ agent: shop.agent, fields: "demo.**", maxTtlSeconds: 3600 }] });
    expect(await scope.request({ ...shop, fields: ["demo.travel.home", "demo.health.allergies"] })).toEqual(denied("private-field: demo.health.allergies"));
    expect(await scope.pending()).toEqual([]);
    expect(await kinds()).toEqual(["scent.refuse"]);
  });
});
