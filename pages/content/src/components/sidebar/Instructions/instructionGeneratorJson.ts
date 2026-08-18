type InstructionTool = {
  name: string;
  schema: string;
  description: string;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

function parseSchema(schemaText: string): JsonSchema {
  try {
    const parsed = JSON.parse(schemaText || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function describeProperty(name: string, property: any, required: Set<string>): string {
  const type = typeof property?.type === 'string' ? property.type : 'any';
  const requirement = required.has(name) ? 'required' : 'optional';
  const description = typeof property?.description === 'string' ? property.description.trim() : '';
  const enumValues = Array.isArray(property?.enum) ? ` Allowed values: ${property.enum.join(', ')}.` : '';

  return `- \`${name}\` (${type}, ${requirement})${description ? `: ${description}` : ''}${enumValues}`;
}

function renderTool(tool: InstructionTool): string {
  const schema = parseSchema(tool.schema);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const parameterLines = Object.entries(properties).map(([name, property]) =>
    describeProperty(name, property, required),
  );

  return [
    `### ${tool.name}`,
    tool.description ? tool.description.trim() : 'No description provided.',
    parameterLines.length > 0 ? 'Parameters:' : 'Parameters: none',
    ...parameterLines,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Generates the instruction block injected/attached to the chat so the model
 * can emit MCP function calls in the exact JSONL format understood by the
 * extension DOM observer.
 *
 * Important: execution is handled by MCP SuperAssistant. The model must never
 * ask the user to copy, paste, or manually execute the JSONL call.
 */
export const generateInstructionsJson = (
  tools: InstructionTool[],
  customInstructions?: string,
  customInstructionsEnabled?: boolean,
): string => {
  if (!tools || tools.length === 0) {
    return [
      '[MCP SuperAssistant]',
      'No MCP tools are currently exposed. Do not claim that you can access external resources through MCP.',
    ].join('\n');
  }

  const toolList = tools.map(renderTool).join('\n\n');
  const custom =
    customInstructionsEnabled && customInstructions?.trim()
      ? `\n\n## Custom instructions\n${customInstructions.trim()}`
      : '';

  return `[MCP SuperAssistant Instructions][IMPORTANT]

You can use only the MCP tools listed below. MCP SuperAssistant watches your response, captures valid JSONL function calls, executes them through the local extension, and returns the result to the conversation.

Rules:
1. When a tool is needed, emit exactly ONE function call and then STOP.
2. Do NOT ask the user to copy, paste, click, or manually execute the function call.
3. Do NOT use ChatGPT connectors, browsing, Python, or invented tools as a substitute for an available MCP tool.
4. Never invent tool names or required parameter values.
5. Use exact values supplied by the user for repository names, owners, paths, refs, and other identifiers.
6. After emitting a function call, wait for the extension-provided function result before continuing.
7. Never fabricate a function result.
8. Do not put function-call JSONL in reasoning/thoughts. Put it only in the final response when invoking a tool.
9. If the only exposed tool is an access-request tool, use it first ONLY when the user has explicitly asked for a repository/GitHub action that requires reading repository content. Do not claim repository access until approval has actually been granted.
10. NEVER request Code Review access merely because these MCP instructions were inserted, attached, opened, refreshed, or are the only content in the user's message. The instructions themselves are configuration, not a repository task.
11. If the user has not asked to inspect/read/review/search GitHub repository content, do not call \`request_code_review_access\`; answer normally or wait for an actual repository task.
12. If an access request is pending, tell the user only that approval is required and wait; do not emit repository-read calls until the tool list changes after approval.
13. If a listed tool says \`Parameters: none\`, emit NO \`parameter\` lines for that call. Output only the function start, optional description, and function end lines.

## Required function-call format
Output a fenced \`jsonl\` block containing one valid JSON object per line.

The template below is intentionally NOT valid JSON so MCP SuperAssistant will never execute the documentation example itself. Replace every bare placeholder with a valid JSON value before outputting a real call:

\`\`\`text
{"type":"function_call_start","name":FUNCTION_NAME_JSON_STRING,"call_id":1}
{"type":"description","text":"Short description of the requested action"}
{"type":"parameter","key":PARAMETER_NAME_JSON_STRING,"value":PARAMETER_VALUE_JSON}
{"type":"function_call_end","call_id":1}
\`\`\`

For a real call, \`FUNCTION_NAME_JSON_STRING\` must become a quoted JSON string such as \`"request_code_review_access"\`. \`PARAMETER_NAME_JSON_STRING\` must become a quoted parameter name, and \`PARAMETER_VALUE_JSON\` must become the actual JSON value. Use one \`parameter\` line for each listed parameter, and use zero \`parameter\` lines when the tool has \`Parameters: none\`. Preserve JSON types in \`value\`: strings as strings, numbers as numbers, booleans as booleans, and arrays/objects as valid JSON values. Increment \`call_id\` for each later tool call in the conversation.

## Available MCP tools

${toolList}${custom}

Invoke a tool only when the user's actual task requires it. Merely receiving or displaying these instructions is never a reason to invoke a tool. The extension handles capture and execution automatically.`;
};