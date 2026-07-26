const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
let hasErrors = false;

function reportIssue(file, line, type, description, fix) {
  hasErrors = true;
  console.log(`\x1b[31m[FAIL] ${type}\x1b[0m`);
  console.log(`  File:   ${file}${line ? `:${line}` : ''}`);
  console.log(`  Detail: ${description}`);
  console.log(`  Fix:    ${fix}`);
  console.log('');
}

function checkCookieParser() {
  const indexPath = path.join(rootDir, 'server', 'src', 'index.ts');
  if (!fs.existsSync(indexPath)) return;
  const content = fs.readFileSync(indexPath, 'utf8');
  if (!content.includes('cookie-parser')) {
    reportIssue(
      'server/src/index.ts', 0,
      'Missing cookie-parser',
      'Server uses req.cookies in routes/auth.ts but cookie-parser is not imported or used as middleware.',
      'Add: import cookieParser from "cookie-parser"; and app.use(cookieParser());'
    );
  }
}

function checkRefreshTokenSecret() {
  const authRoutePath = path.join(rootDir, 'server', 'src', 'routes', 'auth.ts');
  if (!fs.existsSync(authRoutePath)) return;
  const content = fs.readFileSync(authRoutePath, 'utf8');
  if (content.includes('verifyToken(token)') && content.includes('authRouter.post("/refresh"')) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('verifyToken') && lines[i].includes('refresh')) {
        reportIssue(
          'server/src/routes/auth.ts', i + 1,
          'Wrong JWT verification for refresh token',
          'Refresh token is signed with JWT_REFRESH_SECRET but verified with JWT_SECRET (verifyToken).',
          'Use a dedicated verifyRefreshToken function that checks against JWT_REFRESH_SECRET.'
        );
      }
    }
  }
}

function checkLeakedApiKeys() {
  const testFiles = [
    path.join(rootDir, 'server', 'test-vision.mjs'),
  ];
  for (const file of testFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const apiKeyPattern = /sk-[a-zA-Z0-9_-]{20,}|nvapi-[a-zA-Z0-9_-]{20,}|gsk_[a-zA-Z0-9_-]{20,}/g;
    const match = content.match(apiKeyPattern);
    if (match && !content.includes('process.env')) {
      reportIssue(
        path.relative(rootDir, file), 0,
        'Leaked API key in test file',
        `Found ${match.length} live API key(s) hardcoded in test file.`,
        'Replace with process.env.VARIABLE_NAME or a placeholder string.'
      );
    }
  }
}

function checkMqttReconnect() {
  const brokerPath = path.join(rootDir, 'server', 'src', 'mqttBroker.ts');
  if (!fs.existsSync(brokerPath)) return;
  const content = fs.readFileSync(brokerPath, 'utf8');
  if (content.includes('reconnectPeriod') && content.includes('close') && content.includes('startMqttBroker')) {
    // Check that reconnectPeriod is set to 0 when manual reconnect is used
    if (!content.includes('reconnectPeriod: 0')) {
      reportIssue(
        'server/src/mqttBroker.ts', 0,
        'MQTT duplicate reconnection risk',
        'Manual reconnection in close() handler + mqtt.js default auto-reconnect (1s) cause duplicate connections.',
        'Set reconnectPeriod: 0 in mqtt.connect() options when handling reconnection manually.'
      );
    }
  }
}

function checkHardcodedWifiCredentials() {
  const firmwareFiles = [
    path.join(rootDir, 'esp32', 'firmware', 'firmware.ino'),
    path.join(rootDir, 'firmware', 'esp32', 'zcare_pillbox', 'zcare_pillbox.ino'),
  ];
  for (const file of firmwareFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('WE_3D2278') || content.includes('233d2278')) {
      reportIssue(
        path.relative(rootDir, file), 0,
        'Hardcoded WiFi credentials in firmware',
        'Firmware contains hardcoded SSID and password (WE_3D2278 / 233d2278).',
        'Replace with placeholder values and document as configurable constants.'
      );
    }
  }
}

function checkFirmwareDoseMedicationId() {
  const firmwarePath = path.join(rootDir, 'esp32', 'firmware', 'firmware.ino');
  if (!fs.existsSync(firmwarePath)) return;
  const content = fs.readFileSync(firmwarePath, 'utf8');
  // publishDose should use a variable (not a string literal) for medicationId
  const lines = content.split('\n');
  let inPublishDose = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('void publishDose()')) { inPublishDose = true; continue; }
    if (inPublishDose && lines[i].includes('}') && !lines[i].includes('{')) { inPublishDose = false; continue; }
    if (inPublishDose && lines[i].includes('"medicationId"') && lines[i].includes('"hand-triggered"')) {
      reportIssue(
        'esp32/firmware/firmware.ino', i + 1,
        'Hardcoded medicationId in publishDose',
        'ESP32 firmware publishDose() sends hardcoded medicationId "hand-triggered".',
        'Store the medicationId from the dispense command and use the variable instead.'
      );
    }
  }
}

function checkBridgeUserIdOverwrite() {
  const hwWsPath = path.join(rootDir, 'server', 'src', 'hardwareWs.ts');
  if (!fs.existsSync(hwWsPath)) return;
  const content = fs.readFileSync(hwWsPath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('bridgeUserId = ws.userId') && lines[i].includes('refreshSchedule')) {
      // This is not an error if there's a guard check
      if (!content.includes('bridgeUserId && bridgeUserId !== ws.userId')) {
        reportIssue(
          'server/src/hardwareWs.ts', i + 1,
          'bridgeUserId hijack via web client',
          'A web client can overwrite bridgeUserId by sending refreshSchedule, hijacking the bridge for another user.',
          'Add a guard: if (bridgeUserId && bridgeUserId !== ws.userId) return;'
        );
      }
    }
  }
}

function checkPushUnsubscribe() {
  const inventoryPath = path.join(rootDir, 'client', 'src', 'screens', 'Inventory.tsx');
  if (!fs.existsSync(inventoryPath)) return;
  const content = fs.readFileSync(inventoryPath, 'utf8');
  if (content.includes('pushEnabled') && content.includes('togglePush')) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO: unsubscribe')) {
        reportIssue(
          'client/src/screens/Inventory.tsx', i + 1,
          'Incomplete toggle Push',
          'Toggle to disable push notifications only sets state without actually unsubscribing.',
          'Call unsubscribeFromPush() before setting state to false.'
        );
      }
    }
  }
}

console.log('============================================');
console.log('  Z CARE PILLBOX - PROJECT SCANNER');
console.log('============================================\n');

checkCookieParser();
checkRefreshTokenSecret();
checkLeakedApiKeys();
checkMqttReconnect();
checkHardcodedWifiCredentials();
checkFirmwareDoseMedicationId();
checkBridgeUserIdOverwrite();
checkPushUnsubscribe();

if (hasErrors) {
  console.log('\x1b[31mScan failed: Issues detected.\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32m[PASS] No issues detected! Codebase is robust and correctly configured.\x1b[0m');
  process.exit(0);
}
