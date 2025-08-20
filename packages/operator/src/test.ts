// Simple test to validate the operator structure
import { ClaudeSession } from "./types/claude-session";
import { claudeSessionCRD } from "./crds/claude-session-crd";

// Test CRD structure
const testCRD = claudeSessionCRD;
console.log("CRD Name:", testCRD.metadata.name);
console.log("CRD Group:", testCRD.spec.group);

// Test ClaudeSession type
const testSession: ClaudeSession = {
  apiVersion: "claude.ai/v1",
  kind: "ClaudeSession",
  metadata: {
    name: "test-session",
    namespace: "test"
  },
  spec: {
    sessionKey: "test-key",
    userId: "U123456",
    username: "testuser",
    channelId: "C123456",
    repositoryUrl: "https://github.com/test/repo",
    userPrompt: "SGVsbG8gd29ybGQ=", // "Hello world" base64
    slackResponseChannel: "C123456",
    slackResponseTs: "1234567890.123456",
    claudeOptions: "{\"model\": \"claude-3-sonnet\"}"
  }
};

console.log("Test session created:", testSession.metadata.name);
console.log("✅ TypeScript types and imports working correctly");