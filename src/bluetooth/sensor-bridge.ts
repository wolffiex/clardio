/**
 * Bluetooth Sensor Bridge for Clardio
 *
 * Connects to BLE devices and POSTs sensor data to the server.
 *
 * Run with:
 *   sudo bun run sensors
 *
 * The bridge will automatically:
 *   - Find the Realtek USB dongle (which can move between hci indices)
 *   - Ensure the Bluetooth service is running
 *   - Retry on adapter failures
 *
 * Note: Requires root/sudo for BLE scanning.
 */

import { execSync } from "child_process";

// ============================================================================
// Bluetooth Adapter Detection
// ============================================================================

/**
 * Find the Realtek USB Bluetooth dongle by parsing hciconfig output.
 * The dongle can appear at different indices (hci0, hci1, hci2, etc.)
 * depending on boot order and USB resets.
 */
function findRealtekAdapter(): number | null {
  try {
    const output = execSync("hciconfig -a", { encoding: "utf-8" });
    const blocks = output.split(/^(hci\d+):/m).slice(1);

    for (let i = 0; i < blocks.length; i += 2) {
      const hciName = blocks[i];
      const hciInfo = blocks[i + 1] || "";

      // Look for Realtek manufacturer (93)
      if (hciName && hciInfo.includes("Manufacturer: Realtek")) {
        const match = hciName.match(/hci(\d+)/);
        if (match && match[1]) {
          return parseInt(match[1], 10);
        }
      }
    }
  } catch (err) {
    console.error("[BLE] Failed to run hciconfig:", err);
  }
  return null;
}

/**
 * Check if the Bluetooth service is running and start it if not.
 */
function ensureBluetoothService(): boolean {
  try {
    const status = execSync("systemctl is-active bluetooth", {
      encoding: "utf-8",
    }).trim();
    if (status === "active") {
      return true;
    }
  } catch {
    // Service not active
  }

  console.log("[BLE] Bluetooth service not running, attempting to start...");
  try {
    execSync("systemctl start bluetooth", { encoding: "utf-8" });
    // Give it a moment to initialize
    execSync("sleep 1");
    console.log("[BLE] Bluetooth service started");
    return true;
  } catch (err) {
    console.error("[BLE] Failed to start Bluetooth service:", err);
    return false;
  }
}

/**
 * Bring up an HCI adapter if it's down.
 */
function ensureAdapterUp(hciIndex: number): boolean {
  try {
    const output = execSync(`hciconfig hci${hciIndex}`, { encoding: "utf-8" });
    if (output.includes("DOWN")) {
      console.log(`[BLE] Adapter hci${hciIndex} is DOWN, bringing it up...`);
      execSync(`hciconfig hci${hciIndex} up`);
      console.log(`[BLE] Adapter hci${hciIndex} is now UP`);
    }
    return true;
  } catch (err) {
    console.error(`[BLE] Failed to bring up hci${hciIndex}:`, err);
    return false;
  }
}

/**
 * Initialize Bluetooth: find adapter, ensure service running, bring adapter up.
 * Returns the HCI index to use, or null if initialization failed.
 */
function initializeBluetooth(): number | null {
  // First ensure the Bluetooth service is running
  if (!ensureBluetoothService()) {
    console.error("[BLE] Cannot proceed without Bluetooth service");
    return null;
  }

  // Check if user specified an adapter
  if (process.env.NOBLE_HCI_DEVICE_ID) {
    const specified = parseInt(process.env.NOBLE_HCI_DEVICE_ID, 10);
    console.log(`[BLE] Using user-specified adapter: hci${specified}`);
    ensureAdapterUp(specified);
    return specified;
  }

  // Auto-detect Realtek adapter
  const realtekIndex = findRealtekAdapter();
  if (realtekIndex !== null) {
    console.log(`[BLE] Found Realtek USB dongle at hci${realtekIndex}`);
    ensureAdapterUp(realtekIndex);
    return realtekIndex;
  }

  // Fallback: try to find any UP adapter
  console.warn("[BLE] Realtek adapter not found, looking for any available adapter...");
  try {
    const output = execSync("hciconfig", { encoding: "utf-8" });
    const match = output.match(/^(hci\d+):.*\n\s+.*UP/m);
    if (match && match[1]) {
      const idx = parseInt(match[1].replace("hci", ""), 10);
      console.log(`[BLE] Using fallback adapter: hci${idx}`);
      return idx;
    }
  } catch {
    // Ignore
  }

  console.error("[BLE] No Bluetooth adapter found!");
  return null;
}

// Initialize and set the HCI device before importing noble
const hciIndex = initializeBluetooth();
if (hciIndex === null) {
  console.error("[BLE] Bluetooth initialization failed. Exiting.");
  process.exit(1);
}
process.env.NOBLE_HCI_DEVICE_ID = String(hciIndex);

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
        console.error(`[BLE] Failed to connect to ${deviceName}:`, error);
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
            console.error(`[BLE] Discovery error for ${deviceName}:`, error);
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

/**
 * Attempt to recover from Bluetooth adapter failure.
 * Tries to restart the service, find the adapter, and reset noble.
 */
function attemptRecovery(): void {
  console.log("[BLE] Attempting Bluetooth recovery...");

  // Ensure the service is running
  if (!ensureBluetoothService()) {
    console.error("[BLE] Recovery failed: could not start Bluetooth service");
    console.log(`[BLE] Will retry in ${CONFIG.reconnectDelay / 1000}s...`);
    setTimeout(attemptRecovery, CONFIG.reconnectDelay);
    return;
  }

  // Find the adapter (it may have changed index)
  const newIndex = findRealtekAdapter();
  if (newIndex === null) {
    console.error("[BLE] Recovery failed: could not find Realtek adapter");
    console.log("[BLE] Try running: sudo usbreset \"2357:0604\"");
    console.log(`[BLE] Will retry in ${CONFIG.reconnectDelay / 1000}s...`);
    setTimeout(attemptRecovery, CONFIG.reconnectDelay);
    return;
  }

  // Bring the adapter up
  if (!ensureAdapterUp(newIndex)) {
    console.error("[BLE] Recovery failed: could not bring adapter up");
    console.log(`[BLE] Will retry in ${CONFIG.reconnectDelay / 1000}s...`);
    setTimeout(attemptRecovery, CONFIG.reconnectDelay);
    return;
  }

  // Check if the adapter index changed
  const currentIndex = parseInt(process.env.NOBLE_HCI_DEVICE_ID || "0", 10);
  if (newIndex !== currentIndex) {
    console.log(`[BLE] Adapter moved from hci${currentIndex} to hci${newIndex}`);
    console.log("[BLE] NOTE: Noble cannot switch adapters at runtime.");
    console.log("[BLE] Restarting the sensor bridge is recommended.");
    // We'll try anyway - noble might pick it up if it re-initializes
    process.env.NOBLE_HCI_DEVICE_ID = String(newIndex);
  }

  console.log("[BLE] Recovery complete - noble should detect the adapter");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Clardio Bluetooth Sensor Bridge");
  console.log("=".repeat(60));
  console.log(`Using adapter: hci${process.env.NOBLE_HCI_DEVICE_ID}`);
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
    } else if (newState === "poweredOff") {
      noble.stopScanning();
      console.log("[BLE] Adapter powered off - attempting recovery...");

      // Clear connection state
      state.connected.gymnasticon = false;
      state.connected.corosPace3 = false;
      peripherals.clear();

      // Try to recover
      setTimeout(() => {
        attemptRecovery();
      }, CONFIG.reconnectDelay);
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
