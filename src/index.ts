import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readApiPreference } from "./catalog.ts";
import { nexosProvider } from "./provider.ts";

export default async function nexosExtension(pi: ExtensionAPI) {
  const provider = nexosProvider({ preference: readApiPreference() });
  let startupError: string | undefined;
  // Pi initializes extension providers cache-only. Bootstrap in the awaited
  // factory so discovery also works with --list-models and initial --model.
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "") || process.argv.includes("--offline");
  if (!offline) {
    try {
      await provider.refreshModels!({
        credential: readStoredCredential("nexos"),
        allowNetwork: true,
        signal: AbortSignal.timeout(15_000),
        async publish({ update }) { update?.(); return true; },
      });
    } catch (error) {
      // Keep /login available even if the current credential/network is broken.
      startupError = error instanceof Error ? error.message : "Nexos model discovery failed.";
      console.warn(`[nexos] ${startupError}`);
    }
  }
  pi.registerProvider(provider);
  pi.on("session_start", (_event, ctx) => {
    if (startupError && ctx.hasUI) ctx.ui.notify(startupError, "warning");
  });
  pi.registerCommand("nexos-refresh", {
    description: "Refresh the authenticated Nexos model catalog",
    async handler(_args, ctx) {
      const auth = await ctx.modelRegistry.getProviderAuth("nexos");
      if (!auth?.auth.apiKey) {
        ctx.ui.notify("Run /login nexos or set NEXOS_API_KEY first.", "warning");
        return;
      }
      const result = await ctx.modelRegistry.refresh({
        providers: ["nexos"], allowNetwork: true, force: true, signal: AbortSignal.timeout(15_000),
      });
      const error = result.errors.get("nexos");
      if (error || result.aborted) {
        ctx.ui.notify(error?.message ?? "Nexos model refresh timed out.", "error");
        return;
      }
      const count = ctx.modelRegistry.getProvider("nexos")?.getModels().length ?? 0;
      ctx.ui.notify(`Loaded ${count} Nexos models. Open /model to select one.`, "info");
    },
  });
}
