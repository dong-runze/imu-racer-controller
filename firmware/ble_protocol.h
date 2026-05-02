#ifndef IMU_RACER_BLE_PROTOCOL_H_
#define IMU_RACER_BLE_PROTOCOL_H_

#include <ArduinoBLE.h>

#define CONTROLLER_LOCAL_NAME "IMU Racer Controller"
#define CONTROLLER_UUID(val) ("6d9af200-" val "-4f7d-a886-de3e90749161")

enum ControllerState : uint8_t {
  STATE_IDLE_DISCONNECTED = 0,
  STATE_IDLE_CONNECTED = 1,
  STATE_CALIBRATING = 2,
  STATE_READY = 3,
  STATE_PLAYING = 4,
  STATE_ERROR = 5,
};

enum ControllerCommand : uint8_t {
  COMMAND_NONE = 0,
  COMMAND_START_CALIBRATION = 1,
  COMMAND_ENTER_READY = 2,
  COMMAND_ENTER_PLAYING = 3,
  COMMAND_RESET_POSE = 4,
  COMMAND_ABORT_CALIBRATION = 5,
};

enum CalibrationStage : uint8_t {
  CAL_STAGE_IDLE = 0,
  CAL_STAGE_NEUTRAL = 1,
  CAL_STAGE_LEFT = 2,
  CAL_STAGE_RIGHT = 3,
  CAL_STAGE_FORWARD = 4,
  CAL_STAGE_BACKWARD = 5,
  CAL_STAGE_DONE = 6,
};

enum IntentLabel : uint8_t {
  INTENT_NEUTRAL = 0,
  INTENT_W = 1,
  INTENT_A = 2,
  INTENT_S = 3,
  INTENT_D = 4,
  INTENT_WA = 5,
  INTENT_WD = 6,
};

constexpr uint8_t POSE_FLAG_STAGE_STABLE = 1 << 0;
constexpr uint8_t POSE_FLAG_CONNECTED = 1 << 1;

constexpr uint8_t KEY_MASK_W = 1 << 0;
constexpr uint8_t KEY_MASK_A = 1 << 1;
constexpr uint8_t KEY_MASK_S = 1 << 2;
constexpr uint8_t KEY_MASK_D = 1 << 3;

constexpr uint8_t INTENT_FLAG_MODEL_READY = 1 << 0;
constexpr uint8_t INTENT_FLAG_CONFIDENT = 1 << 1;
constexpr uint8_t INTENT_FLAG_CALIBRATED = 1 << 2;

#endif  // IMU_RACER_BLE_PROTOCOL_H_
