# Bluetooth Debugging

## Bluetooth Hardware

**Adapters:**
- Intel AX201 (hci0) - built-in, has LE scanning issues ("Command Disallowed"), avoid
- USB dongle RTL8761BU (hci1) - works reliably, use this one

**Devices:**
| Device | MAC | Services |
|--------|-----|----------|
| Gymnasticon (K2Pi) | B8:27:EB:95:0B:90 | Cycling Power (0x1818), CSC (0x1816) |
| COROS PACE 3 | F7:AF:40:38:08:90 | Heart Rate (0x180D) |

Note: Gymnasticon must be powered on and pedaling to broadcast.

## Running the Sensor Bridge

```bash
sudo NOBLE_HCI_DEVICE_ID=1 bun run sensors
```

Or directly:
```bash
sudo NOBLE_HCI_DEVICE_ID=1 npx tsx src/bluetooth/sensor-bridge.ts
```

## Troubleshooting

- Must use sudo for Bluetooth permissions
- Must set NOBLE_HCI_DEVICE_ID=1 to use the USB dongle instead of the flaky Intel adapter
- If Gymnasticon not found, ensure bike is powered and pedals are moving
