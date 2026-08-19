export interface NamedTool {
  name: string;
  [key: string]: any;
}

const GITHUB_NAMESPACE_PREFIX = /^(?:[a-z0-9]+[-_.:/]+)*github(?:[-_.:/]+review)?[-_.:/]+$/i;

function canonicalSuffixFromGithubNamespace(
  name: string,
  allowedTools: readonly string[],
): string | null {
  const clean = String(name || '').trim();
  if (!clean) return null;

  // Match the longest allowlisted suffix first. This avoids treating an
  // underscore inside the canonical tool name itself as a namespace boundary.
  const candidates = [...allowedTools].sort((a, b) => b.length - a.length);
  for (const canonical of candidates) {
    if (!clean.endsWith(canonical)) continue;
    const prefix = clean.slice(0, -canonical.length);
    if (!prefix) continue;

    // Only known GitHub/GitHub-review namespaces may alias into the privileged
    // Code Review allowlist. A different MCP server that happens to expose a
    // similarly named tool must never acquire GitHub Code Review capability.
    if (GITHUB_NAMESPACE_PREFIX.test(prefix)) return canonical;
  }

  return null;
}

export function canonicalizeScopedToolName(
  serverToolName: string,
  allowedTools: readonly string[],
): string | null {
  const allowed = new Set(allowedTools);
  const clean = String(serverToolName || '').trim();
  if (!clean) return null;
  if (allowed.has(clean)) return clean;

  return canonicalSuffixFromGithubNamespace(clean, allowedTools);
}

/**
 * Expose only the approved canonical tool names to the model. MCP aggregators
 * may namespace the configured `github-review` server in forms such as
 * `github.get_file_contents`, `github-review__get_file_contents`, or
 * `github_review_get_file_contents`. Exact unprefixed names win. A GitHub-
 * namespaced alias is exposed only when it resolves unambiguously to one server
 * tool; ambiguous aliases are omitted entirely.
 */
export function aliasScopedTools<T extends NamedTool>(
  tools: readonly T[],
  allowedTools: readonly string[],
): T[] {
  const grouped = new Map<string, T[]>();

  for (const tool of tools) {
    const canonical = canonicalizeScopedToolName(tool.name, allowedTools);
    if (!canonical) continue;
    const items = grouped.get(canonical) || [];
    items.push(tool);
    grouped.set(canonical, items);
  }

  const exposed: T[] = [];
  for (const canonical of allowedTools) {
    const candidates = grouped.get(canonical) || [];
    if (candidates.length === 0) continue;

    const exact = candidates.find(tool => tool.name === canonical);
    if (exact) {
      exposed.push({ ...exact, name: canonical });
      continue;
    }

    if (candidates.length === 1) {
      exposed.push({ ...candidates[0], name: canonical });
    }
  }

  return exposed;
}

/**
 * Resolve the canonical model-visible name back to the exact server-side tool
 * name. This happens only after Gate authorization. Ambiguity is a hard deny.
 */
export function resolveScopedServerToolName(
  tools: readonly NamedTool[],
  canonicalName: string,
  allowedTools: readonly string[],
): string {
  if (!allowedTools.includes(canonicalName)) {
    throw new Error(`Tool '${canonicalName}' is not an approved Code Review alias`);
  }

  const candidates = tools.filter(
    tool => canonicalizeScopedToolName(tool.name, allowedTools) === canonicalName,
  );

  const exact = candidates.find(tool => tool.name === canonicalName);
  if (exact) return exact.name;
  if (candidates.length === 1) return candidates[0].name;
  if (candidates.length === 0) {
    throw new Error(`Approved GitHub tool '${canonicalName}' is not available from the MCP server`);
  }

  throw new Error(
    `Approved GitHub tool '${canonicalName}' is ambiguous across GitHub MCP server namespaces`,
  );
}
