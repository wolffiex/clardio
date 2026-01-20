"""
Bluetooth Sensor Bridge for Clardio

Connects to BLE devices and POSTs sensor data to the server.

Run with:
    uv run clardio-sensors

Uses bleak for reliable BLE communication via BlueZ D-Bus API.
"""

import asyncio
import struct
import time
import subprocess
from dataclasses import dataclass, field

import aiohttp
from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice


# ============================================================================
# Configuration
# ============================================================================

# Device MACs (uppercase with colons for bleak)
DEVICES = {
    "gymnasticon": "B8:27:EB:95:0B:90",  # K2Pi - Cycling Power + Speed/Cadence
    "coros_pace_3": "F7:AF:40:38:08:90",  # COROS PACE 3 - Heart Rate
}

# BLE Characteristic UUIDs (bleak uses full UUIDs)
CHAR_HEART_RATE = "00002a37-0000-1000-8000-00805f9b34fb"
CHAR_CYCLING_POWER = "00002a63-0000-1000-8000-00805f9b34fb"
CHAR_CSC_MEASUREMENT = "00002a5b-0000-1000-8000-00805f9b34fb"

SERVER_URL = "http://localhost:3000/api/metrics"
POST_INTERVAL = 1.0  # seconds
RECONNECT_DELAY = 5.0  # seconds


# ============================================================================
# State
# ============================================================================

@dataclass
class SensorState:
    power: int = 0
    hr: int = 0
    cadence: int = 0
    connected_gymnasticon: bool = False
    connected_coros: bool = False
    # For cadence calculation
    last_crank_revs: int | None = None
    last_crank_time: int | None = None


state = SensorState()
log_start_time = time.time()  # For status logging only


# ============================================================================
# BLE Data Parsing
# ============================================================================

def parse_heart_rate(data: bytes) -> int:
    """Parse Heart Rate Measurement characteristic (0x2A37)"""
    flags = data[0]
    is_16bit = (flags & 0x01) != 0
    if is_16bit:
        return struct.unpack_from("<H", data, 1)[0]
    else:
        return data[1]


def parse_cycling_power(data: bytes) -> int:
    """Parse Cycling Power Measurement characteristic (0x2A63)"""
    # Flags in bytes 0-1, instantaneous power in bytes 2-3
    power = struct.unpack_from("<h", data, 2)[0]
    return max(0, power)


def parse_csc_measurement(data: bytes) -> int | None:
    """Parse CSC Measurement characteristic (0x2A5B) for cadence"""
    global state

    flags = data[0]
    has_crank_data = (flags & 0x02) != 0

    if not has_crank_data:
        return None

    # If wheel data present, crank data starts at offset 7, otherwise offset 1
    has_wheel_data = (flags & 0x01) != 0
    offset = 7 if has_wheel_data else 1

    crank_revs = struct.unpack_from("<H", data, offset)[0]
    crank_time = struct.unpack_from("<H", data, offset + 2)[0]  # 1/1024 sec resolution

    # Calculate cadence from delta
    if state.last_crank_revs is not None and state.last_crank_time is not None:
        rev_delta = crank_revs - state.last_crank_revs
        time_delta = crank_time - state.last_crank_time

        # Handle 16-bit rollover
        if rev_delta < 0:
            rev_delta += 65536
        if time_delta < 0:
            time_delta += 65536

        if time_delta > 0:
            # Convert to RPM: revs per (time in 1/1024 sec) * 1024 * 60
            cadence = (rev_delta / time_delta) * 1024 * 60
            state.last_crank_revs = crank_revs
            state.last_crank_time = crank_time
            return round(cadence)

    state.last_crank_revs = crank_revs
    state.last_crank_time = crank_time
    return None


# ============================================================================
# Notification Handlers
# ============================================================================

def handle_heart_rate(_sender: int, data: bytes) -> None:
    state.hr = parse_heart_rate(data)


def handle_cycling_power(_sender: int, data: bytes) -> None:
    state.power = parse_cycling_power(data)


def handle_csc_measurement(_sender: int, data: bytes) -> None:
    cadence = parse_csc_measurement(data)
    if cadence is not None:
        state.cadence = cadence


# ============================================================================
# Device Connection
# ============================================================================

async def connect_device(
    device: BLEDevice,
    name: str,
    characteristics: list[tuple[str, callable]],
) -> BleakClient | None:
    """Connect to a device and subscribe to characteristics."""
    print(f"[BLE] Connecting to {name}...")

    try:
        client = BleakClient(device)
        await client.connect()
        print(f"[BLE] Connected to {name}")

        for char_uuid, handler in characteristics:
            try:
                await client.start_notify(char_uuid, handler)
                print(f"[BLE] Subscribed to {char_uuid[-8:-4]} on {name}")
            except Exception as e:
                print(f"[BLE] Failed to subscribe to {char_uuid}: {e}")

        return client
    except Exception as e:
        print(f"[BLE] Failed to connect to {name}: {e}")
        return None


