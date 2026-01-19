/**
 * Bluetooth Sensor Bridge for Clardio
 *
 * Connects to BLE devices and POSTs sensor data to the server.
 *
 * Run with:
 *   sudo NOBLE_HCI_DEVICE_ID=1 npx tsx src/bluetooth/sensor-bridge.ts
 *
 * Environment variables:
 *   NOBLE_HCI_DEVICE_ID - HCI device index (default: 1 for USB dongle)
 *                         Use `hciconfig` to list available adapters
 *
 * Note: Requires root/sudo for BLE scanning. Use the USB Bluetooth dongle
 * (hci1) rather than the built-in Intel adapter (hci0) for reliable scanning.
 */

// Set default HCI device if not specified (USB dongle = hci1)
if (!process.env.NOBLE_HCI_DEVICE_ID) {
  process.env.NOBLE_HCI_DEVICE_ID = "1";
}

import noble, {
  type Peripheral,
  type Characteristic,
} from "@abandonware/noble";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Device MACs (lowercase, no colons for noble)
  devices: {
    gymnasticon: "b827eb950b90", // K2Pi - Cycling Power + Speed/Cadence
    corosPace3: "f7af40380890", // COROS PACE 3 - Heart Rate
  },

  // BLE Service UUIDs
  services: {
    heartRate: "180d",
    cyclingPower: "1818",
    cyclingSpeedCadence: "1816",
  },

  // BLE Characteristic UUIDs
  characteristics: {
    heartRateMeasurement: "2a37",
    cyclingPowerMeasurement: "2a63",
    cscMeasurement: "2a5b",
  },

  // Server endpoint
  serverUrl: "http://localhost:3000/api/metrics",

  // How often to POST metrics (ms)
  postInterval: 1000,

  // Reconnect delay (ms)
  reconnectDelay: 5000,
};

// ============================================================================
// State
// ============================================================================

interface SensorState {
  power: number;
  hr: number;
  cadence: number;
  startTime: number;
  connected: {
    gymnasticon: boolean;
    corosPace3: boolean;
  };
  // For cadence calculation from wheel revolutions
  lastCrankRevs: number | null;
  lastCrankTime: number | null;
}

const state: SensorState = {
  power: 0,
  hr: 0,
  cadence: 0,
  startTime: Date.now(),
  connected: {
    gymnasticon: false,
    corosPace3: false,
  },
  lastCrankRevs: null,
  lastCrankTime: null,
};

// Track peripherals for reconnection
const peripherals: Map<string, Peripheral> = new Map();

// ============================================================================
// BLE Data Parsing
// ============================================================================

/**
 * Parse Heart Rate Measurement characteristic (0x2A37)
 * See: https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/
 */
function parseHeartRate(data: Buffer): number {
  const flags = data.readUInt8(0);
  const is16Bit = (flags & 0x01) !== 0;

  if (is16Bit) {
    return data.readUInt16LE(1);
  } else {
    return data.readUInt8(1);
  }
}

/**
 * Parse Cycling Power Measurement characteristic (0x2A63)
 * See: https://www.bluetooth.com/specifications/specs/cycling-power-service-1-1/
 */
function parseCyclingPower(data: Buffer): number {
  // Flags are in bytes 0-1, instantaneous power is in bytes 2-3
  const power = data.readInt16LE(2);
  return Math.max(0, power);
}

/**
 * Parse CSC Measurement characteristic (0x2A5B) for cadence
 * See: https://www.bluetooth.com/specifications/specs/cycling-speed-and-cadence-service-1-0/
 */
