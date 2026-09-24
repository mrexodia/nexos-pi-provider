import type { Model } from "@earendil-works/pi-ai";

export const BASE_URL = "https://api.nexos.ai/v1";
export type NexosApi = "openai-completions" | "openai-responses";
export type ApiPreference = "auto" | "completions" | "responses";
export type NexosModel = Model<NexosApi>;

export function readApiPreference(value = process.env.NEXOS_API): ApiPreference {
  const preference = value?.trim() || "auto";
  if (preference !== "auto" && preference !== "completions" && preference !== "responses") {
    throw new Error("NEXOS_API must be auto, completions, or responses.");
  }
  return preference;
}

export function nexosCompat(api: NexosApi): NexosModel["compat"] {
  return api === "openai-completions" ? {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
  } : { supportsStrictMode: false };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  // Catalog metadata is untrusted terminal output: remove controls, including ESC.
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

export function cleanName(value: string): string {
  return text(value).replace(/\s+\(\d+\)$/, "").trim();
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function perMillion(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  const rate = number * 1_000_000;
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

/** Do not guess capabilities from names: endpoints are authoritative. */
export function parseCatalog(payload: unknown, preference: ApiPreference = "auto"): NexosModel[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.data)) throw new Error("Nexos returned an invalid model catalog (expected data array).");
  if (typeof root.total === "number" && root.total > root.data.length) {
    throw new Error("Nexos returned a partial catalog; pagination is not supported yet.");
  }
  const models: NexosModel[] = [];
  const hostedAliases = new Map<NexosModel, string>();
  const seen = new Set<string>();
  for (const value of root.data) {
    const row = record(value);
    if (!row) continue;
    const endpoints = Array.isArray(row.endpoints) ? row.endpoints : [];
    const chat = endpoints.includes("chat_completion");
    const responses = endpoints.includes("responses");
    if (!chat && !responses) continue;
    const uuid = text(row.nexos_model_id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      throw new Error("Nexos chat model has a missing or invalid nexos_model_id.");
    }
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const name = cleanName(text(row.name) || text(row.id)) || "Unnamed model";
    const owner = text(row.owned_by) || "Unknown host";
    const region = text(row.region) || "Unknown region";
    const api: NexosApi = responses && (preference === "responses" || !chat)
      ? "openai-responses" : "openai-completions";
    const pricing = record(row.pricing) ?? {};
    const contextWindow = positiveInteger(row.context_length, 32_768);
    const model: NexosModel = {
      id: `${slug(name)}/${slug(region)}`,
      name: `${name} · ${owner} · ${region}`,
      api,
      provider: "nexos",
      baseUrl: BASE_URL,
      reasoning: false, // Nexos does not currently advertise reasoning controls.
      input: ["text"],
      contextWindow,
      maxTokens: positiveInteger(row.max_tokens, Math.min(4096, contextWindow)),
      cost: {
        input: perMillion(pricing.input_cost_per_token),
        output: perMillion(pricing.output_cost_per_token),
        cacheRead: perMillion(pricing.cache_read_cost_per_token),
        cacheWrite: perMillion(pricing.cache_write_cost_per_token),
      },
      // Kept on the model so pi's normal modelOverrides composition preserves routing.
      samplingParams: { model: uuid },
      compat: nexosCompat(api),
    };
    models.push(model);
    hostedAliases.set(model, `${slug(name)}/${slug(owner)}/${slug(region)}`);
  }
  // Region is usually enough. Include the host only for ambiguous regional aliases.
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  for (const model of models) {
    if (counts.get(model.id)! > 1) model.id = hostedAliases.get(model)!;
  }
  // Only disambiguate deployments whose host-qualified aliases still collide.
  counts.clear();
  for (const model of models) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  for (const model of models) {
    if (counts.get(model.id)! > 1) {
      model.id += `~${String(model.samplingParams!.model).slice(0, 8).toLowerCase()}`;
    }
  }
  // Never silently conflate two deployments, even with a colliding UUID prefix.
  counts.clear();
  for (const model of models) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  for (const model of models) {
    if (counts.get(model.id)! > 1) model.id = model.id.replace(/~[^~]+$/, `~${model.samplingParams!.model}`);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export async function fetchCatalog(
  key: string,
  signal: AbortSignal,
  preference: ApiPreference = "auto",
  fetcher: typeof fetch = fetch,
): Promise<NexosModel[]> {
  if (!key.trim()) throw new Error("Nexos requires an API key. Run /login nexos or set NEXOS_API_KEY.");
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  boundedSignal.throwIfAborted();
  let response: Response;
  try {
    response = await fetcher(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
      signal: boundedSignal,
      redirect: "error", // Never forward a secret to a catalog redirect.
    });
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error(boundedSignal.aborted ? "Nexos model discovery timed out." : "Could not connect to Nexos for model discovery.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Do not include remote bodies/statusText, which could echo a secret.
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Nexos rejected the API key (HTTP ${response.status}). Check the key and model-list permissions.`);
    }
    throw new Error(`Nexos model discovery failed (HTTP ${response.status}). Try /nexos-refresh again later.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error(boundedSignal.aborted ? "Nexos model discovery timed out." : "Nexos returned invalid JSON for its model catalog.");
  }
  boundedSignal.throwIfAborted();
  return parseCatalog(payload, preference);
}
