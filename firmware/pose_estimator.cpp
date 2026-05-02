#include "pose_estimator.h"

#include <Arduino.h>
#include <math.h>

namespace {

constexpr float kComplementaryAlpha = 0.98f;
constexpr float kMaxValidDtSeconds = 0.25f;

float WrapAngleDegrees(float angle) {
  while (angle > 180.0f) {
    angle -= 360.0f;
  }
  while (angle < -180.0f) {
    angle += 360.0f;
  }
  return angle;
}

float ComputeAccelRollDegrees(float ay, float az) {
  return atan2f(ay, az) * 180.0f / PI;
}

float ComputeAccelPitchDegrees(float ax, float ay, float az) {
  const float denominator = sqrtf((ay * ay) + (az * az));
  return atan2f(-ax, denominator) * 180.0f / PI;
}

}  // namespace

void PoseEstimator::reset() {
  pitch_deg_ = 0.0f;
  roll_deg_ = 0.0f;
  yaw_deg_ = 0.0f;
  initialized_ = false;
  last_micros_ = 0;
}

void PoseEstimator::update(const float* imu_buffer) {
  const float ax = imu_buffer[0];
  const float ay = imu_buffer[1];
  const float az = imu_buffer[2];
  const float gx_deg_per_sec = imu_buffer[3] * 2000.0f;
  const float gy_deg_per_sec = imu_buffer[4] * 2000.0f;
  const float gz_deg_per_sec = imu_buffer[5] * 2000.0f;

  const unsigned long now = micros();
  float dt_seconds = 0.0f;
  if (initialized_) {
    dt_seconds = (now - last_micros_) * 0.000001f;
  }
  last_micros_ = now;

  const float accel_roll = ComputeAccelRollDegrees(ay, az);
  const float accel_pitch = ComputeAccelPitchDegrees(ax, ay, az);

  if (!initialized_ || dt_seconds <= 0.0f || dt_seconds > kMaxValidDtSeconds) {
    roll_deg_ = accel_roll;
    pitch_deg_ = accel_pitch;
    yaw_deg_ = 0.0f;
    initialized_ = true;
    return;
  }

  roll_deg_ =
      kComplementaryAlpha * (roll_deg_ + (gx_deg_per_sec * dt_seconds)) +
      (1.0f - kComplementaryAlpha) * accel_roll;
  pitch_deg_ =
      kComplementaryAlpha * (pitch_deg_ + (gy_deg_per_sec * dt_seconds)) +
      (1.0f - kComplementaryAlpha) * accel_pitch;
  yaw_deg_ = WrapAngleDegrees(yaw_deg_ + (gz_deg_per_sec * dt_seconds));
}
