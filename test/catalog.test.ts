import assert from "node:assert/strict";
import test from "node:test";
import { cleanName, fetchCatalog, parseCatalog } from "../src/catalog.ts";

export const row = {
  name: "Claude Fable 5 (2)", id: "not-the-api-id",
  nexos_model_id: "47498907-0d90-4ab0-9d23-203591d2dad7",
  owned_by: "Google Agent Platform", region: "US", endpoints: ["chat_completion", "responses"],
  context_length: 872000, max_tokens: 128000,
  pricing: { input_cost_per_token: "0.000011", output_cost_per_token: "0.000055", cache_read_cost_per_token: "0.0000011" },
};
const payload = (...data: unknown[]) => ({ data });

test("maps Nexos identifiers, names, endpoints, limits and per-token prices", () => {
  const [model] = parseCatalog(payload(row));
  assert.equal(model.id, "claude-fable-5/us");
  assert.equal(model.name, "Claude Fable 5 · Google Agent Platform · US");
  assert.equal(model.samplingParams?.model, row.nexos_model_id);
  assert.equal(model.contextWindow, 872000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.cost, { input: 11, output: 55, cacheRead: 1.1, cacheWrite: 0 });
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, false);
  assert.equal(model.api, "openai-completions");
  assert.equal(parseCatalog(payload(row), "responses")[0].api, "openai-responses");
  assert.equal(parseCatalog(payload({ ...row, endpoints: ["responses"] }))[0].api, "openai-responses");
  assert.equal(parseCatalog(payload({ ...row, endpoints: ["chat_completion"] }), "responses")[0].api, "openai-completions");
});

test("only strips numbered suffixes and sanitizes terminal metadata", () => {
  assert.equal(cleanName("Model (Thinking)"), "Model (Thinking)");
  assert.equal(cleanName("Model (Thinking) (12)"), "Model (Thinking)");
  assert.equal(cleanName("A\u001b\n\u009bB"), "AB");
});

test("non-chat models are excluded, malformed/partial catalogs rejected", () => {
  assert.deepEqual(parseCatalog(payload(...["embeddings", "image_generation", "speech_generation", "systemone"].map(e => ({ ...row, endpoints: [e] })))), []);
  for (const value of [null, [], {}, { data: {} }]) assert.throws(() => parseCatalog(value), /invalid model catalog/);
  assert.throws(() => parseCatalog({ data: [row], total: 3 }), /partial catalog/);
  assert.throws(() => parseCatalog(payload({ ...row, nexos_model_id: undefined, id: undefined })), /nexos_model_id or id/);
});

test("accepts opaque Nexos routing IDs and prefers them over id (#1)", () => {
  for (const wireId of ["auto-code", "GPT 4.1 mini", "vendor/model:custom#100%", "モデル"]) {
    const [model] = parseCatalog(payload({ ...row, nexos_model_id: wireId, id: "different-route" }));
    assert.equal(model.samplingParams?.model, wireId);
  }
});

test("falls back to id, never to the display name", () => {
  for (const nexos_model_id of [undefined, null, "", "   ", 42, "bad\nid"]) {
    const [model] = parseCatalog(payload({ ...row, nexos_model_id, id: "auto-code", name: "Friendly Auto Code" }));
    assert.equal(model.samplingParams?.model, "auto-code");
    assert.equal(model.id, "friendly-auto-code/us");
  }
  assert.throws(() => parseCatalog(payload({ ...row, nexos_model_id: null, id: null, name: "auto-code" })), /nexos_model_id or id/);
});

test("opaque routing IDs get safe deterministic collision suffixes", () => {
  const models = parseCatalog(payload(
    { ...row, nexos_model_id: "vendor/model:one#100%" },
    { ...row, nexos_model_id: "vendor/model:two#100%" },
  ));
  assert.equal(new Set(models.map(m => m.id)).size, 2);
  assert.ok(models.every(m => /^claude-fable-5\/google-agent-platform\/us~[0-9a-f]{8}$/.test(m.id)));
  assert.deepEqual(models, parseCatalog(payload(
    { ...row, nexos_model_id: "vendor/model:two#100%" },
    { ...row, nexos_model_id: "vendor/model:one#100%" },
  )));
});

test("one unusable routing ID does not block the rest of the catalog (#1)", () => {
  const warnings: string[] = [];
  const invalid = [undefined, null, "", "   ", 42, {}, "\u0000", "bad\nid", row.nexos_model_id.replace("-", "\u001b-")];
  const models = parseCatalog(payload(
    ...invalid.map(nexos_model_id => ({ ...row, nexos_model_id, id: undefined })),
    row,
  ), "auto", message => warnings.push(message));
  assert.deepEqual(models, parseCatalog(payload(row)));
  assert.deepEqual(warnings, ["Skipped 9 Nexos chat model(s) without a usable nexos_model_id or id; loaded 1 usable model(s)."]);
  assert.ok(!warnings[0].includes(row.nexos_model_id));
});

test("an entirely unusable chat catalog reports a format error, not an auth error", () => {
  assert.throws(() => parseCatalog(payload({ ...row, nexos_model_id: null, id: undefined })), /catalog-format problem, not an API-key rejection/);
  assert.deepEqual(parseCatalog(payload()), []);
  assert.deepEqual(parseCatalog(payload({ ...row, endpoints: ["embeddings"], nexos_model_id: null })), []);
});

