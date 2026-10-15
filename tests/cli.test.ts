// C1-C5 in docs/failure-modes.md: the foxscope command.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const missing = (name: string) => Promise.reject(Object.assign(new Error(`Cannot find package '${name}' imported from x`), { code: "ERR_MODULE_NOT_FOUND" }));

/** The CLI on one FOXSCOPE_HOME. `answers` play a person at a terminal; without them stdin is not a terminal. */
function cli(answers?: boolean[]) {
  const env = { FOXSCOPE_HOME: mkdtempSync(join(tmpdir(), "fsc-cli-")) };
  return async (...argv: string[]) => {
    let out = "";
    let err = "";
    const asked: string[] = [];
    const confirm = answers && (async (question: string) => (asked.push(question), answers.shift() ?? false));
    const code = await runCli(argv, { env, stdout: (s) => void (out += s), stderr: (s) => void (err += s), importModule: missing, ...(confirm ? { confirm } : {}) });
    return { code, out, err, asked };
  };
}

/** approve printed the whole request first. */
function shown(out: string) {
  expect(out).toMatch(/shop-agent .*600 s/);
  expect(out).toContain('Purpose: "Pick clothes"');
  expect(out).toContain("demo.shopping.size.top (Top size, ask)");
  expect(out).toMatch(/Digest: [0-9a-f]{12}/);
}

const digestOf = (out: string) => /Digest: ([0-9a-f]{12})/.exec(out)?.[1];

