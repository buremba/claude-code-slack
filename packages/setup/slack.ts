#!/usr/bin/env node
// @ts-nocheck

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { exec } from 'child_process';
import * as os from 'os';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function copyToClipboard(content) {
  const commands = {
    darwin: 'pbcopy',
    linux: 'xclip -selection clipboard',
    win32: 'clip',
  };

  const command = commands[process.platform];
  if (!command) return false;

  return new Promise((resolve) => {
    exec(`echo '${content.replace(/'/g, "'\\''")}' | ${command}`, (error) => {
      resolve(!error);
    });
  });
}

function checkSlackCLI() {
  return new Promise((resolve) => {
    exec('slack --version', (error) => resolve(!error));
  });
}

function runSlackCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject({ error, stderr });
      else resolve(stdout);
    });
  });
}

function generateBotName() {
  const { username } = os.userInfo();
  const hostname = os.hostname().replace(/\.(local|lan)$/, '');

  // Create a clean, personalized name
  const cleanHostname =
    hostname.includes('MacBook') || hostname.includes('iMac') || hostname.includes('Mac-')
      ? `${username}s-Mac`
      : hostname;

  return `PeerBot-${cleanHostname}`;
}

async function main() {
  console.clear();
  console.log('🤖 PeerBot Slack Setup\n');

  // Load manifest
  const manifestPath = path.join(path.dirname(path.dirname(__dirname)), 'slack-app-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('❌ slack-app-manifest.json not found!');
    console.log(`Looking in: ${manifestPath}`);
    process.exit(1);
  }

  // Generate bot name
  const defaultBotName = generateBotName();
  console.log(`🏷️  Suggested bot name: ${defaultBotName}`);

  const customName = await ask('Custom name (press Enter to use suggested): ');
  const botName = customName.trim() || defaultBotName;
  console.log(`✅ Using bot name: ${botName}\n`);

  // Check Slack CLI
  const hasSlackCLI = await checkSlackCLI();

  if (hasSlackCLI) {
    console.log('✅ Slack CLI found');
    const useCLI = await ask('Create app automatically? (Y/n): ');

    if (useCLI.toLowerCase() !== 'n') {
      try {
        console.log('\n🚀 Creating app...');
        await runSlackCommand(`slack create ${botName} --manifest ${manifestPath}`);
        console.log('✅ App created! Get tokens from Slack dashboard and update .env');
        rl.close();
        return;
      } catch (error) {
        console.log('❌ CLI failed, using manual setup...\n');
      }
    }
  }

  // Manual setup
  console.log(hasSlackCLI ? '\n📋 Manual setup:' : '📋 Manual setup (no Slack CLI):');

  // Create personalized manifest
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.display_information.name = botName;
  manifest.features.bot_user.display_name = botName;

  const manifestJson = JSON.stringify(manifest, null, 2);

  // Create direct Slack app creation link with embedded manifest
  const manifestJsonForUrl = JSON.stringify(manifest);
  const encodedManifest = encodeURIComponent(manifestJsonForUrl);
  const directCreateUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodedManifest}`;

  // Show manifest preview
  const manifestLines = manifestJson.split('\n');
  const preview = manifestLines.slice(0, 10).join('\n');
  console.log('\n📄 Manifest preview:');
  console.log(preview);
  console.log(`... (${manifestLines.length - 10} more lines)\n`);

  console.log('\n🔗 Easy Setup:');
  console.log('1. Click this direct link to create your Slack app:');
  console.log(`   ${directCreateUrl}`);
  console.log('2. Review the manifest and click "Create App"');
  console.log('3. Copy the App ID from the URL or Basic Information page');

  // Fallback for copy/paste method
  const copied = await copyToClipboard(manifestJson);
  console.log('\n📋 Alternative (copy/paste method):');
  console.log('1. Go to: https://api.slack.com/apps?new_app=1');
  console.log('2. Select "From an app manifest"');
  console.log('3. Paste the manifest below and create app');

  if (copied) {
    console.log('✅ Manifest copied to clipboard for fallback');
  } else {
    console.log('📋 Manifest to copy:\n');
    console.log(manifestJson);
  }

  const appId = await ask('\nApp ID (e.g., A01234567): ');

  if (!appId.trim()) {
    console.log('❌ App ID is required');
    process.exit(1);
  }

  // Get tokens with dynamic URLs
  console.log(`\n📋 Go to: https://api.slack.com/apps/${appId}/general`);
  console.log("   On this page you'll find:\n");
  console.log('   1️⃣ Signing Secret (in App Credentials section)');
  const signingSecret = await ask('Signing Secret: ');

  console.log('\n   2️⃣ App-Level Tokens (scroll down)');
  console.log('      → Click "Generate Token and Scopes"');
  console.log('      → Give it a name (e.g., "peerbot-mode")');
  console.log('      → Add scope: connections:write');
  console.log('      → Click "Generate"');
  const appToken = await ask('App-Level Token (xapp-...): ');

  console.log(
    `\n📋 Install to Peerbot and get your Bot Token from: https://api.slack.com/apps/${appId}/oauth`,
  );
  const botToken = await ask('Bot User OAuth Token (xoxb-...): ');

  // Create .env content
  const envContent = `# Slack App Configuration
SLACK_BOT_TOKEN=${botToken}
SLACK_APP_TOKEN=${appToken}
SLACK_SIGNING_SECRET=${signingSecret}

# Claude Code Configuration
# ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
`;

  // Display masked values
  console.log('\n📋 Your configuration:');
  console.log(
    `SLACK_BOT_TOKEN=${botToken.substring(0, 10)}...${botToken.substring(botToken.length - 4)}`,
  );
  console.log(
    `SLACK_APP_TOKEN=${appToken.substring(0, 10)}...${appToken.substring(appToken.length - 4)}`,
  );
  console.log(
    `SLACK_SIGNING_SECRET=${signingSecret.substring(0, 4)}...${signingSecret.substring(signingSecret.length - 4)}`,
  );

  // Copy to clipboard
  const envCopied = await copyToClipboard(envContent);

  if (envCopied) {
    console.log('\n✅ Configuration copied to clipboard!');
  } else {
    console.log('\n📋 Copy this configuration:');
    console.log(envContent);
  }

  console.log(
    '\n⚠️  Important: Create a .env.local file in the current directory and paste the configuration.',
  );
  console.log('   The bot will automatically load .env.local if it exists.');

  console.log('\n🎉 Setup complete!');
  console.log('\nNext steps:');
  console.log('1. Create .env.local file and paste the configuration');
  console.log("2. Add Anthropic API key to .env.local (optional if you don't have subscription)");
  console.log('3. Run: peerbot run slack');
  console.log('4. Add bot to Slack channel');
  console.log('5. Set working directory: cwd /path/to/project');

  rl.close();
}

export { main };

// For CLI compatibility
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}