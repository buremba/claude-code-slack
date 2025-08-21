#!/usr/bin/env bun

interface ClaudeMessage {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ type: string; text?: string }> | string;
    [key: string]: any;
  } | string;
  content?: string;
  name?: string;
  parameters?: Record<string, any>;
  [key: string]: any;
}

/**
 * Parse Claude's JSON stream output and extract user-friendly content
 * @param rawOutput - The raw JSON stream output from Claude
 * @returns Formatted markdown content
 */
export function parseClaudeOutput(rawOutput: string): string {
  if (!rawOutput || rawOutput.trim() === "") {
    return "_No response from Claude_";
  }

  const lines = rawOutput.split("\n").filter(line => line.trim() !== "");
  const messages: string[] = [];
  let hasContent = false;

  for (const line of lines) {
    try {
      const parsed: ClaudeMessage = JSON.parse(line);
      
      // Skip system messages and init messages
      if (parsed.type === "system" && parsed.subtype === "init") {
        continue;
      }

      // Extract user-facing content
      if (parsed.type === "assistant" && parsed.message && typeof parsed.message === 'object' && 'content' in parsed.message) {
        // Handle the content array structure from assistant messages
        const content = parsed.message.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text" && item.text) {
              messages.push(item.text);
              hasContent = true;
            }
          }
        }
      } else if (parsed.type === "text" && parsed.content) {
        messages.push(parsed.content);
        hasContent = true;
      } else if (parsed.type === "message" && parsed.message) {
        messages.push(typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message));
        hasContent = true;
      } else if (parsed.type === "tool_use" && parsed.name) {
        // Format tool usage in a user-friendly way
        const toolMessage = formatToolUse(parsed);
        if (toolMessage) {
          messages.push(toolMessage);
          hasContent = true;
        }
      } else if (parsed.type === "error" && parsed.message) {
        messages.push(`⚠️ **Error:** ${typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message)}`);
        hasContent = true;
      }
    } catch (e) {
      // If it's not JSON, it might be plain text output
      if (line.trim() && !line.startsWith("{")) {
        messages.push(line);
        hasContent = true;
      }
    }
  }

  if (!hasContent) {
    return "_Claude completed the task without generating a text response_";
  }

  return messages.join("\n\n");
}

/**
 * Format tool usage messages in a user-friendly way
 */
function formatToolUse(toolUse: ClaudeMessage): string | null {
  const toolName = toolUse.name || "Unknown Tool";
  
  // Map technical tool names to user-friendly descriptions
  const toolDescriptions: Record<string, string> = {
    "Bash": "Running command",
    "Read": "Reading file",
    "Write": "Writing file",
    "Edit": "Editing file",
    "MultiEdit": "Making multiple edits",
    "Grep": "Searching files",
    "Glob": "Finding files",
    "LS": "Listing directory",
    "Task": "Running task",
    "TodoWrite": "Updating task list",
    "WebSearch": "Searching the web",
    "WebFetch": "Fetching web content",
    "NotebookEdit": "Editing notebook",
    "ExitPlanMode": "Completing planning phase"
  };

  const description = toolDescriptions[toolName] || toolName;
  
  // Extract relevant parameters for user-friendly display
  if (toolUse.parameters) {
    switch (toolName) {
      case "Bash":
        if (toolUse.parameters?.command) {
          return `🔧 **${description}:** \`${toolUse.parameters.command}\``;
        }
        break;
      case "Read":
        if (toolUse.parameters?.file_path) {
          return `📖 **${description}:** ${toolUse.parameters.file_path}`;
        }
        break;
      case "Write":
      case "Edit":
        if (toolUse.parameters?.file_path) {
          return `✏️ **${description}:** ${toolUse.parameters.file_path}`;
        }
        break;
      case "Grep":
        if (toolUse.parameters?.pattern) {
          return `🔍 **${description}:** "${toolUse.parameters.pattern}"`;
        }
        break;
      default:
        // For other tools, just show the action
        return `🔧 **${description}**`;
    }
  }

  return null;
}

/**
 * Extract just the final text response from Claude (excluding tool usage)
 */
export function extractFinalResponse(rawOutput: string | undefined): string {
  if (!rawOutput || rawOutput.trim() === "") {
    return "";
  }

  const lines = rawOutput.split("\n").filter(line => line.trim() !== "");
  let lastAssistantMessage = "";

  // Process lines to find assistant messages
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed: ClaudeMessage = JSON.parse(line);
      
      // Extract text content from assistant messages
      if (parsed.type === "assistant" && parsed.message && typeof parsed.message === 'object' && 'content' in parsed.message) {
        // Handle the content array structure
        const content = parsed.message.content;
        if (Array.isArray(content)) {
          const assistantTexts: string[] = [];
          for (const item of content) {
            if (item.type === "text" && item.text) {
              assistantTexts.push(item.text);
            }
          }
          if (assistantTexts.length > 0) {
            lastAssistantMessage = assistantTexts.join("\n\n");
          }
        }
      } else if (parsed.type === "text" && parsed.content) {
        // Track text messages as potential last response
        lastAssistantMessage = parsed.content;
      }
    } catch (e) {
      // If it's not JSON but looks like meaningful text, consider it
      if (line.trim() && !line.startsWith("{") && line.length > 10) {
        lastAssistantMessage = line;
      }
    }
  }

  // Return the last assistant message we found
  return lastAssistantMessage;
}