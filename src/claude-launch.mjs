// A review needs file-reading capabilities, not a shell prefix allowlist.
// `git diff --output` can write, and --tools alone does not remove MCP tools.
export const CLAUDE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

// A headless Claude is held open on stream-json so a note can reach it while
// it works: user messages in, one per line, and every event out. Its stdin is
// the conversation, so nothing may prompt for permission: there is no one to
// answer, on either branch. Flags checked on Claude Code 2.1.290 (`claude --help`)
// and read again in the 2.1.310 bundle.
export function headlessClaudeArgs({ allowWrites = false, allowCommands = false, resumeThreadId, model } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages'];
  if (model) args.push('--model', model);
  if (resumeThreadId) args.push('--resume', resumeThreadId);
  if (allowWrites && allowCommands) {
    // Commands too, under the operator's launch wrapper (the engine refuses
    // allowCommands without one): bypassPermissions is the mode in which
    // nothing prompts and Bash runs. Still no MCP servers of the user's.
    args.push('--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }));
  } else if (allowWrites) {
    // A delegated peer edits the tree. It still has no business inheriting the
    // user's MCP servers, which is where the reverse bridge would come from.
    args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }));
  } else {
    args.push(
      '--safe-mode', '--restricted',
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--tools', CLAUDE_REVIEW_TOOLS.join(','),
      '--disallowedTools', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit',
    );
  }
  // Current registered name and the legacy alias, for both launch modes.
  args.push('--disallowedTools', 'mcp__magi', 'mcp__codex');
  return args;
}
