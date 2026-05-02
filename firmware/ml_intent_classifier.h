#ifndef IMU_RACER_ML_INTENT_CLASSIFIER_H_
#define IMU_RACER_ML_INTENT_CLASSIFIER_H_

#include <Arduino.h>

#include "ble_protocol.h"

struct IntentPrediction {
  IntentLabel label;
  uint8_t key_mask;
  uint8_t confidence_percent;
  uint8_t flags;
  uint8_t w_percent;
  uint8_t a_percent;
  uint8_t s_percent;
  uint8_t d_percent;
};

struct MotionSnapshot {
  float gravity_x;
  float gravity_y;
  float gravity_z;
  float gyro_x;
  float gyro_y;
  float gyro_z;
};

class MlIntentClassifier {
 public:
  struct MotionSample {
    unsigned long time_ms;
    float gravity_x;
    float gravity_y;
    float gravity_z;
    float gyro_x;
    float gyro_y;
    float gyro_z;
  };

  struct CalibrationVector {
    bool valid;
    float x;
    float y;
    float z;
  };

  MlIntentClassifier();

  void addMotion(
      float accel_x,
      float accel_y,
      float accel_z,
      float gyro_x,
      float gyro_y,
      float gyro_z,
      unsigned long time_ms);
  void setCalibrationSample(
      CalibrationStage stage,
      float gravity_x,
      float gravity_y,
      float gravity_z);
  void resetCalibration();
  IntentPrediction predict(unsigned long now_ms);
  MotionSnapshot currentMotion() const;

 private:

  static constexpr size_t kMaxMotionSamples = 48;

  MotionSample samples_[kMaxMotionSamples];
  size_t sample_count_;
  size_t sample_write_index_;
  bool gravity_initialized_;
  float gravity_x_;
  float gravity_y_;
  float gravity_z_;
  float last_gyro_x_;
  float last_gyro_y_;
  float last_gyro_z_;
  CalibrationVector neutral_;
  CalibrationVector left_;
  CalibrationVector right_;
  CalibrationVector forward_;
  CalibrationVector backward_;
  uint8_t active_key_mask_;
  uint8_t pending_key_mask_;
  uint8_t pending_key_count_;

  bool collectWindow(
      unsigned long now_ms,
      MotionSample* output,
      size_t* count) const;
  bool hasFullCalibration() const;
  void buildFeatures(
      const MotionSample* samples,
      size_t count,
      float* features) const;
  void runModel(const float* features, float* probabilities) const;
  uint8_t resolveKeyMask(const float* probabilities);
  uint8_t applyKeySwitchFilter(uint8_t raw_key_mask);
  IntentLabel labelFromKeyMask(uint8_t key_mask) const;
  uint8_t confidenceFromKeyMask(
      uint8_t key_mask,
      const float* probabilities) const;
};

#endif  // IMU_RACER_ML_INTENT_CLASSIFIER_H_