function parseCSCMeasurement(data: Buffer): number | null {
  const flags = data.readUInt8(0);
  const hasCrankData = (flags & 0x02) !== 0;

  if (!hasCrankData) {
    return null;
  }

  // If wheel data is present, crank data starts at offset 7, otherwise offset 1
  const hasWheelData = (flags & 0x01) !== 0;
  const offset = hasWheelData ? 7 : 1;

  const crankRevs = data.readUInt16LE(offset);
  const crankTime = data.readUInt16LE(offset + 2); // 1/1024 second resolution

  // Calculate cadence from delta
  if (state.lastCrankRevs !== null && state.lastCrankTime !== null) {
    let revDelta = crankRevs - state.lastCrankRevs;
    let timeDelta = crankTime - state.lastCrankTime;

    // Handle rollover (16-bit values)
    if (revDelta < 0) revDelta += 65536;
    if (timeDelta < 0) timeDelta += 65536;

    if (timeDelta > 0) {
      // Convert to RPM: revs per (time in 1/1024 sec) * 1024 * 60
      const cadence = (revDelta / timeDelta) * 1024 * 60;
      state.lastCrankRevs = crankRevs;
      state.lastCrankTime = crankTime;
      return Math.round(cadence);
    }
  }

  state.lastCrankRevs = crankRevs;
  state.lastCrankTime = crankTime;
  return null;
}

// ============================================================================
// BLE Connection Handling
// ============================================================================

function normalizeMAC(mac: string): string {
  return mac.toLowerCase().replace(/:/g, "");
}

function getDeviceName(mac: string): string | null {
  const normalized = normalizeMAC(mac);
  if (normalized === CONFIG.devices.gymnasticon) return "Gymnasticon";
  if (normalized === CONFIG.devices.corosPace3) return "COROS PACE 3";
  return null;
}

async function subscribeToCharacteristic(
  characteristic: Characteristic,
  handler: (data: Buffer) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    characteristic.subscribe((error) => {
      if (error) {
        reject(error);
        return;
      }

      characteristic.on("data", handler);
      resolve();
    });
  });
}

async function connectAndSubscribe(peripheral: Peripheral): Promise<void> {
  const mac = normalizeMAC(peripheral.id);
  const deviceName = getDeviceName(mac) || peripheral.advertisement.localName || "Unknown";

  console.log(`[BLE] Connecting to ${deviceName}...`);

  return new Promise((resolve, reject) => {
    peripheral.connect(async (error) => {
      if (error) {
        console.error(`[BLE] Failed to connect to ${deviceName}:`, error.message);
        reject(error);
        return;
      }

      console.log(`[BLE] Connected to ${deviceName}`);

      // Update connection state
      if (mac === CONFIG.devices.gymnasticon) {
        state.connected.gymnasticon = true;
      } else if (mac === CONFIG.devices.corosPace3) {
        state.connected.corosPace3 = true;
      }

      // Handle disconnection
      peripheral.once("disconnect", () => {
        console.log(`[BLE] ${deviceName} disconnected`);

        if (mac === CONFIG.devices.gymnasticon) {
          state.connected.gymnasticon = false;
          state.power = 0;
          state.cadence = 0;
        } else if (mac === CONFIG.devices.corosPace3) {
          state.connected.corosPace3 = false;
          state.hr = 0;
        }

        // Schedule reconnection
        setTimeout(() => {
          console.log(`[BLE] Attempting to reconnect to ${deviceName}...`);
          noble.startScanning([], true);
        }, CONFIG.reconnectDelay);
      });

      // Discover services and characteristics
      peripheral.discoverAllServicesAndCharacteristics(
        async (error, services, characteristics) => {
          if (error) {
            console.error(`[BLE] Discovery error for ${deviceName}:`, error.message);
            reject(error);
            return;
          }

          console.log(`[BLE] Discovered ${characteristics?.length || 0} characteristics on ${deviceName}`);

          for (const char of characteristics || []) {
            const uuid = char.uuid.toLowerCase();

            try {
              // Heart Rate Measurement
              if (uuid === CONFIG.characteristics.heartRateMeasurement) {
                await subscribeToCharacteristic(char, (data) => {
                  state.hr = parseHeartRate(data);
                });
                console.log(`[BLE] Subscribed to Heart Rate on ${deviceName}`);
              }

              // Cycling Power Measurement
              if (uuid === CONFIG.characteristics.cyclingPowerMeasurement) {
                await subscribeToCharacteristic(char, (data) => {
                  state.power = parseCyclingPower(data);
                });
                console.log(`[BLE] Subscribed to Cycling Power on ${deviceName}`);
              }

              // CSC Measurement (Cadence)
              if (uuid === CONFIG.characteristics.cscMeasurement) {
                await subscribeToCharacteristic(char, (data) => {
                  const cadence = parseCSCMeasurement(data);
                  if (cadence !== null) {
                    state.cadence = cadence;
                  }
                });
                console.log(`[BLE] Subscribed to Cadence on ${deviceName}`);
              }
            } catch (err) {
              console.error(`[BLE] Failed to subscribe to ${uuid}:`, err);
            }
          }

          resolve();
        }
      );
    });
  });
}

