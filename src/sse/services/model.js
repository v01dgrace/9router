// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  if (modelStr === "github/auto" || modelStr === "gh/auto") {
    return { provider: null, model: "github-stable" };
  }
  if (modelStr === "github/auto-fast" || modelStr === "gh/auto-fast") {
    return { provider: null, model: "github-fast" };
  }
  if (modelStr === "github/auto-coding" || modelStr === "gh/auto-coding") {
    return { provider: null, model: "github-coding" };
  }
  if (modelStr === "github/auto-agent" || modelStr === "gh/auto-agent") {
    return { provider: null, model: "github-agent" };
  }
  if (modelStr === "github/auto-reasoning" || modelStr === "gh/auto-reasoning") {
    return { provider: null, model: "github-reasoning" };
  }
  if (modelStr === "github/auto-canary" || modelStr === "gh/auto-canary") {
    return { provider: null, model: "github-canary" };
  }

  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  if (modelStr === "github/auto" || modelStr === "gh/auto") {
    const combo = await getComboByName("github-stable");
    return combo?.models || null;
  }
  if (modelStr === "github/auto-fast" || modelStr === "gh/auto-fast") {
    const combo = await getComboByName("github-fast");
    return combo?.models || null;
  }
  if (modelStr === "github/auto-coding" || modelStr === "gh/auto-coding") {
    const combo = await getComboByName("github-coding");
    return combo?.models || null;
  }
  if (modelStr === "github/auto-agent" || modelStr === "gh/auto-agent") {
    const combo = await getComboByName("github-agent");
    return combo?.models || null;
  }
  if (modelStr === "github/auto-reasoning" || modelStr === "gh/auto-reasoning") {
    const combo = await getComboByName("github-reasoning");
    return combo?.models || null;
  }
  if (modelStr === "github/auto-canary" || modelStr === "gh/auto-canary") {
    const combo = await getComboByName("github-canary");
    return combo?.models || null;
  }

  // NVIDIA NIM auto combos (dynamically seeded from provider_models)
  if (modelStr === "nvidia/auto" || modelStr === "nim/auto") {
    const combo = await getComboByName("nim-general");
    return combo?.models || null;
  }
  if (modelStr === "nvidia/auto-coding" || modelStr === "nim/auto-coding") {
    const combo = await getComboByName("nim-coding");
    return combo?.models || null;
  }
  if (modelStr === "nvidia/auto-fast" || modelStr === "nim/auto-fast") {
    const combo = await getComboByName("nim-fast");
    return combo?.models || null;
  }
  if (modelStr === "nvidia/auto-agent" || modelStr === "nim/auto-agent") {
    const combo = await getComboByName("nim-agent");
    return combo?.models || null;
  }
  if (modelStr === "nvidia/auto-reasoning" || modelStr === "nim/auto-reasoning") {
    const combo = await getComboByName("nim-reasoning");
    return combo?.models || null;
  }

  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
