import * as piAI from "@earendil-works/pi-ai";
import type { ProviderStreams } from "@earendil-works/pi-ai";

// Pi 0.85 redirects the root import to pi-ai/compat, and its jiti prefix alias
// breaks direct /api/* imports. Plain Node instead exposes APIs via subpaths.
// Use the host's factories when present; lazy-load subpaths only outside Pi.
const host = piAI as typeof piAI & {
  openAICompletionsApi?: () => ProviderStreams;
  openAIResponsesApi?: () => ProviderStreams;
};
export const completionsApi = () => host.openAICompletionsApi?.() ??
  piAI.lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));
export const responsesApi = () => host.openAIResponsesApi?.() ??
  piAI.lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses"));
