// A resolver with made-up values, for tests, the CLI --demo flag and the
// extension demo. Its namespace is "demo", so it never hides real prefs.
import type { ScentField, ScentResolver } from "./types.js";

const FIELDS: (ScentField & { value: unknown; smaller?: unknown })[] = [
  { name: "demo.profile.name", label: "Name", sensitivity: "public", value: "Sam Fox" },
  { name: "demo.shopping.size.top", label: "Top size", sensitivity: "ask", value: "M" },
  { name: "demo.shopping.size.shoe", label: "Shoe size", sensitivity: "ask", value: "42 EU" },
  { name: "demo.shopping.budget", label: "Monthly clothes budget", sensitivity: "ask", derivable: true, value: "180 CAD", smaller: "100-250 CAD" },
  { name: "demo.profile.birthdate", label: "Birth date", sensitivity: "ask", derivable: true, value: "1990-04-02", smaller: { over18: true } },
  { name: "demo.travel.home", label: "Home city", sensitivity: "ask", value: "Toronto" },
  { name: "demo.health.allergies", label: "Allergies", sensitivity: "private", value: "peanuts" },
];

export function demoResolver(): ScentResolver {
  return {
    namespace: "demo",
    list: async () => FIELDS.map(({ value: _v, smaller: _s, ...field }) => field),
    read: async (fields, { derive }) => {
      const out: Record<string, unknown> = {};
      for (const f of FIELDS) if (fields.includes(f.name)) out[f.name] = derive && f.derivable ? f.smaller : f.value;
      return out;
    },
  };
}
