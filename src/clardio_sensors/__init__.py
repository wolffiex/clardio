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

# BLE Service UUIDs (full 128-bit format for bleak)
SERVICE_CYCLING_POWER = "00001818-0000-1000-8000-00805f9b34fb"
SERVICE_HEART_RATE = "0000180d-0000-1000-8000-00805f9b34fb"
SERVICE_CSC = "00001816-0000-1000-8000-00805f9b34fb"

# BLE Characteristic UUIDs (bleak uses full UUIDs)
CHAR_HEART_RATE = "00002a37-0000-1000-8000-00805f9b34fb"
CHAR_CYCLING_POWER = "00002a63-0000-1000-8000-00805f9b34fb"
CHAR_CSC_MEASUREMENT = "00002a5b-0000-1000-8000-00805f9b34fb"

# Optional: known device MACs as hints (not required)
# These can help identify specific devices if multiple are found
KNOWN_DEVICES = {
    "B8:27:EB:95:0B:90": "Gymnasticon (K2Pi)",
    "F7:AF:40:38:08:90": "COROS PACE 3",
}

SERVER_URL = "http://localhost:3000/api/metrics"
POST_INTERVAL = 4.0  # seconds
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


_power_debug_count = 0

def parse_cycling_power(data: bytes) -> tuple[int, int | None]:
    """Parse Cycling Power Measurement characteristic (0x2A63)

    Returns: (power, cadence) where cadence is None if not present

    Format per Bluetooth GATT spec:
    - Bytes 0-1: Flags (16-bit little-endian)
    - Bytes 2-3: Instantaneous Power (16-bit signed little-endian, watts)
    - Additional fields depend on flags
    """
    global _power_debug_count

    if len(data) < 4:
        log(f"[PWR] Warning: data too short ({len(data)} bytes): {data.hex()}")
        return (0, None)

    flags = struct.unpack_from("<H", data, 0)[0]
    power = struct.unpack_from("<h", data, 2)[0]

    # Debug: log raw bytes for first 10 readings to help diagnose issues
    if _power_debug_count < 10:
        log(f"[PWR] Raw: {data.hex()} flags=0x{flags:04x} power={power}W len={len(data)}")
        _power_debug_count += 1

    # Parse cadence if Crank Revolution Data Present (bit 5)
    cadence = None
    if flags & 0x0020:
        # Calculate offset based on which optional fields are present before crank data
        offset = 4
        if flags & 0x0001:  # Pedal Power Balance Present
            offset += 1
        if flags & 0x0004:  # Accumulated Torque Present
            offset += 2
        if flags & 0x0010:  # Wheel Revolution Data Present
            offset += 6

        if len(data) >= offset + 4:
            crank_revs = struct.unpack_from("<H", data, offset)[0]
            crank_time = struct.unpack_from("<H", data, offset + 2)[0]
            log(f"[PWR] Crank data: revs={crank_revs} time={crank_time}")

    return (max(0, power), cadence)


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