// ============================================================================
// Main Loop
// ============================================================================

async function postMetrics(): Promise<void> {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

  const metrics = {
    power: state.power,
    hr: state.hr,
    cadence: state.cadence,
    elapsed,
  };

  try {
    const response = await fetch(CONFIG.serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metrics),
    });

    if (!response.ok) {
      console.error(`[HTTP] Failed to POST metrics: ${response.status}`);
    }
  } catch (err) {
    // Server might not be running - that's okay
  }
}

function logStatus(): void {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const gymnasticon = state.connected.gymnasticon ? "connected" : "disconnected";
  const coros = state.connected.corosPace3 ? "connected" : "disconnected";

  console.log(
    `[${elapsed}s] Power: ${state.power}W | HR: ${state.hr}bpm | Cadence: ${state.cadence}rpm | ` +
      `Gymnasticon: ${gymnasticon} | COROS: ${coros}`
  );
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Clardio Bluetooth Sensor Bridge");
  console.log("=".repeat(60));
  console.log(`Target devices:`);
  console.log(`  - Gymnasticon (K2Pi): ${CONFIG.devices.gymnasticon}`);
  console.log(`  - COROS PACE 3: ${CONFIG.devices.corosPace3}`);
  console.log(`POSTing to: ${CONFIG.serverUrl}`);
  console.log("=".repeat(60));

  // Handle noble state changes
  noble.on("stateChange", (newState) => {
    console.log(`[BLE] Adapter state: ${newState}`);
    if (newState === "poweredOn") {
      console.log("[BLE] Starting scan for devices...");
      noble.startScanning([], true); // Allow duplicates for reconnection
    } else {
      noble.stopScanning();
    }
  });

  // Handle discovered peripherals
  noble.on("discover", async (peripheral) => {
    const mac = normalizeMAC(peripheral.id);
    const deviceName = getDeviceName(mac);

    // Only connect to our target devices
    if (!deviceName) return;

    // Check if already connected
    if (mac === CONFIG.devices.gymnasticon && state.connected.gymnasticon) return;
    if (mac === CONFIG.devices.corosPace3 && state.connected.corosPace3) return;

    console.log(`[BLE] Found ${deviceName} (${peripheral.id})`);
    peripherals.set(mac, peripheral);

    // Stop scanning temporarily to connect
    noble.stopScanning();

    try {
      await connectAndSubscribe(peripheral);
    } catch (err) {
      console.error(`[BLE] Connection error:`, err);
    }

    // Resume scanning for other devices
    if (!state.connected.gymnasticon || !state.connected.corosPace3) {
      noble.startScanning([], true);
    }
  });

  // Start posting metrics every second
  setInterval(postMetrics, CONFIG.postInterval);

  // Log status every 5 seconds
  setInterval(logStatus, 5000);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[BLE] Shutting down...");
    noble.stopScanning();

    for (const peripheral of peripherals.values()) {
      peripheral.disconnect();
    }

    process.exit(0);
  });
}

main().catch(console.error);
