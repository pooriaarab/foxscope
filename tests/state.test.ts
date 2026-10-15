// S1 in docs/failure-modes.md, for every store: a stored state in the wrong shape.
import { describe, expect, it } from "vitest";
import { emptyState, parseState, storageAreaStore } from "../src/index.js";

describe("parseState", () => {
  it("gives an empty state when nothing is stored", () => {
    expect(parseState(undefined)).toEqual(emptyState());
  });

  it("S1: refuses a state in the wrong shape or version", () => {
    for (const bad of ["text", 5, {}, { ...emptyState(), version: 2 }, { ...emptyState(), grants: "x" }, { ...emptyState(), rules: [{ id: "r" }] }, { ...emptyState(), lastNow: Number.NaN }]) {
      expect(() => parseState(bad, "state.json")).toThrow(/state.json does not hold a foxscope state/);
    }
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
