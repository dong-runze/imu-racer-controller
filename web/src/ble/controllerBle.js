const SERVICE_UUID = "6d9af200-0000-4f7d-a886-de3e90749161";
const VERSION_UUID = "6d9af200-1001-4f7d-a886-de3e90749161";
const STATE_UUID = "6d9af200-1002-4f7d-a886-de3e90749161";
const POSE_UUID = "6d9af200-1003-4f7d-a886-de3e90749161";
const CALIBRATION_UUID = "6d9af200-1004-4f7d-a886-de3e90749161";
const INTENT_UUID = "6d9af200-1005-4f7d-a886-de3e90749161";
const MOTION_UUID = "6d9af200-1006-4f7d-a886-de3e90749161";
const COMMAND_UUID = "6d9af200-2001-4f7d-a886-de3e90749161";
const STAGE_UUID = "6d9af200-2002-4f7d-a886-de3e90749161";
const CALIBRATION_SAMPLE_UUID = "6d9af200-2003-4f7d-a886-de3e90749161";

export const ControllerState = Object.freeze({
  idleDisconnected: 0,
  idleConnected: 1,
  calibrating: 2,
  ready: 3,
  playing: 4,
  error: 5,
});

export const ControllerCommand = Object.freeze({
  none: 0,
  startCalibration: 1,
  enterReady: 2,
  enterPlaying: 3,
  resetPose: 4,
  abortCalibration: 5,
});

export const CalibrationStage = Object.freeze({
  idle: 0,
  neutral: 1,
  left: 2,
  right: 3,
  forward: 4,
  backward: 5,
  done: 6,
});

export const IntentLabel = Object.freeze({
  neutral: 0,
  w: 1,
  a: 2,
  s: 3,
  d: 4,
  wa: 5,
  wd: 6,
});

const INTENT_LABEL_NAMES = [
  "NEUTRAL",
  "W",
  "A",
  "S",
  "D",
  "WA",
  "WD",
];

const KEY_MASK = Object.freeze({
  w: 1 << 0,
  a: 1 << 1,
  s: 1 << 2,
  d: 1 << 3,
});

const INTENT_FLAGS = Object.freeze({
  modelReady: 1 << 0,
  confident: 1 << 1,
  calibrated: 1 << 2,
});

function decodePose(dataView) {
  return {
    pitch: dataView.getInt16(0, true) / 100,
    roll: dataView.getInt16(2, true) / 100,
    yaw: dataView.getInt16(4, true) / 100,
    flags: dataView.getUint8(6),
    state: dataView.getUint8(7),
  };
}

function decodeIntent(dataView) {
  const label = dataView.getUint8(0);
  const keyMask = dataView.getUint8(1);
  const flags = dataView.getUint8(3);
  const keys = {
    w: Boolean(keyMask & KEY_MASK.w),
    a: Boolean(keyMask & KEY_MASK.a),
    s: Boolean(keyMask & KEY_MASK.s),
    d: Boolean(keyMask & KEY_MASK.d),
  };
  const combo = ["w", "a", "s", "d"]
    .filter((key) => keys[key])
    .join("")
    .toUpperCase();

  return {
    label,
    labelName: INTENT_LABEL_NAMES[label] || "NEUTRAL",
    keyMask,
    keys: {
      ...keys,
      combo: combo || "NONE",
      forwardDiagonal: keys.w && (keys.a || keys.d),
    },
    confidence: dataView.getUint8(2) / 100,
    flags,
    modelReady: Boolean(flags & INTENT_FLAGS.modelReady),
    confident: Boolean(flags & INTENT_FLAGS.confident),
    calibrated: Boolean(flags & INTENT_FLAGS.calibrated),
  };
}

function decodeMotion(dataView) {
  return {
    gravityX: dataView.getInt16(0, true) / 10000,
    gravityY: dataView.getInt16(2, true) / 10000,
    gravityZ: dataView.getInt16(4, true) / 10000,
    gyroX: dataView.getInt16(6, true) / 10,
    gyroY: dataView.getInt16(8, true) / 10,
    gyroZ: dataView.getInt16(10, true) / 10,
  };
}

function decodeCalibration(dataView) {
  return {
    stage: dataView.getUint8(0),
    stable: dataView.getUint8(1) === 1,
    progress: dataView.getUint8(2),
    done: dataView.getUint8(3) === 1,
  };
}

