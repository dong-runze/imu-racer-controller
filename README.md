# IMU Racer Controller

Handheld IMU racing controller for Arduino Nano 33 BLE Sense.

The project uses the board IMU for motion input, BLE for communication, a browser calibration/racing interface, and a browser trainer that exports Arduino-side MLP weights.

## What Is Included

- `firmware/`: Arduino Nano 33 BLE Sense firmware.
- `web/`: Svelte Web Bluetooth app and local Node server.
- `start_web.bat`: one-click launcher for the calibration and racing page on Windows.
- `start_trainer.bat`: one-click launcher for the motion dataset and model training page on Windows.

## Basic Workflow

1. Open `firmware/firmware.ino` in Arduino IDE.
2. Select `Arduino Nano 33 BLE Sense`.
3. Upload the firmware to the board.
4. Run `start_web.bat` for calibration and racing control.
5. Run `start_trainer.bat` when collecting labeled IMU data and exporting a model.

## Current Control Design

- The controller outputs virtual `W/A/S/D` intent.
- `NEUTRAL` means all keys are released.
- `WA` and `WD` are produced at runtime by combining forward and steering probabilities.
- Final ML inference is designed to run on the Nano firmware, while the browser is used for calibration, visualization, training, and testing.

## Notes

- The startup scripts install web dependencies when `node_modules` is missing.
- Frontend build output is generated locally and is not committed.
- Development logs, report Markdown files, and report screenshots are intentionally excluded from the repository.