async def manage_device(
    mac: str,
    name: str,
    characteristics: list[tuple[str, callable]],
    set_connected: callable,
    device_queue: asyncio.Queue,
) -> None:
    """Manage connection to a single device, receiving devices from shared scanner."""
    while True:
        # Wait for our device to be found by the scanner
        device = await device_queue.get()

        print(f"[BLE] Found {name}")
        client = await connect_device(device, name, characteristics)

        if client is None:
            await asyncio.sleep(RECONNECT_DELAY)
            continue

        set_connected(True)

        # Wait for disconnect
        try:
            while client.is_connected:
                await asyncio.sleep(1.0)
        except Exception as e:
            print(f"[BLE] {name} connection error: {e}")

        print(f"[BLE] {name} disconnected")
        set_connected(False)

        # Reset values on disconnect
        if "gymnasticon" in name.lower():
            state.power = 0
            state.cadence = 0
        else:
            state.hr = 0


async def scan_for_devices(
    targets: dict[str, asyncio.Queue],
) -> None:
    """Single scanner that finds devices and dispatches to their queues."""
    found: set[str] = set()

    while True:
        # Figure out what we're still looking for
        needed = {mac for mac in targets.keys() if mac not in found}

        if not needed:
            # All devices connected, wait a bit then check again
            await asyncio.sleep(RECONNECT_DELAY)
            found.clear()  # Reset so we can find them again if they disconnect
            continue

        print(f"[BLE] Scanning for {len(needed)} device(s)...")

        try:
            devices = await BleakScanner.discover(timeout=10.0)

            for device in devices:
                if device.address in needed:
                    print(f"[BLE] Scanner found {device.address}")
                    found.add(device.address)
                    await targets[device.address].put(device)

        except Exception as e:
            print(f"[BLE] Scan error: {e}")

        await asyncio.sleep(1.0)  # Brief pause between scans


# ============================================================================
# Metrics Posting
# ============================================================================

async def post_metrics_loop() -> None:
    """POST metrics to the server every second."""
    async with aiohttp.ClientSession() as session:
        while True:
            metrics = {
                "power": state.power,
                "hr": state.hr,
                "cadence": state.cadence,
            }

            try:
                async with session.post(SERVER_URL, json=metrics) as resp:
                    if resp.status != 200:
                        print(f"[HTTP] Failed to POST: {resp.status}")
            except Exception:
                # Server might not be running
                pass

            await asyncio.sleep(POST_INTERVAL)


async def log_status_loop() -> None:
    """Log status every 5 seconds."""
    while True:
        await asyncio.sleep(5.0)
        elapsed = int(time.time() - log_start_time)
        gym = "connected" if state.connected_gymnasticon else "disconnected"
        coros = "connected" if state.connected_coros else "disconnected"

        print(
            f"[{elapsed}s] Power: {state.power}W | HR: {state.hr}bpm | "
            f"Cadence: {state.cadence}rpm | Gymnasticon: {gym} | COROS: {coros}"
        )


# ============================================================================
# Bluetooth Service Check
# ============================================================================

def ensure_bluetooth_service() -> bool:
    """Ensure the Bluetooth service is running."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "bluetooth"],
            capture_output=True,
            text=True,
        )
        if result.stdout.strip() == "active":
            return True
    except Exception:
        pass

    print("[BLE] Bluetooth service not running, attempting to start...")
    try:
        subprocess.run(["systemctl", "start", "bluetooth"], check=True)
        time.sleep(1)
        print("[BLE] Bluetooth service started")
        return True
    except Exception as e:
        print(f"[BLE] Failed to start Bluetooth service: {e}")
        return False


# ============================================================================
# Main
# ============================================================================

async def async_main() -> None:
    print("=" * 60)
    print("Clardio Bluetooth Sensor Bridge (bleak)")
    print("=" * 60)
    print(f"Target devices:")
    print(f"  - Gymnasticon (K2Pi): {DEVICES['gymnasticon']}")
    print(f"  - COROS PACE 3: {DEVICES['coros_pace_3']}")
    print(f"POSTing to: {SERVER_URL}")
    print("=" * 60)

    # Create queues for each device
    gymnasticon_queue: asyncio.Queue[BLEDevice] = asyncio.Queue()
    coros_queue: asyncio.Queue[BLEDevice] = asyncio.Queue()

    # Map MACs to their queues for the scanner
    device_queues = {
        DEVICES["gymnasticon"]: gymnasticon_queue,
        DEVICES["coros_pace_3"]: coros_queue,
    }

    # Start all tasks
    await asyncio.gather(
        scan_for_devices(device_queues),
        manage_device(
            DEVICES["gymnasticon"],
            "Gymnasticon",
            [
                (CHAR_CYCLING_POWER, handle_cycling_power),
                (CHAR_CSC_MEASUREMENT, handle_csc_measurement),
            ],
            lambda v: setattr(state, "connected_gymnasticon", v),
            gymnasticon_queue,
        ),
        manage_device(
            DEVICES["coros_pace_3"],
            "COROS PACE 3",
            [(CHAR_HEART_RATE, handle_heart_rate)],
            lambda v: setattr(state, "connected_coros", v),
            coros_queue,
        ),
        post_metrics_loop(),
        log_status_loop(),
    )


def main() -> None:
    if not ensure_bluetooth_service():
        print("[BLE] Cannot proceed without Bluetooth service")
        return

    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\n[BLE] Shutting down...")
