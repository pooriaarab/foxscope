// foxscope/node: the file store under FOXSCOPE_HOME, and the resolvers of
// the optional peers foxprefs and foxpack.
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Log } from "foxtrail";
import { FileStore, loadOrCreateKeyFile } from "foxtrail/node";
import { demoResolver } from "./demo.js";
import { ScopeError } from "./errors.js";
import { createScope, type ScopeOptions } from "./scope.js";
import type { ScentResolver, ScopeStore } from "./types.js";

const STALE_LOCK_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FOXSCOPE_HOME, else ~/.foxscope. */
export const foxscopeHome = (env: Record<string, string | undefined> = process.env) => env.FOXSCOPE_HOME || join(homedir(), ".foxscope");

/** The state in one JSON file. Writes go through a temp file and a rename; a lock file orders processes. */
export function fileStore(path: string, o: { lockTimeoutMs?: number } = {}): ScopeStore {
  const lockPath = `${path}.lock`;
  return {
    name: path,
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new ScopeError("corrupt-store", `${path} is not JSON. foxscope does not overwrite it. Move it away to start again.`);
      }
    },
    async save(state) {
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    },
    async lock(fn) {
      const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
      const deadline = Date.now() + (o.lockTimeoutMs ?? 10_000);
      for (;;) {
        try {
          const handle = await open(lockPath, "wx", 0o600);
          await handle.writeFile(token);
          await handle.close();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        let age = 0;
        try {
          age = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue; // The holder just let go.
        }
        if (age > STALE_LOCK_MS) {
          // Move it away first, so two waiters cannot both delete a fresh lock.
          const moved = `${lockPath}.${token}.stale`;
          await rename(lockPath, moved).then(() => rm(moved, { force: true }), () => {});
          continue;
        }
        if (Date.now() > deadline) throw new ScopeError("store-busy", `${lockPath} is held by another foxscope process. Try again, or delete it if no foxscope runs.`);
        await sleep(20 + Math.random() * 30);
      }
      try {
        return await fn();
      } finally {
        if ((await readFile(lockPath, "utf8").catch(() => "")) === token) await rm(lockPath, { force: true });
      }
    },
  };
}

/** A scope with its state and its trail under home (default: FOXSCOPE_HOME, else ~/.foxscope). */
export async function openScope(o: Omit<ScopeOptions, "store" | "trail"> & { home?: string }) {
  const home = o.home ?? foxscopeHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = await loadOrCreateKeyFile(join(home, "trail.key"));
  const trail = new Log({ store: new FileStore(join(home, "trail.jsonl")), key });
  const scope = createScope({ ...o, store: fileStore(join(home, "state.json")), trail });
  return Object.freeze({ ...scope, home, trail });
}

const PEERS = [
  { name: "foxprefs", pkg: "foxprefs", factory: "prefsResolver" },
  // npm refused the unscoped name foxpack as too similar to fixpack.
  { name: "foxpack", pkg: "@pooriaarab/foxpack", factory: "memoryResolver" },
] as const;

export type PeerStatus = Record<(typeof PEERS)[number]["name"], "installed" | "not installed">;

/** The resolvers of foxprefs and foxpack when they are installed, plus the demo resolver when asked. */
export async function loadResolvers(o: { demo: boolean; importModule?: (name: string) => Promise<Record<string, unknown>> }): Promise<{ resolvers: ScentResolver[]; status: PeerStatus }> {
  const load = o.importModule ?? ((name: string) => import(name) as Promise<Record<string, unknown>>);
  const resolvers: ScentResolver[] = [];
  const status = {} as PeerStatus;
  for (const peer of PEERS) {
    let mod: Record<string, unknown>;
    try {
      mod = await load(peer.pkg);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      // Only "this package is missing" means not installed; a missing package inside it is an error.
      if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.includes(`'${peer.pkg}'`)) {
        status[peer.name] = "not installed";
        continue;
      }
      throw error;
    }
    const factory = mod[peer.factory];
    if (typeof factory !== "function") throw new Error(`${peer.name} is installed but has no ${peer.factory}() export. Update ${peer.name}.`);
    resolvers.push(await (factory as () => ScentResolver | Promise<ScentResolver>)());
    status[peer.name] = "installed";
  }
  if (o.demo) resolvers.push(demoResolver());
  return { resolvers, status };
}
