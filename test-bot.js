#!/usr/bin/env node

const https = require('https');
const path = require('path');

// Load QA credentials to send as PeerQA
console.log('🔧 Loading test configuration...');
require('dotenv').config({ path: path.join(__dirname, '.env.qa') });
const QA_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function makeSlackRequest(method, body) {
  return new Promise((resolve, reject) => {
    const needsUrlEncoding = ['conversations.info', 'conversations.history'].includes(method);
    const postData = needsUrlEncoding 
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
    
    const options = {
      hostname: 'slack.com',
      port: 443,
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${QA_BOT_TOKEN}`,
        'Content-Type': needsUrlEncoding ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            resolve(result);
          } else {
            reject(new Error(`Slack API error: ${result.error}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function waitForBotResponse(channel, afterTimestamp, timeout = 30000) {
  console.log('⏳ Waiting for bot response...');
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const history = await makeSlackRequest('conversations.history', {
        channel: channel,
        oldest: afterTimestamp,
        limit: 10
      });
      
      // Look for bot messages
      const botMessages = history.messages.filter(msg => 
        msg.bot_id || // any bot message
        (msg.user && msg.user === 'U097WU1GMLJ') // PeerCloud bot user ID
      );
      
      if (botMessages.length > 0) {
        return botMessages;
      }
    } catch (error) {
      // Ignore rate limit errors and continue waiting
    }
    
    // Wait 2 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return null;
}

async function checkForReaction(channel, timestamp, reactionName, timeout = 30000) {
  console.log(`⏳ Checking for ${reactionName} reaction...`);
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const result = await makeSlackRequest('reactions.get', {
        channel: channel,
        timestamp: timestamp
      });
      
      if (result.message && result.message.reactions) {
        const reaction = result.message.reactions.find(r => r.name === reactionName);
        if (reaction) {
          return true;
        }
      }
    } catch (error) {
      // Message might not exist yet or no reactions
    }
    
    // Wait 2 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return false;
}

async function runTest(prompt) {
  console.log('🧪 Peerbot Test');
  console.log('📤 Sending as: PeerQA');
  console.log('🎯 Target: @peercloud (U097WU1GMLJ)\n');
  
  const targetChannel = 'C0952LTF7DG'; // #peerbot-qa
  
  try {
    // Send test message
    console.log('📨 Sending test message...');
    const message = `<@U097WU1GMLJ> ${prompt}`;
    const msg = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: message
    });
    console.log(`✅ Sent: "${message}"`);
    console.log(`   Timestamp: ${msg.ts}\n`);
    
    // Wait a bit for the bot to start processing
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check for checkmark reaction on original message
    const hasCheckmark = await checkForReaction(targetChannel, msg.ts, 'white_check_mark');
    
    // Wait for response message
    const response = await waitForBotResponse(targetChannel, msg.ts);
    
    if (hasCheckmark && response && response.length > 0) {
      console.log('✅ Bot processed message (checkmark reaction added)');
      console.log(`✅ Bot responded with message!`);
      console.log(`   Response: "${response[0].text?.substring(0, 200)}..."`);
      
      // Check if response has blocks (for blockkit)
      if (response[0].blocks && response[0].blocks.length > 0) {
        console.log(`   Blocks: ${response[0].blocks.length} blocks found`);
        const actionBlocks = response[0].blocks.filter(b => b.type === 'actions');
        if (actionBlocks.length > 0) {
          console.log(`   ✨ Found ${actionBlocks.length} action block(s) with buttons!`);
        }
      }
      
      console.log('\n🎉 Test PASSED!');
    } else if (hasCheckmark && !response) {
      console.log('✅ Bot processed message (checkmark reaction added)');
      console.log('⚠️  But no response message was sent');
      console.log('\n⚠️  Test PARTIALLY PASSED');
    } else if (!hasCheckmark) {
      console.log('❌ No checkmark reaction - bot may not have processed the message');
      console.log('\nTroubleshooting:');
      console.log('1. Check worker pods: kubectl get pods -n peerbot | grep claude-worker');
      console.log('2. Check dispatcher logs: kubectl logs -n peerbot -l app.kubernetes.io/component=dispatcher --tail=50');
    }
    
    console.log('\n🔗 Channel: https://peerbotcommunity.slack.com/archives/C0952LTF7DG');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
runTest('Create me a new project for my landing page of a Pet Store? It\' is a fictionary app so be creating don\'t ask me. Project name is "Pet Store {timestamp}"');
runTest('Create a button to add a new pet to the pet store');
runTest("Create 5 tasks which will each return a random number and then you will sum all them.")