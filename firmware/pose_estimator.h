#ifndef IMU_RACER_POSE_ESTIMATOR_H_
#define IMU_RACER_POSE_ESTIMATOR_H_

class PoseEstimator {
 public:
  void reset();
  void update(const float* imu_buffer);

  float pitch() const { return pitch_deg_; }
  float roll() const { return roll_deg_; }
  float yaw() const { return yaw_deg_; }
  bool isInitialized() const { return initialized_; }

 private:
  float pitch_deg_ = 0.0f;
  float roll_deg_ = 0.0f;
  float yaw_deg_ = 0.0f;
  bool initialized_ = false;
  unsigned long last_micros_ = 0;
};

#endif  // IMU_RACER_POSE_ESTIMATOR_H_
