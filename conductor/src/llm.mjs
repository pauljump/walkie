import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, requireAnthropicApiKey } from './config.mjs';

// Shared Anthropic access for the EM (Mara). This is the METERED side — a per-user API key that
// runs the conversation for pennies. The BUILDERS do NOT use this key: they authenticate through
// the operator's own claude/codex subscription login (keychain), so builds stay flat/free.
//
// Sonnet for conversational latency — the Director is waiting on a walk. Model is config-driven
// (cfg.anthropicModel) so an operator can swap it; MODEL stays exported for callers that want a
// synchronous default.

export const MODEL = loadConfig().anthropicModel || 'claude-sonnet-4-6';

// The EM's API key: from ~/.walkie/config.json (anthropicApiKey) or WALKIE_ANTHROPIC_API_KEY.
// Throws with a pointer to the config if absent — self-host has no ~/.secrets fallback.
export function loadApiKey() {
  return requireAnthropicApiKey();
}

let _client;
export function anthropic() {
  // maxRetries: 6 (SDK default is 2) — Anthropic has transient 500/overload blips, and a build
  // makes MANY calls (engineer ack + every worker step), so at the default a blip drops a turn
  // or kills a build. The SDK retries 408/409/429/5xx with exponential backoff; six attempts
  // rides out a rough patch. Retries only fire on failure, so a healthy API pays no latency.
  if (!_client) _client = new Anthropic({ apiKey: loadApiKey(), maxRetries: 6, timeout: 60_000 });
  return _client;
}
