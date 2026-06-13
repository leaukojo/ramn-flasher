# TRY ME

Try me here: https://leaukojo.github.io/ramn-flasher

# RAMN Web Flasher

A browser-based firmware flasher for the [RAMN](https://github.com/ToyotaInfoTech/RAMN) automotive security research platform.
No drivers, no installers: flash all ECUs directly from Chrome or Edge using the WebUSB and Web Serial APIs.

> **Unofficial tool.** This is not affiliated with ToyotaInfoTech. Use at your own risk.
> RAMN firmware is copyright [ToyotaInfoTech](https://github.com/ToyotaInfoTech/RAMN?tab=License-1-ov-file#readme).

**Supported browsers:** Chrome / Edge 89+ (WebUSB and Web Serial are not available in Firefox or Safari).

## Quick Start

No build step required. Serve the directory over HTTP and open `index.html`:

```bash
python -m http.server 8080 --bind 127.0.0.1
# then open http://localhost:8080/ in Chrome or Edge
```

> The page must be served over HTTPS or `localhost`. Opening from `file://` blocks WebUSB access.

## Modes

### Update RAMN
For boards with existing firmware. Fetches the latest firmware from GitHub and flashes all four ECUs automatically in one click. Requires only two browser permission dialogs (serial port, then USB device).

### First-Time Setup / Recovery
For freshly fabricated boards, or to recover a board where ECU A is stuck in DFU mode from a failed flash. ECU A must already be in DFU mode. Flashes ECU A first, then ECU B/C/D.

### Expert Mode
Full manual control. Flash individual ECUs, load custom or alternative firmware, inspect DFU parameters, and control each step individually.

## Hardware

| ECU | Connection | VID:PID |
|---|---|---|
| ECU A (DFU mode) | USB | `0x0483:0xDF11` (STM32 bootloader) |
| ECU A (app mode) | USB Serial | `0x0483:0x5740` or `0x1d50:0x606f` |
| ECU B / C / D | via ECU A (CAN-FD slcan bridge) | - |

ECU A running its application acts as a USB-to-CAN gateway for programming ECU B, C, and D.

## Firmware Sources

- **GitHub main branch**: latest features, may have occasional bugs
- **Latest release**: stable build; use if you encounter bugs with the GitHub version
- **Local files**: load `ECUA.bin`/`.hex`, `ECUB.hex`, `ECUB_LINEAR.hex`, `ECUC.hex`, `ECUD.hex` from your computer

## ECU B: Logarithmic vs Linear

Two ECU B firmware variants exist for different steering sensor configurations. The default is **Logarithmic**. To check if you have the wrong variant installed: run the RAMN vehicle simulation and look at the ECU A display; if STEER does not show 0% when the steering wheel is centered, reflash ECU B with the other variant.

## File Structure

| File | Purpose |
|---|---|
| `index.html` | HTML shell; all three modes |
| `style.css` | All CSS |
| `js/state.js` | DFU/CAN constants and global state |
| `js/ui.js` | DOM helpers, log, progress bar, button-state updaters |
| `js/firmware.js` | Firmware loading: GitHub branch, release, local files |
| `js/dfu.js` | WebUSB DFU protocol; ECU A flash and verify |
| `js/can.js` | Web Serial CAN-FD bootloader; ECU B/C/D flash and verify |
| `js/main.js` | Expert-mode event wiring |
| `js/wizard.js` | Wizard flash sequences (Update RAMN, First-Time Setup) |
| `js/app.js` | Mode routing, wizard UI, help modal |

## About RAMN

RAMN firmware is copyright ToyotaInfoTech; see the [RAMN license](https://github.com/ToyotaInfoTech/RAMN?tab=License-1-ov-file#readme).

---

*This application was built using (mostly) Claude Sonnet 4.6.*

