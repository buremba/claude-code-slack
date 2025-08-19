#!/usr/bin/env bun

import { exec } from "child_process";
import { promisify } from "util";
import { unlink, writeFile, stat } from "fs/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";
import logger from "./logger";
import type { 
  ClaudeExecutionOptions, 
  ClaudeExecutionResult, 
  ProgressCallback
} from "./types";

const execAsync = promisify(exec);

const PIPE_PATH = `${process.env.RUNNER_TEMP || "/tmp"}/claude_prompt_pipe`;
const EXECUTION_FILE = `${process.env.RUNNER_TEMP || "/tmp"}/claude-execution-output.json`;
const BASE_ARGS = ["-p", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"];

function parseCustomEnvVars(claudeEnv?: string): Record<string, string> {
  if (!claudeEnv || claudeEnv.trim() === "") {
    return {};
  }

  const customEnv: Record<string, string> = {};

  // Split by lines and parse each line as KEY: VALUE
  const lines = claudeEnv.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue; // Skip empty lines and comments
    }

    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) {
      continue; // Skip lines without colons
    }

    const key = trimmedLine.substring(0, colonIndex).trim();
    const value = trimmedLine.substring(colonIndex + 1).trim();

    if (key) {
      customEnv[key] = value;
    }
  }

  return customEnv;
}

function prepareRunConfig(
  promptPath: string,
  options: ClaudeExecutionOptions,
): {
  claudeArgs: string[];
  promptPath: string;
  env: Record<string, string>;
} {
  const claudeArgs = [...BASE_ARGS];

  if (options.allowedTools) {
    claudeArgs.push("--allowedTools", options.allowedTools);
  }
  if (options.disallowedTools) {
    claudeArgs.push("--disallowedTools", options.disallowedTools);
  }
  if (options.maxTurns) {
    const maxTurnsNum = parseInt(options.maxTurns, 10);
    if (isNaN(maxTurnsNum) || maxTurnsNum <= 0) {
      throw new Error(
        `maxTurns must be a positive number, got: ${options.maxTurns}`,
      );
    }
    claudeArgs.push("--max-turns", options.maxTurns);
  }
  if (options.mcpConfig) {
    claudeArgs.push("--mcp-config", options.mcpConfig);
  }
  if (options.systemPrompt) {
    claudeArgs.push("--system-prompt", options.systemPrompt);
  }
  if (options.appendSystemPrompt) {
    claudeArgs.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.fallbackModel) {
    claudeArgs.push("--fallback-model", options.fallbackModel);
  }
  if (options.model) {
    claudeArgs.push("--model", options.model);
  }
  if (options.timeoutMinutes) {
    const timeoutMinutesNum = parseInt(options.timeoutMinutes, 10);
    if (isNaN(timeoutMinutesNum) || timeoutMinutesNum <= 0) {
      throw new Error(
        `timeoutMinutes must be a positive number, got: ${options.timeoutMinutes}`,
      );
    }
  }

  // Parse custom environment variables
  const customEnv = parseCustomEnvVars(options.claudeEnv);

  return {
    claudeArgs,
    promptPath,
    env: customEnv,
  };
}

