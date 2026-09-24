import { createHash } from "node:crypto";
import { streamSimple, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderConfigInput,
} from "@oh-my-pi/pi-coding-agent";
import {
  BASE_URL,
  fetchCatalog,
  isRoutingId,
  nexosCompat,
  readApiPreference,
  type ApiPreference,
  type NexosApi,
  type NexosModel,
} from "./catalog.ts";

const OMP_API = "nexos-openai";
const ROUTE_PREFIX = "nexos:";
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

type OmpModelConfig = NonNullable<ProviderConfigInput["models"]>[number];
type OmpStreamSimple = NonNullable<ProviderConfigInput["streamSimple"]>;
type NexosRoute = { api: NexosApi; model: string };

export interface OmpProviderOptions {
  preference?: ApiPreference;
  fetcher?: typeof fetch;
}

export function readOmpRoute(baseUrl: string): NexosRoute {
  let hash: string;
  try {
    hash = new URL(baseUrl).hash.slice(1);
  } catch {
    throw new Error("Nexos model routing metadata is missing. Run /nexos-refresh.");
  }
  if (!hash.startsWith(ROUTE_PREFIX)) {
    throw new Error("Nexos model routing metadata is missing. Run /nexos-refresh.");
  }
  const separator = hash.indexOf(":", ROUTE_PREFIX.length);
  const api = hash.slice(ROUTE_PREFIX.length, separator) as NexosApi;
  let model: string;
  try {
    model = decodeURIComponent(hash.slice(separator + 1));
  } catch {
    throw new Error("Nexos model routing metadata is invalid. Run /nexos-refresh.");
  }
  if (separator < 0 || (api !== "openai-completions" && api !== "openai-responses") || !isRoutingId(model)) {
    throw new Error("Nexos model routing metadata is invalid. Run /nexos-refresh.");
  }
  return { api, model };
}

export function toOmpModel(model: NexosModel): OmpModelConfig {
  const wireId = model.samplingParams?.model;
  if (!isRoutingId(wireId)) {
    throw new Error("Nexos model routing metadata is missing.");
  }
  return {
    id: model.id,
    name: model.name,
    api: OMP_API,
    baseUrl: `${BASE_URL}#${ROUTE_PREFIX}${model.api}:${encodeURIComponent(wireId)}`,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

const routedStreamSimple: OmpStreamSimple = (model, context, options) => {
  const route = readOmpRoute(model.baseUrl);
  const {
    compat: _compat,
    compatConfig: _compatConfig,
    identity: _identity,
    ...base
  } = model;
  const routed = buildModel({
    ...base,
    api: route.api,
    baseUrl: BASE_URL,
    requestModelId: route.model,
    compat: nexosCompat(route.api),
  } as ModelSpec<NexosApi>);
  return streamSimple(routed, context, options);
};

export function createOmpProviderConfig(options: OmpProviderOptions = {}): ProviderConfigInput {
  const preference = options.preference ?? readApiPreference();
  const fetcher = options.fetcher ?? fetch;
  let pendingLogin: { keyHash: string; models: OmpModelConfig[] } | undefined;
  const load = async (key: string, signal: AbortSignal) =>
    (await fetchCatalog(key, signal, preference, fetcher)).map(toOmpModel);

  return {
    apiKey: "NEXOS_API_KEY",
    api: OMP_API,
    streamSimple: routedStreamSimple,
    oauth: {
      name: "Nexos API key",
      async login(callbacks) {
        callbacks.signal?.throwIfAborted();
        const key = (await callbacks.onPrompt({ message: "Enter your Nexos API key", secret: true })).trim();
        if (!key) throw new Error("A Nexos API key is required.");
        callbacks.onProgress?.("Validating API key and fetching Nexos models…");
        const models = await load(key, callbacks.signal ?? AbortSignal.timeout(15_000));
        callbacks.signal?.throwIfAborted();
        pendingLogin = { keyHash: fingerprint(key), models };
        return key;
      },
    },
    async fetchDynamicModels(apiKey) {
      const key = apiKey?.trim();
      if (!key) return [];
      const keyHash = fingerprint(key);
      if (pendingLogin?.keyHash === keyHash) {
        const models = pendingLogin.models;
        pendingLogin = undefined;
        return models;
      }
      return load(key, AbortSignal.timeout(15_000));
    },
  };
}

export default function nexosOmpExtension(pi: ExtensionAPI) {
  pi.registerProvider("nexos", createOmpProviderConfig() as ProviderConfig);
  pi.registerCommand("nexos-refresh", {
    description: "Refresh the authenticated Nexos model catalog",
    async handler(_args, ctx) {
      const key = await ctx.modelRegistry.getApiKeyForProvider("nexos");
      if (!key) {
        ctx.ui.notify("Run /login nexos or set NEXOS_API_KEY first.", "warning");
        return;
      }
      try {
        await ctx.modelRegistry.refreshProvider("nexos", "online");
        const count = ctx.modelRegistry.getProviderModels("nexos").length;
        ctx.ui.notify(`Loaded ${count} Nexos models. Open /model to select one.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Nexos model refresh failed.", "error");
      }
    },
  });
}
