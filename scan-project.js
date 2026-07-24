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

function checkServerEnv() {
  const envPath = path.join(rootDir, 'server', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('MQTT_BROKER_URL') && line.includes('broker.hivemq.com')) {
      reportIssue(
        path.relative(rootDir, envPath),
        i + 1,
        'Broken Configuration (External MQTT URL)',
        'MQTT_BROKER_URL is set to broker.hivemq.com which may fail to resolve or connect in restricted environments.',
        'Comment it out or clear it to use the local Aedes broker for local development (e.g. MQTT_BROKER_URL="").'
      );
    }
  }
}

function checkMqttBrokerCode() {
  const brokerPath = path.join(rootDir, 'server', 'src', 'mqttBroker.ts');
  if (!fs.existsSync(brokerPath)) return;
  const content = fs.readFileSync(brokerPath, 'utf8');
  
  // Check for unsafe JSON.parse of payload
  if (content.includes('JSON.parse(payload.toString())')) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('JSON.parse(payload.toString())')) {
        reportIssue(
          path.relative(rootDir, brokerPath),
          i + 1,
          'Unsafe JSON Parsing (Server MQTT)',
          'MQTT message payload is parsed directly with JSON.parse without handling raw status strings ("online" / "offline") or gracefully ignoring non-JSON payloads.',
          'Introduce a try-catch block specifically around JSON.parse with a fallback for raw status strings.'
        );
      }
    }
  }
}

function checkClientMqttCode() {
  const clientMqttPath = path.join(rootDir, 'client', 'src', 'lib', 'mqttClient.ts');
  if (!fs.existsSync(clientMqttPath)) return;
  const content = fs.readFileSync(clientMqttPath, 'utf8');
  const lines = content.split('\n');

  // Check for hardcoded HiveMQ broker
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('ws://broker.hivemq.com') && !content.includes('isLocalhost')) {
      reportIssue(
        path.relative(rootDir, clientMqttPath),
        i + 1,
        'Static External MQTT WS Endpoint (Client)',
        'MQTT_WS_URL defaults statically to HiveMQ even when running on localhost, which blocks connection in offline/local environments.',
        'Use a dynamic default (e.g. ws://localhost:8888 when window.location.hostname is localhost).'
      );
    }
  }

  // Check for direct JSON.parse in client message handler without fallback for raw status strings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('JSON.parse(') && line.includes('payload.toString()') && !content.includes('rawPayload === "online"')) {
      reportIssue(
        path.relative(rootDir, clientMqttPath),
        i + 1,
        'Unsafe JSON Parsing (Client MQTT)',
        'Client MQTT message parser discards raw status strings ("online" / "offline") if they are not valid JSON, failing to update connection state.',
        'Catch parsing errors and check if the raw payload is "online" or "offline" before discarding.'
      );
    }
  }
}

console.log('============================================');
console.log('  Z CARE PILLBOX - PROJECT SCANNER');
console.log('============================================\n');

checkServerEnv();
checkMqttBrokerCode();
checkClientMqttCode();

if (hasErrors) {
  console.log('\x1b[31mScan failed: Issues detected.\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32m[PASS] No issues detected! Codebase is robust and correctly configured.\x1b[0m');
  process.exit(0);
}