export async function runClaudeWithProgress(
  promptPath: string,
  options: ClaudeExecutionOptions,
  onProgress?: ProgressCallback,
  workingDirectory?: string
): Promise<ClaudeExecutionResult> {
  const config = prepareRunConfig(promptPath, options);

  // Create a named pipe
  try {
    await unlink(PIPE_PATH);
  } catch (e) {
    // Ignore if file doesn't exist
  }

  // Create the named pipe
  await execAsync(`mkfifo "${PIPE_PATH}"`);

  // Log prompt file size
  let promptSize = "unknown";
  try {
    const stats = await stat(config.promptPath);
    promptSize = stats.size.toString();
  } catch (e) {
    // Ignore error
  }

  logger.info(`Prompt file size: ${promptSize} bytes`);

  // Log custom environment variables if any
  if (Object.keys(config.env).length > 0) {
    const envKeys = Object.keys(config.env).join(", ");
    logger.info(`Custom environment variables: ${envKeys}`);
  }

  // Output to console
  logger.info(`Running Claude with prompt from file: ${config.promptPath}`);

  // Start sending prompt to pipe in background
  const catProcess = spawn("cat", [config.promptPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const pipeStream = createWriteStream(PIPE_PATH);
  catProcess.stdout.pipe(pipeStream);

  catProcess.on("error", (error) => {
    logger.error("Error reading prompt file:", error);
    pipeStream.destroy();
  });

  const claudeProcess = spawn("claude", config.claudeArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: workingDirectory || process.cwd(),
    env: {
      ...process.env,
      ...config.env,
    },
  });

  // Handle Claude process errors
  claudeProcess.on("error", (error) => {
    logger.error("Error spawning Claude process:", error);
    pipeStream.destroy();
  });

  // Capture output for parsing execution metrics
  let output = "";
  claudeProcess.stdout.on("data", async (data) => {
    const text = data.toString();

    // Try to parse as JSON and provide progress updates
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;

      try {
        // Check if this line is a JSON object
        const parsed = JSON.parse(line);
        
        // Call progress callback if provided with enhanced context
        if (onProgress) {
          await onProgress({
            type: "output",
            data: parsed,
            timestamp: Date.now(),
            context: {
              hasContent: !!parsed.content,
              messageType: parsed.type,
              isToolUse: parsed.type === "tool_use"
            }
          });
        }

        const prettyJson = JSON.stringify(parsed, null, 2);
        process.stdout.write(prettyJson + "\n");
      } catch (e) {
        // Not a JSON object, print as is
        process.stdout.write(line + "\n");
      }
    }

    output += text;
  });

  // Handle stdout errors
  claudeProcess.stdout.on("error", (error) => {
    logger.error("Error reading Claude stdout:", error);
  });

  // Pipe from named pipe to Claude
  const pipeProcess = spawn("cat", [PIPE_PATH]);
  pipeProcess.stdout.pipe(claudeProcess.stdin);

  // Handle pipe process errors
  pipeProcess.on("error", (error) => {
    logger.error("Error reading from named pipe:", error);
    claudeProcess.kill("SIGTERM");
  });

  // Wait for Claude to finish with timeout
  let timeoutMs = 10 * 60 * 1000; // Default 10 minutes
  if (options.timeoutMinutes) {
    timeoutMs = parseInt(options.timeoutMinutes, 10) * 60 * 1000;
  } else if (process.env.INPUT_TIMEOUT_MINUTES) {
    const envTimeout = parseInt(process.env.INPUT_TIMEOUT_MINUTES, 10);
    if (isNaN(envTimeout) || envTimeout <= 0) {
      throw new Error(
        `INPUT_TIMEOUT_MINUTES must be a positive number, got: ${process.env.INPUT_TIMEOUT_MINUTES}`,
      );
    }
    timeoutMs = envTimeout * 60 * 1000;
  }

  const exitCode = await new Promise<number>((resolve) => {
    let resolved = false;

    // Set a timeout for the process
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        logger.error(
          `Claude process timed out after ${timeoutMs / 1000} seconds`,
        );
        claudeProcess.kill("SIGTERM");
        // Give it 5 seconds to terminate gracefully, then force kill
        setTimeout(() => {
          try {
            claudeProcess.kill("SIGKILL");
          } catch (e) {
            // Process may already be dead
          }
        }, 5000);
        resolved = true;
        resolve(124); // Standard timeout exit code
      }
    }, timeoutMs);

    claudeProcess.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timeoutId);
        resolved = true;
        resolve(code || 0);
      }
    });

    claudeProcess.on("error", (error) => {
      if (!resolved) {
        logger.error("Claude process error:", error);
        clearTimeout(timeoutId);
        resolved = true;
        resolve(1);
      }
    });
  });

  // Clean up processes
  try {
    catProcess.kill("SIGTERM");
  } catch (e) {
    // Process may already be dead
  }
  try {
    pipeProcess.kill("SIGTERM");
  } catch (e) {
    // Process may already be dead
  }

  // Clean up pipe file
  try {
    await unlink(PIPE_PATH);
  } catch (e) {
    // Ignore errors during cleanup
  }

  let executionFile: string | undefined;

  // Process the output and save execution metrics
  if (exitCode === 0) {
    try {
      await writeFile("output.txt", output);

      // Process output.txt into JSON and save to execution file
      const { stdout: jsonOutput } = await execAsync("jq -s '.' output.txt");
      await writeFile(EXECUTION_FILE, jsonOutput);
      executionFile = EXECUTION_FILE;

      logger.info(`Log saved to ${EXECUTION_FILE}`);

      // Call completion callback with enhanced context
      if (onProgress) {
        await onProgress({
          type: "completion",
          data: { 
            success: true, 
            exitCode, 
            executionFile,
            hasOutput: !!output && output.trim().length > 0,
            outputLength: output.length
          },
          timestamp: Date.now(),
          context: {
            executionComplete: true,
            outputAvailable: !!output
          }
        });
      }
    } catch (e) {
      logger.warn(`Failed to process output for execution metrics: ${e}`);
    }

    return {
      success: true,
      exitCode,
      output,
      executionFile,
    };
  } else {
    // Still try to save execution file if we have output
    if (output) {
      try {
        await writeFile("output.txt", output);
        const { stdout: jsonOutput } = await execAsync("jq -s '.' output.txt");
        await writeFile(EXECUTION_FILE, jsonOutput);
        executionFile = EXECUTION_FILE;
      } catch (e) {
        // Ignore errors when processing output during failure
      }
    }

    const error = `Claude process exited with code ${exitCode}`;
    
    // Call error callback with enhanced context
    if (onProgress) {
      await onProgress({
        type: "error",
        data: { 
          error, 
          exitCode,
          hasOutput: !!output && output.trim().length > 0,
          outputLength: output?.length || 0
        },
        timestamp: Date.now(),
        context: {
          executionFailed: true,
          outputAvailable: !!output
        }
      });
    }

    return {
      success: false,
      exitCode,
      output,
      executionFile,
      error,
    };
  }
}