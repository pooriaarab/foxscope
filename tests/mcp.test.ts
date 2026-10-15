// M1-M4, P6 and G4 in docs/failure-modes.md: the MCP tools, with a real MCP
// client over the SDK's in-memory transport.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { setup } from "./helpers.js";

type Text = { type: "text"; text: string };

async function connect(scope: Awaited<ReturnType<typeof setup>>["scope"], name: string) {
  const server = createMcpServer({ scope, approveCommand: "foxscope --demo approve" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    return { isError: result.isError === true, text: (result.content as Text[]).map((c) => c.text).join("\n") };
  };
}

describe("MCP server", () => {
  it("lists the five tools", async () => {
    const { scope } = await setup();
    const server = createMcpServer({ scope, approveCommand: "foxscope approve" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(["scent_list_fields", "scent_list_grants", "scent_read", "scent_request", "scent_revoke"]);
  });

  it("P6: lists fields without the private ones", async () => {
    const { scope } = await setup();
    const call = await connect(scope, "agent");
    const { text } = await call("scent_list_fields");
    expect(JSON.parse(text).map((f: { name: string }) => f.name)).toEqual(["demo.profile.name", "demo.shopping.size.top", "demo.shopping.size.shoe", "demo.shopping.budget", "demo.profile.birthdate", "demo.travel.home"]);
  });

  it("M3: a waiting request names the exact command, and asking again after the approval gives the values", async () => {
    const { scope } = await setup();
    const call = await connect(scope, "claude-code");
    const args = { fields: ["demo.travel.home"], purpose: "Plan a trip", ttlSeconds: 600 };
    const first = await call("scent_request", args);
    const requestId = /(r-[0-9a-f]+)/.exec(first.text)?.[1];
    expect(first.text).toContain(`foxscope --demo approve ${requestId}`);
    const [pending] = await scope.pending();
    expect(pending).toMatchObject({ agent: "claude-code", purpose: "Plan a trip" });
    await scope.approve(requestId!);
    const again = await call("scent_request", args);
    expect(again.isError).toBe(false);
    expect(again.text).toContain('"demo.travel.home": "Toronto"');
    const grantId = /(g-[0-9a-f]+)/.exec(again.text)?.[1];
    expect(JSON.parse((await call("scent_read", { grantId })).text)).toEqual({ "demo.travel.home": "Toronto" });
    expect(JSON.parse((await call("scent_list_grants")).text).map((g: { id: string }) => g.id)).toEqual([grantId]);
    expect((await call("scent_revoke", { grantId })).text).toContain("Revoked");
    expect(await call("scent_read", { grantId })).toMatchObject({ isError: true, text: expect.stringContaining("revoked") });
  });

  it("a refusal is an error result with the reason", async () => {
    const { scope } = await setup();
    const call = await connect(scope, "agent");
    expect(await call("scent_request", { fields: ["demo.health.allergies"], purpose: "p" })).toEqual({ isError: true, text: "foxscope denied the request: private-field: demo.health.allergies" });
  });

  it("M2, G4: an agent cannot read, list or revoke another agent's grant", async () => {
    const { scope } = await setup({ rules: [{ agent: "owner", fields: "demo.travel.*", maxTtlSeconds: 60 }] });
    const owner = await connect(scope, "owner");
    const grantId = /(g-[0-9a-f]+)/.exec((await owner("scent_request", { fields: ["demo.travel.home"], purpose: "p" })).text)?.[1];
    const thief = await connect(scope, "thief");
    expect(await thief("scent_read", { grantId })).toMatchObject({ isError: true, text: expect.stringContaining("no-grant") });
    expect(await thief("scent_revoke", { grantId })).toMatchObject({ isError: true, text: expect.stringContaining("no-grant") });
    expect((await thief("scent_list_grants")).text).toBe("[]");
    expect((await owner("scent_read", { grantId })).isError).toBe(false);
  });

  it("M4: the name is what the client says; a second client that claims it gets its grants, and the user is told", async () => {
    const { scope } = await setup({ rules: [{ agent: "claude-code", fields: "demo.travel.*", maxTtlSeconds: 60 }] });
    const real = await connect(scope, "claude-code");
    const grantId = /(g-[0-9a-f]+)/.exec((await real("scent_request", { fields: ["demo.travel.home"], purpose: "p" })).text)?.[1];
    const impostor = await connect(scope, "claude-code");
    expect(await impostor("scent_read", { grantId })).toMatchObject({ isError: false, text: expect.stringContaining("Toronto") });
    const waiting = await impostor("scent_request", { fields: ["demo.shopping.size.top"], purpose: "Fit" });
    expect(waiting.text).toContain('This agent calls itself "claude-code". foxscope cannot check that name');
  });

  it("M1: refuses a client with no name", async () => {
    const { scope } = await setup();
    const call = await connect(scope, "  ");
    expect(await call("scent_list_grants")).toMatchObject({ isError: true, text: expect.stringContaining("no client name") });
  });
});
