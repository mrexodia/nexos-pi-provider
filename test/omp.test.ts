import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { createOmpProviderConfig, readOmpRoute } from "../src/omp.ts";

const uuid = "12345678-1234-1234-1234-123456789abc";
const catalog = { data: [{
  name: "OMP Test (1)", nexos_model_id: uuid, endpoints: ["chat_completion", "responses"],
  owned_by: "Host", region: "EU", context_length: 8192, max_tokens: 1024,
}] };

for (const [field, wireId] of [
  ["nexos_model_id", uuid],
  ["nexos_model_id", "auto-code"],
  ["id", "auto-code"],
  ["id", "Vendor/Model (1):100%#モデル"],
] as const) for (const preference of ["completions", "responses"] as const) {
  test(`OMP ${preference} discovery, login staging, and ${field}=${wireId} routing`, async () => {
    let discoveryCalls = 0;
    const config = createOmpProviderConfig({ preference, fetcher: async () => {
      discoveryCalls++;
      return Response.json({ data: [{ ...catalog.data[0], nexos_model_id: undefined, [field]: wireId }] });
    } });
    assert.equal(config.apiKey, "NEXOS_API_KEY");
    assert.equal(config.baseUrl, undefined, "a provider-wide URL would erase per-model routing metadata");
    assert.deepEqual(await config.fetchDynamicModels!(undefined), []);
    assert.equal(discoveryCalls, 0);

    let promptSecret = false;
    const key = await config.oauth!.login({
      onAuth() {},
      async onPrompt(prompt) { promptSecret = prompt.secret === true; return " test-key "; },
      signal: new AbortController().signal,
    });
    assert.equal(key, "test-key");
    assert.equal(promptSecret, true);
    assert.equal(discoveryCalls, 1);

    const models = await config.fetchDynamicModels!("test-key");
    assert.equal(discoveryCalls, 1, "successful login should stage its fetched catalog");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "omp-test/eu");
    assert.deepEqual(readOmpRoute(models[0].baseUrl!), {
      api: preference === "completions" ? "openai-completions" : "openai-responses",
      model: wireId,
    });

    let payload: Record<string, unknown> | undefined;
    let requestUrl = "";
    const stream = config.streamSimple!(
      { ...models[0], provider: "nexos", compat: undefined } as unknown as Model,
      { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] } as Context,
      {
        apiKey: "test-key",
        fetch: async (url, init) => {
          requestUrl = String(url);
          payload = JSON.parse(String(init?.body));
          const events = preference === "completions" ? [
            { id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
            { id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ] : [
            { type: "response.created", response: { id: "resp-1", status: "in_progress" } },
            { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", content: [] } },
            { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
            { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] } },
            { type: "response.completed", response: { id: "resp-1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      },
    );
    const message = await stream.result();
    assert.equal(payload?.model, wireId);
    assert.ok(requestUrl.endsWith(preference === "completions" ? "/chat/completions" : "/responses"));
    assert.equal(message.model, models[0].id);
    assert.equal(message.stopReason, "stop", message.errorMessage);
  });
}

test("OMP rejects missing or malformed routing metadata", () => {
  assert.throws(() => readOmpRoute("https://api.nexos.ai/v1"), /routing metadata is missing/);
  for (const route of ["openai-responses:", "openai-responses:%ZZ", "openai-responses:bad%0Aid", "unknown:auto-code", "openai-responses"]) {
    assert.throws(() => readOmpRoute(`https://api.nexos.ai/v1#nexos:${route}`), /routing metadata is invalid/);
  }
  assert.deepEqual(readOmpRoute(`https://api.nexos.ai/v1#nexos:openai-responses:${uuid}`), { api: "openai-responses", model: uuid });
});