def log(msg: str) -> None:
    """Log with timestamp."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def handle_heart_rate(_sender: int, data: bytes) -> None:
    hr = parse_heart_rate(data)
    if hr != state.hr:
        log(f"[HR] {hr} bpm")
    state.hr = hr


def handle_cycling_power(_sender: int, data: bytes) -> None:
    power, cadence = parse_cycling_power(data)
    if power != state.power:
        log(f"[PWR] {power}W")
    state.power = power
    # Use cadence from Cycling Power if present and CSC isn't providing it
    if cadence is not None:
        state.cadence = cadence


def handle_csc_measurement(_sender: int, data: bytes) -> None:
    cadence = parse_csc_measurement(data)
    if cadence is not None and cadence != state.cadence:
        log(f"[CAD] {cadence} rpm")
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
    log(f"[BLE] Connecting to {name} ({device.address})...")

    try:
        client = BleakClient(device)
        await client.connect()
        log(f"[BLE] Connected to {name}")

        for char_uuid, handler in characteristics:
            try:
                await client.start_notify(char_uuid, handler)
                log(f"[BLE] Subscribed to {char_uuid[-8:-4]} on {name}")
            except Exception as e:
                log(f"[BLE] Failed to subscribe to {char_uuid}: {e}")

        return client
    except Exception as e:
        log(f"[BLE] Failed to connect to {name}: {e}")
        return None


async def manage_device(
    service_name: str,
    characteristics: list[tuple[str, callable]],
    set_connected: callable,
    device_queue: asyncio.Queue,
    reset_on_disconnect: callable,
) -> None:
    """Manage connection to a single device, receiving devices from shared scanner."""
    while True:
        # Wait for our device to be found by the scanner
        device = await device_queue.get()

        # Get a friendly name for the device
        device_label = KNOWN_DEVICES.get(device.address, device.name or device.address)
        log(f"[BLE] Found {service_name} device: {device_label} ({device.address})")

        client = await connect_device(device, device_label, characteristics)

        if client is None:
            log(f"[BLE] Waiting {RECONNECT_DELAY}s before retry...")
            await asyncio.sleep(RECONNECT_DELAY)
            continue

        set_connected(True)

        # Wait for disconnect
        try:
            while client.is_connected:
                await asyncio.sleep(1.0)
        except Exception as e:
            log(f"[BLE] {device_label} connection error: {e}")

        log(f"[BLE] {device_label} disconnected")
        set_connected(False)
        reset_on_disconnect()


async def scan_for_devices(
    service_queues: dict[str, asyncio.Queue],
    connected_flags: dict[str, callable],
) -> None:
    """
    Scan for devices by service UUID and dispatch to their queues.

    Args:
        service_queues: Maps service UUID to queue for that service type
        connected_flags: Maps service UUID to callable returning connection status
    """
    while True:
        # Figure out what services we need devices for
        needed_services = [
            svc for svc, is_connected in connected_flags.items()
            if not is_connected()
        ]

        if not needed_services:
            # All services have connected devices, wait then check again
            await asyncio.sleep(RECONNECT_DELAY)
            continue

        service_names = {
            SERVICE_CYCLING_POWER: "Cycling Power",
            SERVICE_HEART_RATE: "Heart Rate",
            SERVICE_CSC: "CSC",
        }
        needed_names = [service_names.get(s, s[-8:]) for s in needed_services]
        log(f"[BLE] Scanning for services: {', '.join(needed_names)}")

        try:
            # Scan for devices advertising our target services
            # return_adv=True returns dict[str, tuple[BLEDevice, AdvertisementData]]
            devices_with_adv = await BleakScanner.discover(
                timeout=10.0,
                service_uuids=needed_services,
                return_adv=True,
            )
            log(f"[BLE] Scan found {len(devices_with_adv)} device(s) with target services")

            # Track which services we found devices for
            found_services: set[str] = set()

            for device, adv_data in devices_with_adv.values():
                # Check which of our needed services this device advertises
                if adv_data.service_uuids:
                    advertised = set(uuid.lower() for uuid in adv_data.service_uuids)

                    for service_uuid in needed_services:
                        if service_uuid in advertised and service_uuid not in found_services:
                            device_label = KNOWN_DEVICES.get(device.address, device.name or device.address)
                            svc_name = service_names.get(service_uuid, service_uuid[-8:])
                            log(f"[BLE] Found {svc_name} on {device_label} ({device.address})")
                            found_services.add(service_uuid)
                            await service_queues[service_uuid].put(device)

            # Log what we're still looking for
            still_needed = set(needed_services) - found_services
            if still_needed:
                still_names = [service_names.get(s, s[-8:]) for s in still_needed]
                log(f"[BLE] Still looking for: {', '.join(still_names)}")

        except Exception as e:
            log(f"[BLE] Scan error: {e}")

        await asyncio.sleep(1.0)  # Brief pause between scans


# ============================================================================
# Metrics Posting
# ============================================================================

async def post_metrics_loop() -> None:
    """POST metrics to the server - only include connected device metrics."""
    async with aiohttp.ClientSession() as session:
        while True:
            # Only include metrics from connected devices
            metrics: dict[str, int] = {}
            if state.connected_gymnasticon:
                metrics["power"] = state.power
                metrics["cadence"] = state.cadence
            if state.connected_coros:
                metrics["hr"] = state.hr

            if metrics:
                try:
                    async with session.post(SERVER_URL, json=metrics) as resp:
                        if resp.status != 200:
                            log(f"[HTTP] POST failed: {resp.status}")
                except aiohttp.ClientError as e:
                    log(f"[HTTP] POST error: {e}")

            await asyncio.sleep(POST_INTERVAL)


async def log_status_loop() -> None:
    """Log status every 5 seconds."""
    while True:
        await asyncio.sleep(5.0)
        gym = "✓" if state.connected_gymnasticon else "✗"
        coros = "✓" if state.connected_coros else "✗"

        log(
            f"[STATUS] P:{state.power}W HR:{state.hr} C:{state.cadence}rpm | "
            f"Gym:{gym} COROS:{coros}"
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

    log("[BLE] Bluetooth service not running, attempting to start...")
    try:
        subprocess.run(["systemctl", "start", "bluetooth"], check=True)
        time.sleep(1)
        log("[BLE] Bluetooth service started")
        return True
    except Exception as e:
        log(f"[BLE] Failed to start Bluetooth service: {e}")
        return False


# ============================================================================
# Main
# ============================================================================

async def async_main() -> None:
    print("=" * 60)
    print("Clardio Bluetooth Sensor Bridge (bleak)")
    print("=" * 60)
    print("Scanning for BLE services:")
    print(f"  - Cycling Power (0x1818): power + cadence")
    print(f"  - Heart Rate (0x180D): heart rate monitor")
    print(f"POSTing to: {SERVER_URL}")
    print("=" * 60)

    # Create queues for each service type
    cycling_power_queue: asyncio.Queue[BLEDevice] = asyncio.Queue()
    heart_rate_queue: asyncio.Queue[BLEDevice] = asyncio.Queue()

    # Map service UUIDs to their queues
    service_queues = {
        SERVICE_CYCLING_POWER: cycling_power_queue,
        SERVICE_HEART_RATE: heart_rate_queue,
    }

    # Map service UUIDs to connection status checkers
    connected_flags = {
        SERVICE_CYCLING_POWER: lambda: state.connected_gymnasticon,
        SERVICE_HEART_RATE: lambda: state.connected_coros,
    }

    def reset_cycling_power():
        state.power = 0
        state.cadence = 0
        state.last_crank_revs = None
        state.last_crank_time = None

    def reset_heart_rate():
        state.hr = 0

    # Start all tasks
    await asyncio.gather(
        scan_for_devices(service_queues, connected_flags),
        manage_device(
            "Cycling Power",
            [
                (CHAR_CYCLING_POWER, handle_cycling_power),
                (CHAR_CSC_MEASUREMENT, handle_csc_measurement),
            ],
            lambda v: setattr(state, "connected_gymnasticon", v),
            cycling_power_queue,
            reset_cycling_power,
        ),
        manage_device(
            "Heart Rate",
            [(CHAR_HEART_RATE, handle_heart_rate)],
            lambda v: setattr(state, "connected_coros", v),
            heart_rate_queue,
            reset_heart_rate,
        ),
        post_metrics_loop(),
        log_status_loop(),
    )


def main() -> None:
    if not ensure_bluetooth_service():
        log("[BLE] Cannot proceed without Bluetooth service")
        return

    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        log("[BLE] Shutting down...")
