import { createHash } from "node:crypto";
import {
  createProvider,
  type ApiKeyAuth,
  type Credential,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { completionsApi, responsesApi } from "./apis.ts";
import { BASE_URL, fetchCatalog, isRoutingId, type ApiPreference, type NexosApi, type NexosModel } from "./catalog.ts";

const CACHE_MS = 5 * 60_000;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

type Snapshot = { keyHash: string; models: NexosModel[]; fetchedAt: number };
export interface ProviderOptions {
  preference?: ApiPreference;
  fetcher?: typeof fetch;
  envKey?: () => string | undefined;
}

/** Alias routing happens at the payload boundary, preserving pi's model identity in history. */
function routedApi(api: ProviderStreams): ProviderStreams {
  const optionsFor = (model: NexosModel, options?: StreamOptions): StreamOptions => ({
    ...options,
    async onPayload(payload, callbackModel) {
      if (!options?.apiKey?.trim()) throw new Error("Nexos requires an API key. Run /login nexos.");
      const wireId = model.samplingParams?.model;
      if (!isRoutingId(wireId)) {
        throw new Error("Nexos model routing metadata is missing. Run /nexos-refresh.");
      }
      const next = await options?.onPayload?.(payload, callbackModel) ?? payload;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Invalid Nexos request payload.");
      return { ...next, model: wireId };
    },
  });
  return {
    stream: (model, context, options) => api.stream(model, context, optionsFor(model as NexosModel, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, {
      ...options, ...optionsFor(model as NexosModel, options),
    }),
  };
}

export function nexosProvider(options: ProviderOptions = {}): Provider<NexosApi> {
  const envKey = options.envKey ?? (() => process.env.NEXOS_API_KEY);
  const keyFor = (credential?: Credential) =>
    (credential?.type === "api_key" ? credential.key?.trim() : undefined) || envKey()?.trim();
  let current: Snapshot | undefined;
  // A successful login stages a catalog; pi's subsequent credential synchronization
  // publishes it only when that key has actually been saved. Failed/cancelled logins
  // therefore cannot replace the active account's models.
  let pendingLogin: Snapshot | undefined;
  const load = async (key: string, signal: AbortSignal): Promise<Snapshot> => ({
    keyHash: fingerprint(key),
    models: await fetchCatalog(key, signal, options.preference, options.fetcher),
    fetchedAt: Date.now(),
  });
  const auth: ApiKeyAuth = {
    name: "Nexos API key",
    async login(interaction) {
      interaction.signal.throwIfAborted();
      const key = (await interaction.prompt({ type: "secret", message: "Enter your Nexos API key" })).trim();
      if (!key) throw new Error("A Nexos API key is required.");
      interaction.notify({ type: "progress", message: "Validating API key and fetching Nexos models…" });
      const snapshot = await load(key, interaction.signal);
      interaction.signal.throwIfAborted();
      pendingLogin = snapshot;
      return { type: "api_key", key };
    },
    async resolve({ credential, ctx, signal }) {
      signal.throwIfAborted();
      const stored = credential?.key?.trim();
      const key = stored || (await ctx.env("NEXOS_API_KEY"))?.trim();
      signal.throwIfAborted();
      return key ? { auth: { apiKey: key }, source: stored ? "stored API key" : "NEXOS_API_KEY" } : undefined;
    },
  };
  const base = createProvider<NexosApi>({
    id: "nexos",
    name: "Nexos",
    baseUrl: BASE_URL,
    models: [],
    auth: { apiKey: auth },
    api: {
      "openai-completions": routedApi(completionsApi()),
      "openai-responses": routedApi(responsesApi()),
    },
  });
  return {
    ...base,
    getModels: () => current?.models ?? [],
    filterModels(models, credential) {
      const key = keyFor(credential);
      return key && current?.keyHash === fingerprint(key) ? models : [];
    },
    async refreshModels(context) {
      context.signal.throwIfAborted();
      const key = keyFor(context.credential);
      const hash = key ? fingerprint(key) : undefined;
      if (current && current.keyHash !== hash) {
        if (!await context.publish({ update: () => { current = undefined; } })) return;
      }
      if (!key) return; // No unauthenticated network calls, ever.
      if (pendingLogin?.keyHash === hash) {
        const snapshot = pendingLogin;
        if (!await context.publish({ update: () => { current = snapshot; pendingLogin = undefined; } })) return;
      }
      // Catalogs are intentionally memory-only and account-scoped. Never restore a
      // global persisted snapshot, which could belong to a different Nexos account.
      if (!context.allowNetwork) return;
      if (!context.force && current && current.keyHash === hash && Date.now() - current.fetchedAt < CACHE_MS) return;
      const snapshot = await load(key, context.signal);
      context.signal.throwIfAborted();
      await context.publish({ update: () => { current = snapshot; } });
    },
  };
}