describe("foxscope CLI", () => {
  it("C1: usage and exit 2 for a bad command or a missing argument", async () => {
    const run = cli();
    for (const argv of [[], ["nope"], ["approve"], ["rules", "add", "agent"], ["request", "a", "demo.x"], ["revoke"], ["approve", "r-1", "--ttl", "soon"], ["grants", "--bogus"]]) {
      const r = await run(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toMatch(/Usage: foxscope/);
    }
    expect((await run("--help")).code).toBe(0);
  });

  it("C3: runs the whole flow and shows what is approved", async () => {
    const run = cli();
    const asked = await run("--demo", "request", "shop-agent", "demo.shopping.size.top", "demo.shopping.budget", "--purpose", "Pick clothes", "--ttl", "600");
    expect(asked.code).toBe(0);
    const id = /pending (r-[0-9a-f]+)/.exec(asked.out)?.[1];
    expect(asked.out).toContain(`foxscope --demo approve ${id}`);
    const pending = await run("pending");
    expect(pending.out).toContain(id);
    expect(pending.out).toMatch(/shop-agent .*Pick clothes/s);
    expect(pending.out).toContain("demo.shopping.budget (Monthly clothes budget, ask, has a smaller answer)");
    const digest = digestOf(pending.out);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    const approved = await run("--demo", "approve", id!, "--derive", "--yes", "--digest", digest!);
    expect(approved.code).toBe(0);
    expect(approved.out).toMatch(/Approved for shop-agent: demo.shopping.size.top, demo.shopping.budget \(smaller answers\)/);
    expect(approved.out).toContain('Purpose: "Pick clothes"');
    const grantId = /grant (g-[0-9a-f]+)/.exec(approved.out)?.[1];
    const read = await run("--demo", "read", grantId!);
    expect(JSON.parse(read.out)).toEqual({ "demo.shopping.size.top": "M", "demo.shopping.budget": "100-250 CAD" });
    expect(read.err).toContain("notice: shop-agent read demo.shopping.size.top, demo.shopping.budget");
    expect((await run("grants")).out).toContain(grantId);
    expect((await run("revoke", grantId!)).code).toBe(0);
    expect((await run("grants")).out).toBe("No live grants.\n");
    const trail = await run("trail", "--verify");
    expect(trail.out).toMatch(/scent.request.*scent.grant.*scent.read.*scent.revoke/s);
    expect(trail.out).toMatch(/Trail OK: 4 entries/);
  });

  it("C4: approve shows the whole request and asks first; no answer, no grant", async () => {
    const asked = async (run: ReturnType<typeof cli>) => /pending (r-[0-9a-f]+)/.exec((await run("--demo", "request", "shop-agent", "demo.shopping.size.top", "--purpose", "Pick clothes", "--ttl", "600")).out)![1]!;
    const no = cli([false]);
    const r1 = await asked(no);
    const refused = await no("--demo", "approve", r1);
    shown(refused.out);
    expect(refused.asked).toEqual(["Approve this request? [y/N] "]);
    expect(refused.code).toBe(1);
    expect((await no("grants")).out).toBe("No live grants.\n");

    const yes = cli([true]);
    const r2 = await asked(yes);
    const approved = await yes("--demo", "approve", r2);
    shown(approved.out);
    expect(approved).toMatchObject({ code: 0, out: expect.stringContaining("Approved for shop-agent") });

    const script = cli();
    const r3 = await asked(script);
    const blind = await script("--demo", "approve", r3);
    shown(blind.out);
    expect(blind.code).toBe(1);
    expect(blind.err).toMatch(/Not approved. Check the request above, then run: foxscope --demo approve r-[0-9a-f]+ --yes --digest [0-9a-f]{12}/);
    expect((await script("--demo", "approve", r3, "--yes")).code).toBe(2);
    expect(await script("--demo", "approve", r3, "--yes", "--digest", "000000000000")).toMatchObject({ code: 1, err: expect.stringContaining("request-changed") });
    expect((await script("--demo", "approve", r3, "--yes", "--digest", "abc")).code).toBe(2);
    expect((await script("grants")).out).toBe("No live grants.\n");
    const digest = digestOf(blind.out)!;
    expect((await script("--demo", "approve", r3, "--yes", "--digest", digest)).code).toBe(0);
  });

  it("C5: shows bidi and invisible characters in the agent and the purpose as escapes", async () => {
    const run = cli();
    const agent = "shop\u202Etnega";
    const asked = await run("--demo", "request", agent, "demo.shopping.size.top", "--purpose", "Pick\u200B clothes\u2066");
    const id = /pending (r-[0-9a-f]+)/.exec(asked.out)![1]!;
    const listed = await run("--demo", "pending");
    const blind = await run("--demo", "approve", id);
    const approved = await run("--demo", "approve", id, "--yes", "--digest", digestOf(blind.out)!);
    const grants = await run("grants");
    const revoked = await run("revoke", "--agent", agent);
    for (const out of [listed.out, blind.out, approved.out, grants.out, revoked.out]) {
      expect(out).not.toMatch(/[\u200B\u202E\u2066]/);
      expect(out).toContain("shop\\u{202e}tnega");
    }
    expect(approved.out).toContain("Purpose: \"Pick\\u{200b} clothes\\u{2066}\"");
  });

  it("adds, lists and removes standing rules, and revokes an agent", async () => {
    const run = cli();
    const added = await run("rules", "add", "shop-agent", "demo.shopping.**", "--ttl", "3600");
    const ruleId = /rule (rule-[0-9a-f]+)/.exec(added.out)?.[1];
    expect((await run("rules", "list")).out).toMatch(/shop-agent demo.shopping.\*\* up to 3600 s/);
    const granted = await run("--demo", "request", "shop-agent", "demo.shopping.size.top", "--purpose", "Fit");
    expect(granted.out).toMatch(/^granted g-/);
    expect(granted.out).toContain('"demo.shopping.size.top": "M"');
    expect((await run("revoke", "--agent", "shop-agent")).out).toBe("Revoked shop-agent: 1 grants, 0 waiting requests, 1 rules.\n");
    expect((await run("rules", "list")).out).toBe("No rules.\n");
    expect((await run("rules", "remove", ruleId!)).code).toBe(1);
  });

  it("C2: a failure prints the code and exits 1", async () => {
    const run = cli();
    expect(await run("approve", "r-nothing")).toMatchObject({ code: 1, err: "foxscope: not-found: no waiting request r-nothing\n" });
    const denied = await run("--demo", "request", "a", "demo.health.allergies", "--purpose", "p");
    expect(denied).toMatchObject({ code: 1, err: "foxscope: denied: private-field: demo.health.allergies\n" });
  });

  it("G17: the CLI, a local agent, gets public fields without asking", async () => {
    const run = cli();
    const granted = await run("--demo", "request", "a", "demo.profile.name", "--purpose", "Say hello");
    expect(granted.out).toMatch(/^granted g-/);
  });

  it("R5: lists the fields and says which resolvers are missing", async () => {
    const run = cli();
    const plain = await run("fields");
    expect(plain.out).toBe("foxprefs: not installed\nfoxpack: not installed\nNo fields. Install foxprefs or foxpack, or pass --demo.\n");
    const demo = await run("--demo", "fields");
    expect(demo.out).toContain("demo.health.allergies  Allergies  private");
  });
});
