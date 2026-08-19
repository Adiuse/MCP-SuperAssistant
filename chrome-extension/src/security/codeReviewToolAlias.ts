export interface NamedTool {
  name: string;
  [key: string]: any;
}

function terminalToolSegment(name: string): string {
  const clean = String(name || '').trim();
  if (!clean) return '';
  const segments = clean.split(/[.:/]/g).filter(Boolean);
  return segments[segments.length - 1] || clean;
}

export function canonicalizeScopedToolName(
  serverToolName: string,
  allowedTools: readonly string[],
): string | null {
  const allowed = new Set(allowedTools);
  const clean = String(serverToolName || '').trim();
  if (!clean) return null;
  if (allowed.has(clean)) return clean;

  const terminal = terminalToolSegment(clean);
  return allowed.has(terminal) ? terminal : null;
}

/**
 * Expose only the approved canonical tool names to the model. MCP aggregators
 * commonly namespace tools (for example `github.get_file_contents`). Exact
 * unprefixed names win. A prefixed alias is exposed only when it resolves
 * unambiguously to one server tool; ambiguous aliases are omitted entirely.
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
    `Approved GitHub tool '${canonicalName}' is ambiguous across MCP server namespaces`,
  );
}
