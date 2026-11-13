# Long-context coding combo

Status: proposed; awaiting user approval.

## Intent and scope

Keep the existing local `awesome-coding` alias useful for long coding sessions: prefer Claude, then continue through other connected providers when quota or availability prevents a request. The user chose approach A, long-context compatibility, and requested more providers. Work is local only; the user will import configuration to the VPS. Other combos remain outside this change.

Current local DB contains Sonnet 5.5 → Opus 5.5 → Gemini 3.5 Flash Lite. Existing fallback routing already attempts models sequentially; reuse it rather than introduce a new routing engine.

## Approaches

- **A, selected:** keep a compact chain of models eligible for long context and agent tools. Fewer eligible routes, but less risk that fallback rejects a large conversation.
- **Broad mixed-context chain:** include Codestral, Copilot GPT-4.1 and additional short-context routes. More alternatives for small requests, but unsuitable as a universal long-context fallback.
- **Separate long and short combos:** allows more specialized routes, but adds aliases and client choices. Defer this because the requested outcome is one useful combo.

## Proposed chain

1. `cc/claude-sonnet-5-5`: primary coding model.
2. `cc/claude-opus-5-5`: Claude quality fallback; may share exhausted account quota with Sonnet.
3. `mistral/mistral-large-latest`: independent provider fallback. The authenticated Mistral catalog resolves this alias to Large 4 with 1,048,576 context and function calling. Existing API usage may incur charges.
4. `gemini/gemini-3.5-flash-lite`: cross-provider fallback with a passing multi-turn tool test.
5. `gemini/gemini-3-flash-preview`: retain only if it passes the same multi-turn tool test. This adds a model alternative, not another provider.
6. `nvidia/nvidia/nemotron-3-ultra-550b-a55b`: add only if the hosted route's supported context and tool behavior can be established. A model card advertising 1M and a passing short tool test do not establish hosted long-context support.

Positions after the Claude pair are a proposal based on compatibility and existing test evidence, not a measured throughput ranking. Do not pad the chain with failing routes. Preserve fallback strategy and existing account selection.

## Eligibility and metadata

Every active member must support the configured context limit and complete a tool/result/final-response round trip through the client protocol. The advertised combo limit must not exceed its least capable member. Mistral discovery currently understates the upstream limit; NVIDIA discovery reports 128K and tools false despite a successful short tool test. Resolve these discrepancies in the responsible capability metadata layer using verified route evidence before advertising a larger limit. Do not force `[1m]` to bypass actual upstream limits. One million decimal tokens and 1,048,576 tokens are different limits.

Codestral and Copilot GPT-4.1 remain outside this chain because their current route limits are below the long-context target. Unavailable Kiro, retired models and unsupported iFlow routes are excluded.

## Kilo decision

`kgw/nvidia/nemotron-3-ultra-550b-a55b:free` advertises 1,000,000 context and tools, but its catalog declares `mayTrainOnYourPrompts=true`. Proposed default: exclude it from automatic routing of repository content. Adding it requires the user's acceptance of that data handling. It also lists NVIDIA as its upstream, so adding it alongside NVIDIA does not establish independent capacity. No new subscription, billing activation or automatic top-up is part of this design.

## Continuity and limits

Fallback can replay an eligible request and history to another model before a successful response begins. It cannot guarantee identical reasoning, shared prompt cache, recovery from every partially emitted stream, or conversion of a valid text-only `end_turn` into a tool call. The observed Codestral incident was a completed text-only turn, not proven network loss. This configuration must not be described as an engine fix for all interruptions.

## Validation and rollback

Back up the affected combo and any metadata before changes. Run the smallest sufficient checks: catalog/metadata consistency, a streamed Read → Edit → Read → final response with fake tools, and controlled quota failure of the Claude routes followed by successful cross-provider tool continuation. Preserve history and tool schemas. Test real long inputs only within verified route limits; short probes are not evidence of 1M reliability. Record unverified routes rather than include them by assumption.

Apply the approved chain to the local DB only, verify the running 0.5.119 service sees it, and produce a credential-free configuration reference for review. The repository is 0.5.116, so do not deploy it over the installed service as an incidental downgrade. Restore the saved combo/metadata on failed acceptance. Do not change unrelated combos, credentials or the VPS.

## Evidence

Local research and test traces are in `/Users/nikodapoet/Developer/reports/9router-combo-2026-11-13/`, including `cross-provider-continuity.md`, `agent-stop-diagnosis.md` and `guide-fact-check.md`.

Upstream catalog sources: `https://api.mistral.ai/v1/models`, `https://integrate.api.nvidia.com/v1/models`, `https://api.kilo.ai/api/gateway/models`. Catalog observations were made on 2026-11-13 and may change.