class ControllerBle extends EventTarget {
  async connect() {
    if (this.device?.gatt?.connected) {
      return;
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener(
      "gattserverdisconnected",
      this.handleDisconnect,
    );

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    this.versionCharacteristic = await service.getCharacteristic(VERSION_UUID);
    this.stateCharacteristic = await service.getCharacteristic(STATE_UUID);
    this.poseCharacteristic = await service.getCharacteristic(POSE_UUID);
    this.calibrationCharacteristic =
      await service.getCharacteristic(CALIBRATION_UUID);
    try {
      this.intentCharacteristic = await service.getCharacteristic(INTENT_UUID);
    } catch (error) {
      this.intentCharacteristic = null;
    }
    try {
      this.motionCharacteristic = await service.getCharacteristic(MOTION_UUID);
    } catch (error) {
      this.motionCharacteristic = null;
    }
    this.commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    this.stageCharacteristic = await service.getCharacteristic(STAGE_UUID);
    try {
      this.calibrationSampleCharacteristic = await service.getCharacteristic(
        CALIBRATION_SAMPLE_UUID,
      );
    } catch (error) {
      this.calibrationSampleCharacteristic = null;
    }

    await this.stateCharacteristic.startNotifications();
    this.stateCharacteristic.addEventListener(
      "characteristicvaluechanged",
      this.handleStateChanged,
    );

    await this.poseCharacteristic.startNotifications();
    this.poseCharacteristic.addEventListener(
      "characteristicvaluechanged",
      this.handlePoseChanged,
    );

    await this.calibrationCharacteristic.startNotifications();
    this.calibrationCharacteristic.addEventListener(
      "characteristicvaluechanged",
      this.handleCalibrationChanged,
    );

    if (this.intentCharacteristic) {
      await this.intentCharacteristic.startNotifications();
      this.intentCharacteristic.addEventListener(
        "characteristicvaluechanged",
        this.handleIntentChanged,
      );
    }

    if (this.motionCharacteristic) {
      await this.motionCharacteristic.startNotifications();
      this.motionCharacteristic.addEventListener(
        "characteristicvaluechanged",
        this.handleMotionChanged,
      );
    }

    const version = await this.versionCharacteristic.readValue();
    this.dispatchEvent(
      new CustomEvent("connected", {
        detail: {
          name: this.device.name || "IMU Racer Controller",
          version: version.getUint8(0),
        },
      }),
    );
  }

  async disconnect() {
    if (!this.device) {
      return;
    }

    this.removeCharacteristicListeners();
    if (this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.dispatchEvent(new CustomEvent("disconnected"));
  }

  async sendCommand(command) {
    if (!this.commandCharacteristic) {
      return;
    }
    await this.commandCharacteristic.writeValue(Uint8Array.of(command));
  }

  async setCalibrationStage(stage) {
    if (!this.stageCharacteristic) {
      return;
    }
    await this.stageCharacteristic.writeValue(Uint8Array.of(stage));
  }

  async writeCalibrationSample(stage, snapshot) {
    if (!this.calibrationSampleCharacteristic || !snapshot) {
      return;
    }

    const encodeGravity = (value) =>
      Math.max(
        -32767,
        Math.min(32767, Math.round((Number(value) || 0) * 10000)),
      );
    const gravity = snapshot.gravity?.mean || snapshot.gravity || {
      x: 0,
      y: 0,
      z: 1,
    };
    const buffer = new ArrayBuffer(8);
    const dataView = new DataView(buffer);
    dataView.setUint8(0, stage);
    dataView.setUint8(1, 0);
    dataView.setInt16(2, encodeGravity(gravity.x), true);
    dataView.setInt16(4, encodeGravity(gravity.y), true);
    dataView.setInt16(6, encodeGravity(gravity.z), true);
    await this.calibrationSampleCharacteristic.writeValue(buffer);
  }

  handleDisconnect = () => {
    this.removeCharacteristicListeners();
    this.dispatchEvent(new CustomEvent("disconnected"));
  };

  handleStateChanged = (event) => {
    this.dispatchEvent(
      new CustomEvent("state", {
        detail: event.target.value.getUint8(0),
      }),
    );
  };

  handlePoseChanged = (event) => {
    this.dispatchEvent(
      new CustomEvent("pose", {
        detail: decodePose(event.target.value),
      }),
    );
  };

  handleCalibrationChanged = (event) => {
    this.dispatchEvent(
      new CustomEvent("calibration", {
        detail: decodeCalibration(event.target.value),
      }),
    );
  };

  handleIntentChanged = (event) => {
    this.dispatchEvent(
      new CustomEvent("intent", {
        detail: decodeIntent(event.target.value),
      }),
    );
  };

  handleMotionChanged = (event) => {
    this.dispatchEvent(
      new CustomEvent("motion", {
        detail: decodeMotion(event.target.value),
      }),
    );
  };

  removeCharacteristicListeners() {
    if (this.stateCharacteristic) {
      this.stateCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleStateChanged,
      );
    }
    if (this.poseCharacteristic) {
      this.poseCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handlePoseChanged,
      );
    }
    if (this.calibrationCharacteristic) {
      this.calibrationCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleCalibrationChanged,
      );
    }
    if (this.intentCharacteristic) {
      this.intentCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleIntentChanged,
      );
    }
    if (this.motionCharacteristic) {
      this.motionCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleMotionChanged,
      );
    }
    if (this.device) {
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.handleDisconnect,
      );
    }
  }
}

export default new ControllerBle();
