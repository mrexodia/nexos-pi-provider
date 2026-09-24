import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { nexosProvider } from "../src/provider.ts";

test("pi ModelRuntime login populates its picker snapshot immediately, logout removes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexos-runtime-test-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false,
    });
    runtime.registerNativeProvider(nexosProvider({ envKey: () => undefined, fetcher: async () => Response.json({ data: [{
      name: "Runtime Model", nexos_model_id: "12345678-1234-1234-1234-123456789abc",
      owned_by: "Test", region: "EU", endpoints: ["chat_completion"],
    }] }) }));
    await runtime.refresh({ allowNetwork: false, providers: ["nexos"] });
    assert.equal(runtime.getAvailableSnapshot().filter(m => m.provider === "nexos").length, 0);
    await runtime.login("nexos", "api_key", { notify() {}, async prompt() { return "fake-test-key"; } });
    const models = runtime.getAvailableSnapshot().filter(m => m.provider === "nexos");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "runtime-model/eu");
    assert.equal((await runtime.getAuth("nexos"))?.auth.apiKey, "fake-test-key");
    await runtime.logout("nexos");
    assert.equal(runtime.getAvailableSnapshot().filter(m => m.provider === "nexos").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
