#include <Arduino.h>
#include <ArduinoBLE.h>

#include "ble_protocol.h"
#include "data_provider.h"
#include "ml_intent_classifier.h"
#include "pose_estimator.h"

#define DEBUG_SERIAL_POSE 1

namespace {

constexpr uint8_t kVersion = 1;
constexpr unsigned long kNotifyIntervalMs = 20;
constexpr unsigned long kCalibrationNotifyIntervalMs = 160;
constexpr unsigned long kDebugPrintIntervalMs = 50;

BLEService service(CONTROLLER_UUID("0000"));

BLEUnsignedCharCharacteristic versionTxChar(CONTROLLER_UUID("1001"), BLERead);
BLEUnsignedCharCharacteristic stateTxChar(CONTROLLER_UUID("1002"), BLERead | BLENotify);
BLECharacteristic poseTxChar(CONTROLLER_UUID("1003"), BLERead | BLENotify, 8);
BLECharacteristic calibrationTxChar(CONTROLLER_UUID("1004"), BLERead | BLENotify, 4);
BLECharacteristic intentTxChar(CONTROLLER_UUID("1005"), BLERead | BLENotify, 4);
BLECharacteristic motionTxChar(CONTROLLER_UUID("1006"), BLERead | BLENotify, 12);

BLEUnsignedCharCharacteristic commandRxChar(CONTROLLER_UUID("2001"), BLEWrite);
BLEUnsignedCharCharacteristic calibrationStageRxChar(CONTROLLER_UUID("2002"), BLEWrite);
BLECharacteristic calibrationSampleRxChar(CONTROLLER_UUID("2003"), BLEWrite, 8);

ControllerState current_state = STATE_IDLE_DISCONNECTED;
CalibrationStage current_stage = CAL_STAGE_IDLE;
PoseEstimator pose_estimator;
MlIntentClassifier ml_classifier;
IntentPrediction last_prediction = {
    INTENT_NEUTRAL,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
};

float imu_buffer[9] = {};
unsigned long last_notify_ms = 0;
unsigned long last_calibration_notify_ms = 0;
bool stage_stable = false;
bool use_magnetometer = false;
unsigned long last_debug_print_ms = 0;

void RgbLedOff() {
  digitalWrite(LEDR, HIGH);
  digitalWrite(LEDG, HIGH);
  digitalWrite(LEDB, HIGH);
}

void RgbLedRed() {
  digitalWrite(LEDR, LOW);
  digitalWrite(LEDG, HIGH);
  digitalWrite(LEDB, HIGH);
}

void RgbLedGreen() {
  digitalWrite(LEDR, HIGH);
  digitalWrite(LEDG, LOW);
  digitalWrite(LEDB, HIGH);
}

void RgbLedBlue() {
  digitalWrite(LEDR, HIGH);
  digitalWrite(LEDG, HIGH);
  digitalWrite(LEDB, LOW);
}

void RgbLedYellow() {
  digitalWrite(LEDR, LOW);
  digitalWrite(LEDG, LOW);
  digitalWrite(LEDB, HIGH);
}

void RgbLedMagenta() {
  digitalWrite(LEDR, LOW);
  digitalWrite(LEDG, HIGH);
  digitalWrite(LEDB, LOW);
}

int16_t EncodeAngle(float angle_degrees) {
  const float clamped = constrain(angle_degrees, -327.67f, 327.67f);
  return static_cast<int16_t>(clamped * 100.0f);
}

int16_t EncodeGravity(float value) {
  const float clamped = constrain(value, -3.2767f, 3.2767f);
  return static_cast<int16_t>(clamped * 10000.0f);
}

int16_t EncodeGyro(float degrees_per_second) {
  const float clamped = constrain(degrees_per_second, -3276.7f, 3276.7f);
  return static_cast<int16_t>(clamped * 10.0f);
}

const char* IntentLabelName(IntentLabel label) {
  switch (label) {
    case INTENT_W:
      return "W";
    case INTENT_A:
      return "A";
    case INTENT_S:
      return "S";
    case INTENT_D:
      return "D";
    case INTENT_WA:
      return "WA";
    case INTENT_WD:
      return "WD";
    case INTENT_NEUTRAL:
    default:
      return "NEUTRAL";
  }
}

void PublishState() {
  stateTxChar.writeValue(static_cast<uint8_t>(current_state));
}

void SetState(ControllerState next_state) {
  if (next_state == current_state) {
    return;
  }

  current_state = next_state;
  PublishState();

  Serial.print("State -> ");
  Serial.println(static_cast<int>(current_state));
}

void PublishCalibrationStatus(bool force = false) {
  const unsigned long now = millis();
  if (!force && now - last_calibration_notify_ms < kCalibrationNotifyIntervalMs) {
    return;
  }

  last_calibration_notify_ms = now;

  // Direction quality is evaluated on the browser side from recent pose jitter.
  // The firmware only reports the active stage and completion state.
  const uint8_t progress = current_stage == CAL_STAGE_DONE ? 100 : 0;

  const uint8_t packet[4] = {
      static_cast<uint8_t>(current_stage),
      static_cast<uint8_t>(stage_stable ? 1 : 0),
      progress,
      static_cast<uint8_t>(current_stage == CAL_STAGE_DONE ? 1 : 0),
  };
  calibrationTxChar.writeValue(packet, sizeof(packet));
}

void ResetCalibrationTracking() {
  stage_stable = current_stage == CAL_STAGE_DONE;
  PublishCalibrationStatus(true);
}

void UpdateCalibrationStatus() {
  if (current_state != STATE_CALIBRATING) {
    return;
  }

  if (current_stage == CAL_STAGE_IDLE || current_stage == CAL_STAGE_DONE) {
    stage_stable = current_stage == CAL_STAGE_DONE;
    PublishCalibrationStatus();
    return;
  }

  stage_stable = false;
  PublishCalibrationStatus();
}

void PublishPose() {
  const uint8_t flags =
      (stage_stable ? POSE_FLAG_STAGE_STABLE : 0) |
      (BLE.connected() ? POSE_FLAG_CONNECTED : 0);

  const int16_t pitch = EncodeAngle(pose_estimator.pitch());
  const int16_t roll = EncodeAngle(pose_estimator.roll());
  const int16_t yaw = EncodeAngle(pose_estimator.yaw());

  uint8_t packet[8];
  memcpy(packet + 0, &pitch, sizeof(pitch));
  memcpy(packet + 2, &roll, sizeof(roll));
  memcpy(packet + 4, &yaw, sizeof(yaw));
  packet[6] = flags;
  packet[7] = static_cast<uint8_t>(current_state);
  poseTxChar.writeValue(packet, sizeof(packet));
}

void PublishIntent() {
  last_prediction = ml_classifier.predict(millis());
  const uint8_t packet[4] = {
      static_cast<uint8_t>(last_prediction.label),
      last_prediction.key_mask,
      last_prediction.confidence_percent,
      last_prediction.flags,
  };
  intentTxChar.writeValue(packet, sizeof(packet));
}

void PublishMotion() {
  const MotionSnapshot motion = ml_classifier.currentMotion();
  const int16_t gravity_x = EncodeGravity(motion.gravity_x);
  const int16_t gravity_y = EncodeGravity(motion.gravity_y);
  const int16_t gravity_z = EncodeGravity(motion.gravity_z);
  const int16_t gyro_x = EncodeGyro(motion.gyro_x);
  const int16_t gyro_y = EncodeGyro(motion.gyro_y);
  const int16_t gyro_z = EncodeGyro(motion.gyro_z);

  uint8_t packet[12];
  memcpy(packet + 0, &gravity_x, sizeof(gravity_x));
  memcpy(packet + 2, &gravity_y, sizeof(gravity_y));
  memcpy(packet + 4, &gravity_z, sizeof(gravity_z));
  memcpy(packet + 6, &gyro_x, sizeof(gyro_x));
  memcpy(packet + 8, &gyro_y, sizeof(gyro_y));
  memcpy(packet + 10, &gyro_z, sizeof(gyro_z));
  motionTxChar.writeValue(packet, sizeof(packet));
}

void MaybeLogPose() {
#if DEBUG_SERIAL_POSE
  const unsigned long now = millis();
  if (now - last_debug_print_ms < kDebugPrintIntervalMs ||
      !pose_estimator.isInitialized()) {
    return;
  }

  last_debug_print_ms = now;
  Serial.print("POSE,");
  Serial.print(pose_estimator.pitch(), 2);
  Serial.print(",");
  Serial.print(pose_estimator.roll(), 2);
  Serial.print(",");
  Serial.print(pose_estimator.yaw(), 2);
  Serial.print(",");
  Serial.print(static_cast<int>(current_state));
  Serial.print(",");
  Serial.print(static_cast<int>(current_stage));
  Serial.print(",");
  Serial.println(stage_stable ? 1 : 0);

  const MotionSnapshot motion = ml_classifier.currentMotion();
  Serial.print("PREDICT,");
  Serial.print(IntentLabelName(last_prediction.label));
  Serial.print(",");
  Serial.print(static_cast<int>(last_prediction.label));
  Serial.print(",");
  Serial.print(last_prediction.key_mask);
  Serial.print(",");
  Serial.print(last_prediction.confidence_percent);
  Serial.print(",");
  Serial.print(last_prediction.flags);
  Serial.print(",");
  Serial.print(last_prediction.w_percent);
  Serial.print(",");
  Serial.print(last_prediction.a_percent);
  Serial.print(",");
  Serial.print(last_prediction.s_percent);
  Serial.print(",");
  Serial.print(last_prediction.d_percent);
  Serial.print(",");
  Serial.print(motion.gravity_x, 4);
  Serial.print(",");
  Serial.print(motion.gravity_y, 4);
  Serial.print(",");
  Serial.print(motion.gravity_z, 4);
  Serial.print(",");
  Serial.print(motion.gyro_x, 2);
  Serial.print(",");
  Serial.print(motion.gyro_y, 2);
  Serial.print(",");
  Serial.println(motion.gyro_z, 2);
#endif
}

void HandleCommandWritten(BLEDevice, BLECharacteristic) {
  const ControllerCommand command =
      static_cast<ControllerCommand>(commandRxChar.value());

  Serial.print("Command <- ");
  Serial.println(static_cast<int>(command));

  switch (command) {
    case COMMAND_START_CALIBRATION:
      current_stage = CAL_STAGE_NEUTRAL;
      ml_classifier.resetCalibration();
      ResetCalibrationTracking();
      SetState(STATE_CALIBRATING);
      break;
    case COMMAND_ENTER_READY:
      SetState(STATE_READY);
      break;
    case COMMAND_ENTER_PLAYING:
      SetState(STATE_PLAYING);
      break;
    case COMMAND_RESET_POSE:
      pose_estimator.reset();
      ml_classifier.resetCalibration();
      ResetCalibrationTracking();
      break;
    case COMMAND_ABORT_CALIBRATION:
      current_stage = CAL_STAGE_IDLE;
      ml_classifier.resetCalibration();
      ResetCalibrationTracking();
      SetState(STATE_IDLE_CONNECTED);
      break;
    case COMMAND_NONE:
    default:
      break;
  }
}

void HandleStageWritten(BLEDevice, BLECharacteristic) {
  current_stage =
      static_cast<CalibrationStage>(calibrationStageRxChar.value());
  Serial.print("Calibration stage <- ");
  Serial.println(static_cast<int>(current_stage));

  if (current_stage == CAL_STAGE_DONE) {
    SetState(STATE_READY);
    ResetCalibrationTracking();
    return;
  }

  if (current_state != STATE_CALIBRATING) {
    SetState(STATE_CALIBRATING);
  }

  ResetCalibrationTracking();
}

void HandleCalibrationSampleWritten(BLEDevice, BLECharacteristic) {
  if (calibrationSampleRxChar.valueLength() < 8) {
    return;
  }

  uint8_t packet[8];
  calibrationSampleRxChar.readValue(packet, sizeof(packet));

  const CalibrationStage stage = static_cast<CalibrationStage>(packet[0]);
  int16_t gravity_x_raw = 0;
  int16_t gravity_y_raw = 0;
  int16_t gravity_z_raw = 0;
  memcpy(&gravity_x_raw, packet + 2, sizeof(gravity_x_raw));
  memcpy(&gravity_y_raw, packet + 4, sizeof(gravity_y_raw));
  memcpy(&gravity_z_raw, packet + 6, sizeof(gravity_z_raw));

  ml_classifier.setCalibrationSample(
      stage,
      static_cast<float>(gravity_x_raw) / 10000.0f,
      static_cast<float>(gravity_y_raw) / 10000.0f,
      static_cast<float>(gravity_z_raw) / 10000.0f);

  Serial.print("Calibration sample <- stage ");
  Serial.print(static_cast<int>(stage));
  Serial.print(" gravity ");
  Serial.print(static_cast<float>(gravity_x_raw) / 10000.0f, 4);
  Serial.print(",");
  Serial.print(static_cast<float>(gravity_y_raw) / 10000.0f, 4);
  Serial.print(",");
  Serial.println(static_cast<float>(gravity_z_raw) / 10000.0f, 4);
}

void UpdateLed() {
  switch (current_state) {
    case STATE_IDLE_DISCONNECTED:
      millis() % 1000 > 700 ? RgbLedOff() : RgbLedBlue();
      break;
    case STATE_IDLE_CONNECTED:
      RgbLedBlue();
      break;
    case STATE_CALIBRATING:
      millis() % 400 > 200 ? RgbLedOff() : RgbLedYellow();
      break;
    case STATE_READY:
      RgbLedGreen();
      break;
    case STATE_PLAYING:
      RgbLedMagenta();
      break;
    case STATE_ERROR:
    default:
      millis() % 600 > 300 ? RgbLedOff() : RgbLedRed();
      break;
  }
}

void SetupBle() {
  if (!BLE.begin()) {
    Serial.println("BLE init failed");
    SetState(STATE_ERROR);
    while (true) {
      UpdateLed();
    }
  }

  String address = BLE.address();
  address.toUpperCase();

  String device_name = CONTROLLER_LOCAL_NAME;
  device_name += " - ";
  device_name += address[address.length() - 5];
  device_name += address[address.length() - 4];
  device_name += address[address.length() - 2];
  device_name += address[address.length() - 1];

  versionTxChar.writeValue(kVersion);
  PublishState();
  PublishCalibrationStatus(true);

  commandRxChar.setEventHandler(BLEWritten, HandleCommandWritten);
  calibrationStageRxChar.setEventHandler(BLEWritten, HandleStageWritten);
  calibrationSampleRxChar.setEventHandler(
      BLEWritten,
      HandleCalibrationSampleWritten);

  service.addCharacteristic(versionTxChar);
  service.addCharacteristic(stateTxChar);
  service.addCharacteristic(poseTxChar);
  service.addCharacteristic(calibrationTxChar);
  service.addCharacteristic(intentTxChar);
  service.addCharacteristic(motionTxChar);
  service.addCharacteristic(commandRxChar);
  service.addCharacteristic(calibrationStageRxChar);
  service.addCharacteristic(calibrationSampleRxChar);

  BLE.setLocalName(device_name.c_str());
  BLE.setDeviceName(device_name.c_str());
  BLE.setAdvertisedService(service);
  BLE.addService(service);
  BLE.advertise();

  Serial.print("BLE ready: ");
  Serial.println(device_name);
}

void UpdatePoseStream() {
  while (data_provider::dataAvailable()) {
    data_provider::update(imu_buffer, use_magnetometer);
    pose_estimator.update(imu_buffer);
    if (pose_estimator.isInitialized()) {
      ml_classifier.addMotion(
          imu_buffer[0],
          imu_buffer[1],
          imu_buffer[2],
          imu_buffer[3] * 2000.0f,
          imu_buffer[4] * 2000.0f,
          imu_buffer[5] * 2000.0f,
          millis());
    }
    UpdateCalibrationStatus();
  }

  const unsigned long now = millis();
  if (now - last_notify_ms >= kNotifyIntervalMs && pose_estimator.isInitialized()) {
    PublishPose();
    PublishMotion();
    PublishIntent();
    last_notify_ms = now;
  }

  MaybeLogPose();
}

}  // namespace

