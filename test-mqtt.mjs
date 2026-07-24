// Test MQTT WebSocket connection to local aedes broker
import mqtt from "mqtt";

const url = "ws://localhost:8888";
console.log(`Connecting to ${url}...`);

const client = mqtt.connect(url, {
  clientId: `test-${Math.random().toString(16).slice(2)}`,
  connectTimeout: 5000,
  reconnectPeriod: 0,
});

client.on("connect", () => {
  console.log("CONNECTED!");
  client.subscribe("pillbox/test");
  client.end();
  process.exit(0);
});

client.on("error", (err) => {
  console.log("ERROR:", err.message);
  process.exit(1);
});

client.on("close", () => {
  console.log("CLOSED (no connect)");
  process.exit(1);
});

setTimeout(() => {
  console.log("TIMEOUT - no connection");
  process.exit(1);
}, 10000);
