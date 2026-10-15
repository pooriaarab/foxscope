// E7 and R5 in docs/failure-modes.md, for the extension: foxprefs and foxpack over runtime.sendMessage.
import { describe, expect, it } from "vitest";
import { messageResolver, type SendMessage } from "../src/index.js";
import { resolverSet } from "../src/resolvers.js";

const absent: SendMessage = () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
const fields = [{ name: "prefs.shopping.size.top", label: "Top size", sensitivity: "ask" }];

describe("messageResolver", () => {
  it("sends scent.list and scent.read to the extension id", async () => {
    const sent: [string, unknown][] = [];
    const send: SendMessage = async (id, msg) => {
      sent.push([id, msg]);
      return (msg as { type: string }).type === "scent.list" ? fields : { "prefs.shopping.size.top": "M" };
    };
    const set = resolverSet([messageResolver({ namespace: "prefs", extensionId: "foxprefs@pooriaarab", send })]);
    expect(await set.describe(["prefs.shopping.size.top"])).toEqual(fields);
    expect(await set.resolve(["prefs.shopping.size.top"], true)).toEqual({ "prefs.shopping.size.top": "M" });
    expect(sent).toEqual([
      ["foxprefs@pooriaarab", { type: "scent.list" }],
      ["foxprefs@pooriaarab", { type: "scent.read", fields: ["prefs.shopping.size.top"], derive: true }],
    ]);
  });

  it("R5: says not installed when the message fails", async () => {
    const set = resolverSet([messageResolver({ namespace: "prefs", extensionId: "foxprefs@pooriaarab", send: absent })]);
    const [status] = await set.fields();
    expect(status?.error).toBe("foxprefs@pooriaarab is not installed or does not answer (Could not establish connection. Receiving end does not exist.)");
    expect(await set.describe(["prefs.shopping.size.top"])).toBe("resolver-failed: prefs");
  });

  it("E7: refuses an answer in the wrong shape", async () => {
    for (const answer of [undefined, { fields }, [{ name: "prefs.x" }]]) {
      const set = resolverSet([messageResolver({ namespace: "prefs", extensionId: "x", send: async () => answer })]);
      expect(await set.describe(["prefs.shopping.size.top"])).toBe("resolver-failed: prefs");
    }
    const set = resolverSet([messageResolver({ namespace: "prefs", extensionId: "x", send: async (_id, m) => ((m as { type: string }).type === "scent.list" ? fields : "M") })]);
    await expect(set.resolve(["prefs.shopping.size.top"], false)).rejects.toMatchObject({ code: "resolver-failed" });
  });
});
