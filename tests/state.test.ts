// S1 in docs/failure-modes.md, for every store: a stored state in the wrong shape.
import { describe, expect, it } from "vitest";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { createScope, demoResolver, emptyState, memoryStore, parseState, storageAreaStore, type ScopeState } from "../src/index.js";

const AT = "2026-10-15T12:00:00.000Z";
const good = (): ScopeState => ({
  version: 1,
  lastNow: Date.parse(AT),
  rules: [{ id: "rule-1", agent: "a", fields: "demo.**", maxTtlSeconds: 60, derive: false, source: "user", createdAt: AT }],
  grants: [{ id: "g-1", agent: "a", fields: ["demo.travel.home"], purpose: "p", derive: false, via: "user", ruleIds: [], createdAt: AT, expiresAt: "2026-10-15T13:00:00.000Z" }],
  rate: { "shop.example": { times: [Date.parse(AT)], refusedAt: Date.parse(AT) } },
  requests: [{ id: "r-1", agent: "a", fields: [{ name: "demo.travel.home", label: "Home city", sensitivity: "ask" }], purpose: "p", digest: "0".repeat(64), createdAt: AT, expiresAt: "2026-10-15T12:10:00.000Z" }],
});

describe("parseState", () => {
  it("gives an empty state when nothing is stored", () => {
    expect(parseState(undefined)).toEqual(emptyState());
  });

  it("S1: refuses a state in the wrong shape or version", () => {
    for (const bad of ["text", 5, {}, { ...emptyState(), version: 2 }, { ...emptyState(), grants: "x" }, { ...emptyState(), rules: [{ id: "r" }] }, { ...emptyState(), lastNow: Number.NaN }]) {
      expect(() => parseState(bad, "state.json")).toThrow(/state.json does not hold a foxscope state/);
    }
  });

  it("S7: refuses a date that is not an exact ISO time, and every other bad field", () => {
    expect(parseState(good())).toEqual(good());
    const bad: ((s: ScopeState) => void)[] = [
      (s) => void (s.grants[0]!.expiresAt = "garbage"),
      (s) => void (s.grants[0]!.expiresAt = "2026-10-15"),
      (s) => void (s.grants[0]!.createdAt = "2026-13-40T00:00:00.000Z"),
      (s) => void (s.grants[0]!.revokedAt = "soon"),
      (s) => void (s.grants[0]!.purpose = 5 as never),
      (s) => void (s.grants[0]!.via = "anyone" as never),
      (s) => void (s.grants[0]!.fields = [5] as never),
      (s) => void (s.grants[0]!.ruleIds = "rule-1" as never),
      (s) => void (s.grants[0]!.derive = "yes" as never),
      (s) => void (s.rules[0]!.createdAt = ""),
      (s) => void (s.rules[0]!.maxTtlSeconds = Number.NaN),
      (s) => void (s.rules[0]!.source = "web" as never),
      (s) => void (s.requests[0]!.expiresAt = "garbage"),
      (s) => void (s.requests[0]!.ttlSeconds = 1.5),
      (s) => void (s.requests[0]!.fields = [{ name: "x" }] as never),
      (s) => void (s.rate = [] as never),
      (s) => void (s.rate["shop.example"] = [Date.parse(AT)] as never),
      (s) => void (s.rate["shop.example"]!.times = ["soon"] as never),
      (s) => void (s.rate["shop.example"]!.refusedAt = "soon" as never),
    ];
    for (const change of bad) {
      const s = good();
      change(s);
      expect(() => parseState(s, "state.json"), change.toString()).toThrow(/state.json does not hold a foxscope state/);
    }
  });

  it("S7: a grant with a bad expiresAt fails the read loudly, and gives no value", async () => {
    const state = good();
    state.grants[0]!.expiresAt = "garbage";
    const scope = createScope({ resolvers: [demoResolver()], store: memoryStore(state), trail: new Log({ store: new MemoryStore(), key: await generateKey() }), now: () => Date.parse(AT) });
    await expect(scope.read("g-1")).rejects.toMatchObject({ code: "corrupt-store" });
    await expect(scope.list()).rejects.toMatchObject({ code: "corrupt-store" });
  });

  it("keeps the state in one key of a storage area", async () => {
    const data: Record<string, unknown> = {};
    const area = { get: async (k: string) => ({ [k]: data[k] }), set: async (items: Record<string, unknown>) => void Object.assign(data, items) };
    const store = storageAreaStore(area);
    expect(await store.load()).toBeUndefined();
    await store.save({ ...emptyState(), lastNow: 5 });
    expect(Object.keys(data)).toEqual(["fsc:state"]);
    expect(parseState(await store.load()).lastNow).toBe(5);
  });
});
