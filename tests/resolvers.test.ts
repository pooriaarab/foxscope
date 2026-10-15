// R1-R3, P3, P7 and P8 in docs/failure-modes.md: one scope's resolvers.
import { describe, expect, it } from "vitest";
import { demoResolver, type ScentResolver } from "../src/index.js";
import { resolverSet } from "../src/resolvers.js";

const fake = (namespace: string, read: ScentResolver["read"], list: ScentResolver["list"] = async () => [{ name: `${namespace}.a`, label: "A", sensitivity: "ask" }]): ScentResolver => ({ namespace, list, read });
const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: { code?: string; message: string }) => `${e.code}: ${e.message}`);

describe("resolverSet", () => {
  it("R1: refuses two resolvers with one namespace, or a resolver with no read", () => {
    expect(() => resolverSet([demoResolver(), demoResolver()])).toThrow(/two resolvers have the namespace "demo"/);
    expect(() => resolverSet([{ namespace: "x", list: async () => [] } as never])).toThrow(/namespace, list\(\) and read\(\)/);
  });

  it("describes fields, and names the first unknown or private one", async () => {
    const set = resolverSet([demoResolver()]);
    expect(await set.describe(["demo.shopping.budget"])).toEqual([{ name: "demo.shopping.budget", label: "Monthly clothes budget", sensitivity: "ask", derivable: true }]);
    expect(await set.describe(["demo.travel.home", "demo.nope"])).toBe("unknown-field: demo.nope");
    expect(await set.describe(["prefs.size"])).toBe("unknown-field: prefs.size");
    expect(await set.describe(["demo.health.allergies", "demo.travel.home"])).toBe("private-field: demo.health.allergies");
  });

  it("R2: a resolver that throws fails its own namespace only", async () => {
    const set = resolverSet([demoResolver(), fake("bad", () => Promise.reject(new Error("disk gone")), () => Promise.reject(new Error("down")))]);
    expect(await set.describe(["bad.a"])).toBe("resolver-failed: bad");
    expect(await set.describe(["demo.travel.home"])).toHaveLength(1);
    expect(await failure(set.resolve(["demo.travel.home", "bad.a"], false))).toBe("resolver-failed: the bad resolver failed: disk gone");
    expect((await set.fields()).map((f) => [f.namespace, f.fields.length, f.error])).toEqual([["demo", 7, undefined], ["bad", 0, "down"]]);
  });

  it("R3: a resolver that never answers fails after the timeout", async () => {
    const set = resolverSet([fake("x", () => new Promise(() => {}), () => new Promise(() => {}))], 30);
    expect(await set.describe(["x.a"])).toBe("resolver-failed: x");
    expect(await failure(set.resolve(["x.a"], false))).toBe("resolver-failed: the x resolver failed: the x resolver did not answer in 30 ms");
  });

  it("P3: drops keys nobody asked for, and refuses an answer that is not an object", async () => {
    const set = resolverSet([fake("x", async () => ({ "x.a": 1, "x.secret": 2, other: 3 })), fake("y", async () => "text" as never)]);
    expect(await set.resolve(["x.a"], false)).toEqual({ "x.a": 1 });
    expect(await failure(set.resolve(["y.a"], false))).toBe("resolver-failed: the y resolver did not return an object");
  });

  it("P7: passes derive to the resolver", async () => {
    const set = resolverSet([demoResolver()]);
    expect(await set.resolve(["demo.shopping.budget", "demo.profile.birthdate", "demo.travel.home"], true)).toEqual({ "demo.shopping.budget": "100-250 CAD", "demo.profile.birthdate": { over18: true }, "demo.travel.home": "Toronto" });
    expect(await set.resolve(["demo.shopping.budget"], false)).toEqual({ "demo.shopping.budget": "180 CAD" });
  });

  it("P8: refuses an answer over 256 KB", async () => {
    const set = resolverSet([fake("x", async () => ({ "x.a": "y".repeat(300_000) }))]);
    expect(await failure(set.resolve(["x.a"], false))).toBe("resolver-failed: the answer is over 256 KB");
  });
});
