// X1 and X2 in docs/failure-modes.md: the release workflow. It is checked
// as text, job by job, because a release cannot run in a test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(".github/workflows/release.yml", "utf8");
const top = text.slice(0, text.indexOf("\njobs:"));
const jobs = Object.fromEntries(
  text
    .slice(text.indexOf("\njobs:") + 6)
    .split(/\n(?= {2}[\w-]+:\n)/)
    .filter((block) => block.trim())
    .map((block) => [/^\s*([\w-]+):/.exec(block)![1]!, block]),
);
const jobWith = (pattern: RegExp) => Object.keys(jobs).filter((name) => pattern.test(jobs[name]!));

describe("release.yml", () => {
  it("X1: runs the E2E on Ichabod, and publishes only after it passes", () => {
    const [e2e] = jobWith(/pnpm e2e/);
    expect(e2e).toBeDefined();
    expect(jobs[e2e!]).toMatch(/FOXKIT_BROWSER: ichabod/);
    expect(jobs[e2e!]).toMatch(/ICHABOD_API_KEY: \$\{\{ secrets\.ICHABOD_API_KEY \}\}/);
    const [npm] = jobWith(/npm publish/);
    expect(jobs[npm!]).toMatch(new RegExp(`needs: \\[[^\\]]*\\b${e2e}\\b`));
    const [amo] = jobWith(/web-ext sign/);
    expect(jobs[amo!]).toMatch(new RegExp(`needs: \\[?[^\\n]*\\b${npm}\\b`));
  });

  it("X2: gives each job only the permissions it needs; id-token only where npm publish runs", () => {
    expect(top).toMatch(/^permissions: \{\}$/m);
    expect(jobWith(/id-token: write/)).toEqual(jobWith(/npm publish/));
    expect(jobWith(/contents: write/)).toEqual(jobWith(/gh release create/));
    for (const block of Object.values(jobs)) expect(block).toMatch(/\n {4}permissions:\n/);
  });
});
