// I1-I4, I9, G11, P4 and R4 in docs/failure-modes.md: the checks on what an
// agent sends, on rule globs, and on the field list a resolver returns.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isFieldGlob, matchGlob, parseRequest, siteOf } from "../src/index.js";
import { parseFieldList, visible } from "../src/fields.js";

const ok = { agent: "https://shop.example", fields: ["demo.shopping.size.top"], purpose: "Pick a size" };
const problem = (input: unknown) => {
  const r = parseRequest(input);
  return typeof r === "string" ? r : "ok";
};

describe("parseRequest", () => {
  it("passes a good request and copies it", () => {
    const fields = ["demo.a"];
    const r = parseRequest({ ...ok, fields, ttlSeconds: 60, extra: "dropped" });
    expect(r).toEqual({ ...ok, fields, ttlSeconds: 60 });
    fields.push("demo.b");
    expect(typeof r === "object" && r.fields).toEqual(["demo.a"]);
  });

  it("I1: refuses a bad agent", () => {
    for (const agent of [undefined, "", "  ", "a".repeat(201), "bad\u0007agent", "line\nbreak", 7]) expect(problem({ ...ok, agent })).toMatch(/^agent/);
    for (const input of [null, "text", [], 5]) expect(problem(input)).toBe("the request must be an object");
  });

  it("I2: refuses bad field lists", () => {
    const many = Array.from({ length: 51 }, (_, i) => `demo.f${i}`);
    for (const fields of [undefined, "demo.travel.home", [], many, ["demo.a", "demo.a"], ["nodot"], ["demo..x"], ["Demo.x"], ["demo.x y"], [3], [null]]) {
      expect(problem({ ...ok, fields })).toMatch(/^fields/);
    }
    expect(problem({ ...ok, fields: many.slice(0, 50) })).toBe("ok");
  });

  it("I3: refuses a bad purpose", () => {
    for (const purpose of [undefined, "", "   ", "x".repeat(501), 5]) expect(problem({ ...ok, purpose })).toMatch(/^purpose/);
  });

  it("I4: refuses a bad time limit", () => {
    for (const ttlSeconds of [0, -5, 1.5, "60", null, 30 * 24 * 3600 + 1]) expect(problem({ ...ok, ttlSeconds })).toMatch(/^ttlSeconds/);
    expect(problem({ ...ok, ttlSeconds: 30 * 24 * 3600 })).toBe("ok");
  });
});

describe("rule globs", () => {
  it("matches one segment with * and the rest with a final **", () => {
    expect(matchGlob("demo.shopping.*", "demo.shopping.budget")).toBe(true);
    expect(matchGlob("demo.shopping.*", "demo.shopping.size.top")).toBe(false);
    expect(matchGlob("demo.shopping.**", "demo.shopping.size.top")).toBe(true);
    expect(matchGlob("demo.shopping.**", "demo.shopping")).toBe(false);
    expect(matchGlob("demo.travel.home", "demo.travel.home")).toBe(true);
    expect(matchGlob("demo.travel", "demo.travel.home")).toBe(false);
    expect(matchGlob("demo.*.top", "demo.size.top")).toBe(true);
  });

  it("G11: refuses a glob with no fixed namespace", () => {
    for (const glob of ["**", "*.shopping", "demo", "demo.**.x", "demo..x", "Demo.x", "", 3]) expect(isFieldGlob(glob)).toBe(false);
    for (const glob of ["demo.*", "demo.**", "prefs.shopping.size.*"]) expect(isFieldGlob(glob)).toBe(true);
  });
});

describe("parseFieldList", () => {
  it("R4: refuses a list in the wrong shape", () => {
    for (const list of ["nope", null, [{ name: "x.a" }], [{ name: "x.a", label: "A", sensitivity: "secret" }], [{ name: "x", label: "A", sensitivity: "ask" }], [{ name: "x.a", label: "A", sensitivity: "ask", derivable: "yes" }]]) {
      expect(() => parseFieldList("x", list)).toThrow();
    }
  });

  it("P4: drops fields outside the resolver's namespace", () => {
    const list = [{ name: "x.a", label: "A", sensitivity: "ask", derivable: true }, { name: "demo.health.allergies", label: "Allergies", sensitivity: "public" }];
    expect(parseFieldList("x", list)).toEqual([{ name: "x.a", label: "A", sensitivity: "ask", derivable: true }]);
  });
});

describe("siteOf", () => {
  it("I9: groups a page origin by its registrable domain, and keeps other agents as they are", () => {
    const cases: [string, string][] = [
      ["https://shop.example", "shop.example"],
      ["https://a.b.evil.example", "evil.example"],
      ["http://evil.example:8080", "evil.example"],
      ["https://x.shop.co.uk", "shop.co.uk"],
      ["https://evil.co.uk", "evil.co.uk"],
      ["https://a.b.example.com.au", "example.com.au"],
      ["https://user.github.io", "github.io"],
      ["https://a.evil.com.", "evil.com"],
      ["https://x.shop.co.uk.", "shop.co.uk"],
      ["http://localhost.:3000", "localhost"],
      ["http://127.0.0.1:5173", "127.0.0.1"],
      ["http://localhost:3000", "localhost"],
      ["http://[::1]:8080", "[::1]"],
      ["claude-code", "claude-code"],
      ["unknown", "unknown"],
    ];
    expect(cases.map(([agent]) => siteOf(agent))).toEqual(cases.map(([, site]) => site));
  });
});

describe("visible", () => {
  it("C5: escapes control, format, line and paragraph separator, filler and tag characters, and keeps other text", () => {
    const hidden = ["\u0000", "\u001B", "\u007F", "\u009F", "\u00AD", "\u061C", "\u200B", "\u200F", "\u202E", "\u2028", "\u2029", "\u2066", "\u3164", "\uFEFF", "\uFFA0", "\u{E0000}", "\u{E0001}", "\u{E0041}", "\u{E007F}"];
    for (const c of hidden) expect(visible(`a${c}b`)).toBe(`a\\u{${c.codePointAt(0)!.toString(16)}}b`);
    expect(visible("Größe 42 € 日本 🦊")).toBe("Größe 42 € 日本 🦊");
  });

  it("C5: the approval page uses it", () => {
    expect(readFileSync("extension/approve.js", "utf8")).toMatch(/import \{[^}]*\bvisible\b[^}]*\} from "\.\.\/src\/fields\.ts"/);
  });
});