void data_provider_calibrationComplete() {
}

void setup() {
  Serial.begin(115200);
  const unsigned long start_time = millis();
  while (!Serial && millis() - start_time < 2000) {
  }

  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(LEDR, OUTPUT);
  pinMode(LEDG, OUTPUT);
  pinMode(LEDB, OUTPUT);

  if (!data_provider::setup()) {
    Serial.println("IMU init failed");
    SetState(STATE_ERROR);
    while (true) {
      UpdateLed();
    }
  }

  SetupBle();

#if DEBUG_SERIAL_POSE
  Serial.println("DEBUG_SERIAL_POSE enabled");
  Serial.println("Format: POSE,pitch,roll,yaw,state,stage,stable");
  Serial.println("Format: PREDICT,labelName,label,keyMask,confidence,flags,wProb,aProb,sProb,dProb,gx,gy,gz,gyroX,gyroY,gyroZ");
#endif
}

void loop() {
  BLE.poll();

  const bool connected = BLE.connected();
  if (!connected && current_state != STATE_IDLE_DISCONNECTED) {
    current_stage = CAL_STAGE_IDLE;
    ResetCalibrationTracking();
    SetState(STATE_IDLE_DISCONNECTED);
  } else if (connected && current_state == STATE_IDLE_DISCONNECTED) {
    SetState(STATE_IDLE_CONNECTED);
  }

  if (connected) {
    UpdatePoseStream();
  }

  UpdateLed();
}