test("authenticated discovery returns usable models and warns once for skipped entries", async () => {
  const warnings: string[] = [];
  const models = await fetchCatalog("secret", new AbortController().signal, "auto", async () => Response.json(payload(
    row, { ...row, nexos_model_id: null, id: undefined },
  )), message => warnings.push(message));
  assert.deepEqual(models, parseCatalog(payload(row)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 1/);
});

test("includes the host only where model and region are ambiguous", () => {
  const models = parseCatalog(payload(
    row,
    { ...row, region: "EU", nexos_model_id: "12345678-1234-1234-1234-123456789abc" },
    { ...row, owned_by: "Bedrock", nexos_model_id: "87654321-1234-1234-1234-123456789abc" },
  ));
  assert.equal(models.length, 3);
  assert.equal(new Set(models.map(m => m.id)).size, 3);
  assert.deepEqual(models.map(m => m.id), [
    "claude-fable-5/bedrock/us",
    "claude-fable-5/eu",
    "claude-fable-5/google-agent-platform/us",
  ]);
});

test("different regions need neither host nor UUID, even with different hosts", () => {
  const eu = { ...row, name: "GLM 5.3 Flash (1)", owned_by: "Lyceum", region: "EU" };
  const other = { ...eu, name: "GLM 5.3 Flash", owned_by: "Fireworks AI", region: "OTHER", nexos_model_id: "12345678-1234-1234-1234-123456789abc" };
  const models = parseCatalog(payload(eu, other));
  assert.deepEqual(models.map(m => m.id), ["glm-5.3-flash/eu", "glm-5.3-flash/other"]);
  assert.equal(models[0].name, "GLM 5.3 Flash · Lyceum · EU");
  assert.equal(models[0].samplingParams?.model, eu.nexos_model_id);
});

test("only colliding aliases receive deterministic UUID suffixes", () => {
  const other = { ...row, nexos_model_id: "12345678-1234-1234-1234-123456789abc" };
  const unique = { ...row, region: "EU", nexos_model_id: "87654321-1234-1234-1234-123456789abc" };
  const models = parseCatalog(payload(row, other, unique));
  assert.deepEqual(models.map(m => m.id), [
    "claude-fable-5/eu",
    "claude-fable-5/google-agent-platform/us~12345678",
    "claude-fable-5/google-agent-platform/us~47498907",
  ]);
  assert.deepEqual(models, parseCatalog(payload(unique, other, row)));
  assert.equal(models.find(m => m.id.endsWith("~47498907"))?.samplingParams?.model, row.nexos_model_id);
});

test("retains distinct deployments, deduplicates UUIDs, handles short-ID collisions", () => {
  const other = { ...row, nexos_model_id: "47498907-1234-1234-1234-123456789abc" };
  const models = parseCatalog(payload(row, other, row));
  assert.equal(models.length, 2);
  assert.equal(new Set(models.map(m => m.id)).size, 2);
  assert.ok(models.every(m => m.id.includes(String(m.samplingParams?.model))));
  assert.deepEqual(models, parseCatalog(payload(other, row)));
});

test("uses safe defaults for absent/invalid metadata without clamping valid output limits", () => {
  const [model] = parseCatalog(payload({ ...row, context_length: -1, max_tokens: null, pricing: { input_cost_per_token: "NaN", output_cost_per_token: -1 } }));
  assert.equal(model.contextWindow, 32768);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("mixed catalog produces unique, text-only, routable models", () => {
  const rows = [
    row,
    { ...row, name: "Claude Fable 5 (3)", owned_by: "Bedrock", nexos_model_id: "12345678-1234-1234-1234-123456789abc" },
    { ...row, name: "Response Model", endpoints: ["responses"], nexos_model_id: "87654321-1234-1234-1234-123456789abc" },
    { name: "Embedding Model", endpoints: ["embeddings"], nexos_model_id: "abcdef01-1234-1234-1234-123456789abc" },
  ];
  const models = parseCatalog({ data: rows, total: rows.length });
  assert.equal(models.length, 3);
  assert.equal(new Set(models.map(m => m.id)).size, models.length);
  assert.ok(models.every(m => m.input.join() === "text" && !/\(\d+\)/.test(m.name)));
  assert.deepEqual(new Set(models.map(m => m.samplingParams?.model)), new Set(rows.slice(0, 3).map(r => r.nexos_model_id)));
});

test("discovery authenticates and does not leak server errors", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.nexos.ai/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json(payload(row));
  };
  await assert.rejects(fetchCatalog("", new AbortController().signal, "auto", fetcher), /requires an API key/);
  assert.equal(calls, 0);
  assert.equal((await fetchCatalog(" secret ", new AbortController().signal, "auto", fetcher)).length, 1);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(fetchCatalog("secret", new AbortController().signal, "auto", async () => new Response("secret", { status })), error => {
      assert.match(String(error), new RegExp(`HTTP ${status}`));
      assert.ok(!String(error).includes("secret"));
      return true;
    });
  }
  await assert.rejects(fetchCatalog("secret", AbortSignal.abort(), "auto", fetcher));
  assert.equal(calls, 1);
  await assert.rejects(fetchCatalog("secret", new AbortController().signal, "auto", async () => new Response("secret")), /invalid JSON/);
});
