#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";

/** A yes/no question on the terminal; only "y" or "yes" is yes. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ...(process.stdin.isTTY ? { confirm } : {}),
});
