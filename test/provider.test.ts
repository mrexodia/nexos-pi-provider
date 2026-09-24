import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Credential, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { nexosProvider } from "../src/provider.ts";

const uuid = "12345678-1234-1234-1234-123456789abc";
const catalog = { data: [{ name: "Test (1)", nexos_model_id: uuid, endpoints: ["chat_completion", "responses"], owned_by: "Host", region: "EU", context_length: 8192, max_tokens: 1024 }] };
const credential: Credential = { type: "api_key", key: "test-key" };
const refreshContext = (overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
  credential, allowNetwork: true, signal: new AbortController().signal,
  async publish({ update, persist }) { assert.equal(persist, undefined); update?.(); return true; },
  ...overrides,
});

function harness() {
  let calls = 0;
  let fail = false;
  const provider = nexosProvider({ envKey: () => undefined, fetcher: async () => {
    calls++;
    return fail ? new Response("private server error", { status: 500 }) : Response.json(catalog);
  } });
  return { provider, calls: () => calls, fail: () => { fail = true; } };
}

test("no anonymous/offline discovery, memory cache, force refresh, failure retention", async () => {
  const h = harness();
  await h.provider.refreshModels!(refreshContext({ credential: undefined }));
  await h.provider.refreshModels!(refreshContext({ allowNetwork: false }));
  assert.equal(h.calls(), 0);
  await h.provider.refreshModels!(refreshContext());
  assert.equal(h.provider.getModels().length, 1);
  await h.provider.refreshModels!(refreshContext());
  assert.equal(h.calls(), 1);
  await h.provider.refreshModels!(refreshContext({ force: true }));
  assert.equal(h.calls(), 2);
  h.fail();
  await assert.rejects(h.provider.refreshModels!(refreshContext({ force: true })), /HTTP 500/);
  assert.equal(h.provider.getModels().length, 1);
  await h.provider.refreshModels!(refreshContext({ credential: undefined, allowNetwork: false }));
  assert.equal(h.provider.getModels().length, 0);
});

test("login uses a secret prompt, validates, then publishes on credential synchronization", async () => {
  const h = harness();
  const saved = await h.provider.auth.apiKey!.login!({
    signal: new AbortController().signal, notify() {},
    async prompt(prompt) { assert.equal(prompt.type, "secret"); return " test-key "; },
  });
  assert.deepEqual(saved, credential);
  assert.equal(h.provider.getModels().length, 0);
  await h.provider.refreshModels!(refreshContext({ credential: saved, allowNetwork: false }));
  assert.equal(h.provider.getModels().length, 1);
  assert.equal(h.calls(), 1);
  await h.provider.refreshModels!(refreshContext());
  assert.equal(h.calls(), 1);
  h.fail();
  await assert.rejects(h.provider.auth.apiKey!.login!({
    signal: new AbortController().signal, notify() {}, async prompt() { return "bad-key"; },
  }), /HTTP 500/);
  assert.equal(h.provider.getModels().length, 1);
});

test("pi login accepts valid models alongside an unusable catalog entry (#1)", async () => {
  const provider = nexosProvider({ envKey: () => undefined, fetcher: async () => Response.json({
    data: [...catalog.data, { ...catalog.data[0], nexos_model_id: null }],
  }) });
  const saved = await provider.auth.apiKey!.login!({
    signal: new AbortController().signal, notify() {}, async prompt() { return "test-key"; },
  });
  assert.deepEqual(saved, credential);
  await provider.refreshModels!(refreshContext({ credential: saved, allowNetwork: false }));
  assert.equal(provider.getModels().length, 1);
  assert.equal(provider.getModels()[0].samplingParams?.model, uuid);
});

test("credential changes and rejected publications cannot expose another account's models", async () => {
  const h = harness();
  await h.provider.refreshModels!(refreshContext({ async publish() { return false; } }));
  assert.equal(h.provider.getModels().length, 0);
  await h.provider.refreshModels!(refreshContext());
  const other: Credential = { type: "api_key", key: "other-key" };
  assert.equal(h.provider.filterModels!(h.provider.getModels(), other).length, 0);
  await h.provider.refreshModels!(refreshContext({ credential: other, allowNetwork: false }));
  assert.equal(h.provider.getModels().length, 0);
});

test("stored API key wins over environment; no key means unconfigured", async () => {
  const h = harness();
  const ctx = { async env() { return "env-key"; }, async fileExists() { return false; } };
  const resolve = h.provider.auth.apiKey!.resolve;
  assert.equal((await resolve({ ctx, credential, signal: new AbortController().signal }))?.auth.apiKey, "test-key");
  assert.equal((await resolve({ ctx, signal: new AbortController().signal }))?.auth.apiKey, "env-key");
  assert.equal(await resolve({ ctx: { ...ctx, async env() { return undefined; } }, signal: new AbortController().signal }), undefined);
});

test("pi-ai runtime performs authenticated refresh and hides models on logout", async () => {
  let stored: Credential | undefined;
  const h = harness();
  const models = createModels({
    authContext: { async env() { return undefined; }, async fileExists() { return false; } },
    credentials: {
      async read() { return stored; }, async list() { return []; },
      async modify(_id, fn) { stored = await fn(stored); return stored; }, async delete() { stored = undefined; },
    },
  });
  models.setProvider(h.provider);
  await models.refresh();
  assert.equal(h.calls(), 0);
  await models.login("nexos", "api_key", { notify() {}, async prompt() { return "test-key"; } });
  await models.refresh({ allowNetwork: false });
  assert.equal((await models.getAvailable("nexos")).length, 1);
  await models.logout("nexos");
  await models.refresh({ allowNetwork: false });
  assert.equal((await models.getAvailable("nexos")).length, 0);
  assert.equal(h.provider.getModels().length, 0);
});

for (const [field, wireId] of [
  ["nexos_model_id", uuid],
  ["nexos_model_id", "auto-code"],
  ["id", "auto-code"],
  ["id", "Vendor/Model (1):100%#モデル"],
] as const) for (const preference of ["completions", "responses"] as const) {
  test(`${preference} transport sends ${field}=${wireId} while preserving readable model identity`, async () => {
    const provider = nexosProvider({ preference, envKey: () => undefined, fetcher: async () => Response.json({
      data: [{ ...catalog.data[0], nexos_model_id: undefined, [field]: wireId }],
    }) });
    await provider.refreshModels!(refreshContext());
    const model = provider.getModels()[0];
    let captured: Record<string, unknown> | undefined;
    let requestUrl = "";
    const message = await provider.streamSimple(model, {
      messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
    }, {
      apiKey: "test-key", maxRetries: 0,
      // A caller hook can change other fields but must not corrupt alias routing.
      onPayload: payload => ({ ...payload as object, model: "wrong-model", temperature: 0.1 }),
      fetch: async (url, init) => {
        requestUrl = String(url);
        captured = JSON.parse(String(init?.body));
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
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
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    }).result();
    assert.equal(captured?.model, wireId);
    assert.equal(captured?.temperature, 0.1);
    assert.ok(requestUrl.endsWith(preference === "completions" ? "/chat/completions" : "/responses"));
    assert.equal(message.model, model.id);
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.equal(message.content[0]?.type, "text");
    assert.equal(message.content[0]?.type === "text" && message.content[0].text, "Hello");
  });
}
