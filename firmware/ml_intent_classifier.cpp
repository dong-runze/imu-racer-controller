#include "ml_intent_classifier.h"

#include <math.h>

#include "model_weights.h"

static_assert(
    kModelFeatureVersion == 2,
    "Firmware requires a Feature V2 gravity/gyro model.");
static_assert(
    kModelInputSize == 31,
    "Feature V2 firmware requires 31 input features.");
static_assert(
    kModelOutputSize == 4,
    "Firmware requires four sigmoid outputs in W/A/S/D order.");

namespace {

struct AxisStats {
  float mean;
  float std;
  float delta;
};

struct Vector3 {
  float x;
  float y;
  float z;
};

constexpr float kGravityLowPassAlpha = 0.86f;
// Applies to every non-neutral key mask, not a single direction. Neutral is
// still immediate so virtual keys release without sticky input.
constexpr uint8_t kKeySwitchConfirmFrames = 2;

float Clamp(float value, float min_value, float max_value) {
  if (value < min_value) {
    return min_value;
  }
  if (value > max_value) {
    return max_value;
  }
  return value;
}

float Magnitude(Vector3 vector) {
  return sqrtf(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

Vector3 Normalize(Vector3 vector, Vector3 fallback = {0.0f, 0.0f, 1.0f}) {
  const float length = Magnitude(vector);
  if (!isfinite(length) || length < 0.000001f) {
    return fallback;
  }

  return {
      vector.x / length,
      vector.y / length,
      vector.z / length,
  };
}

float Dot(Vector3 a, Vector3 b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

Vector3 Subtract(Vector3 a, Vector3 b) {
  return {
      a.x - b.x,
      a.y - b.y,
      a.z - b.z,
  };
}

float AngleBetweenDegrees(Vector3 a, Vector3 b) {
  const Vector3 normalized_a = Normalize(a);
  const Vector3 normalized_b = Normalize(b);
  return acosf(Clamp(Dot(normalized_a, normalized_b), -1.0f, 1.0f)) *
         180.0f / PI;
}

AxisStats SummarizeAxis(
    const MlIntentClassifier::MotionSample* samples,
    size_t count,
    char group,
    char axis) {
  AxisStats stats = {};
  if (count == 0) {
    return stats;
  }

  float sum = 0.0f;
  float first_value = 0.0f;
  float last_value = 0.0f;

  for (size_t index = 0; index < count; ++index) {
    float value = 0.0f;
    if (group == 'g') {
      value = axis == 'x' ? samples[index].gravity_x
            : axis == 'y' ? samples[index].gravity_y
                          : samples[index].gravity_z;
    } else {
      value = axis == 'x' ? samples[index].gyro_x
            : axis == 'y' ? samples[index].gyro_y
                          : samples[index].gyro_z;
    }

    if (index == 0) {
      first_value = value;
    }
    if (index == count - 1) {
      last_value = value;
    }
    sum += value;
  }

  stats.mean = sum / static_cast<float>(count);
  float variance_sum = 0.0f;
  for (size_t index = 0; index < count; ++index) {
    float value = 0.0f;
    if (group == 'g') {
      value = axis == 'x' ? samples[index].gravity_x
            : axis == 'y' ? samples[index].gravity_y
                          : samples[index].gravity_z;
    } else {
      value = axis == 'x' ? samples[index].gyro_x
            : axis == 'y' ? samples[index].gyro_y
                          : samples[index].gyro_z;
    }
    const float diff = value - stats.mean;
    variance_sum += diff * diff;
  }

  stats.std = sqrtf(variance_sum / static_cast<float>(count));
  stats.delta = last_value - first_value;
  return stats;
}

void DenseRelu(
    const float* input,
    const float* weights,
    const float* bias,
    size_t input_size,
    size_t output_size,
    float* output) {
  for (size_t row = 0; row < output_size; ++row) {
    float sum = bias[row];
    const size_t row_offset = row * input_size;
    for (size_t column = 0; column < input_size; ++column) {
      sum += weights[row_offset + column] * input[column];
    }
    output[row] = sum > 0.0f ? sum : 0.0f;
  }
}

void DenseLinear(
    const float* input,
    const float* weights,
    const float* bias,
    size_t input_size,
    size_t output_size,
    float* output) {
  for (size_t row = 0; row < output_size; ++row) {
    float sum = bias[row];
    const size_t row_offset = row * input_size;
    for (size_t column = 0; column < input_size; ++column) {
      sum += weights[row_offset + column] * input[column];
    }
    output[row] = sum;
  }
}

float Sigmoid(float value) {
  if (value >= 0.0f) {
    const float z = expf(-value);
    return 1.0f / (1.0f + z);
  }

  const float z = expf(value);
  return z / (1.0f + z);
}

uint8_t ToPercent(float value) {
  return static_cast<uint8_t>(Clamp(value * 100.0f, 0.0f, 100.0f));
}

uint8_t KeyMaskForIndex(size_t index) {
  switch (index) {
    case 0:
      return KEY_MASK_W;
    case 1:
      return KEY_MASK_A;
    case 2:
      return KEY_MASK_S;
    case 3:
      return KEY_MASK_D;
    default:
      return 0;
  }
}

uint8_t CountBits(uint8_t value) {
  uint8_t count = 0;
  while (value != 0) {
    count += value & 1;
    value >>= 1;
  }
  return count;
}

MlIntentClassifier::CalibrationVector MakeCalibrationVector(
    bool valid,
    float x,
    float y,
    float z) {
  const Vector3 normalized = Normalize({x, y, z});
  return {valid, normalized.x, normalized.y, normalized.z};
}

}  // namespace

MlIntentClassifier::MlIntentClassifier()
    : sample_count_(0),
      sample_write_index_(0),
      gravity_initialized_(false),
      gravity_x_(0.0f),
      gravity_y_(0.0f),
      gravity_z_(1.0f),
      last_gyro_x_(0.0f),
      last_gyro_y_(0.0f),
      last_gyro_z_(0.0f),
      neutral_({false, 0.0f, 0.0f, 1.0f}),
      left_({false, 0.0f, 0.0f, 1.0f}),
      right_({false, 0.0f, 0.0f, 1.0f}),
      forward_({false, 0.0f, 0.0f, 1.0f}),
      backward_({false, 0.0f, 0.0f, 1.0f}),
      active_key_mask_(0),
      pending_key_mask_(0),
      pending_key_count_(0) {
  resetCalibration();
}

void MlIntentClassifier::addMotion(
    float accel_x,
    float accel_y,
    float accel_z,
    float gyro_x,
    float gyro_y,
    float gyro_z,
    unsigned long time_ms) {
  const Vector3 accel_direction = Normalize({accel_x, accel_y, accel_z});
  if (!gravity_initialized_) {
    gravity_x_ = accel_direction.x;
    gravity_y_ = accel_direction.y;
    gravity_z_ = accel_direction.z;
    gravity_initialized_ = true;
  } else {
    gravity_x_ =
        kGravityLowPassAlpha * gravity_x_ +
        (1.0f - kGravityLowPassAlpha) * accel_direction.x;
    gravity_y_ =
        kGravityLowPassAlpha * gravity_y_ +
        (1.0f - kGravityLowPassAlpha) * accel_direction.y;
    gravity_z_ =
        kGravityLowPassAlpha * gravity_z_ +
        (1.0f - kGravityLowPassAlpha) * accel_direction.z;
    const Vector3 normalized_gravity =
        Normalize({gravity_x_, gravity_y_, gravity_z_});
    gravity_x_ = normalized_gravity.x;
    gravity_y_ = normalized_gravity.y;
    gravity_z_ = normalized_gravity.z;
  }

  last_gyro_x_ = gyro_x;
  last_gyro_y_ = gyro_y;
  last_gyro_z_ = gyro_z;

  samples_[sample_write_index_] = {
      time_ms,
      gravity_x_,
      gravity_y_,
      gravity_z_,
      gyro_x,
      gyro_y,
      gyro_z,
  };
  sample_write_index_ = (sample_write_index_ + 1) % kMaxMotionSamples;
  if (sample_count_ < kMaxMotionSamples) {
    sample_count_ += 1;
  }
}

void MlIntentClassifier::setCalibrationSample(
    CalibrationStage stage,
    float gravity_x,
    float gravity_y,
    float gravity_z) {
  CalibrationVector sample =
      MakeCalibrationVector(true, gravity_x, gravity_y, gravity_z);
  switch (stage) {
    case CAL_STAGE_NEUTRAL:
      neutral_ = sample;
      break;
    case CAL_STAGE_LEFT:
      left_ = sample;
      break;
    case CAL_STAGE_RIGHT:
      right_ = sample;
      break;
    case CAL_STAGE_FORWARD:
      forward_ = sample;
      break;
    case CAL_STAGE_BACKWARD:
      backward_ = sample;
      break;
    default:
      break;
  }
}

void MlIntentClassifier::resetCalibration() {
  active_key_mask_ = 0;
  pending_key_mask_ = 0;
  pending_key_count_ = 0;

  if (kModelHasDefaultCalibration) {
    neutral_ = MakeCalibrationVector(
        true,
        kModelNeutralGravityX,
        kModelNeutralGravityY,
        kModelNeutralGravityZ);
    forward_ = MakeCalibrationVector(
        true,
        kModelForwardGravityX,
        kModelForwardGravityY,
        kModelForwardGravityZ);
    backward_ = MakeCalibrationVector(
        true,
        kModelBackwardGravityX,
        kModelBackwardGravityY,
        kModelBackwardGravityZ);
    left_ = MakeCalibrationVector(
        true,
        kModelLeftGravityX,
        kModelLeftGravityY,
        kModelLeftGravityZ);
    right_ = MakeCalibrationVector(
        true,
        kModelRightGravityX,
        kModelRightGravityY,
        kModelRightGravityZ);
    return;
  }

  neutral_ = {false, 0.0f, 0.0f, 1.0f};
  forward_ = {false, 0.0f, 0.0f, 1.0f};
  backward_ = {false, 0.0f, 0.0f, 1.0f};
  left_ = {false, 0.0f, 0.0f, 1.0f};
  right_ = {false, 0.0f, 0.0f, 1.0f};
}

MotionSnapshot MlIntentClassifier::currentMotion() const {
  return {
      gravity_x_,
      gravity_y_,
      gravity_z_,
      last_gyro_x_,
      last_gyro_y_,
      last_gyro_z_,
  };
}

bool MlIntentClassifier::collectWindow(
    unsigned long now_ms,
    MotionSample* output,
    size_t* count) const {
  *count = 0;
  if (sample_count_ == 0) {
    return false;
  }

  const size_t oldest_index =
      sample_count_ == kMaxMotionSamples ? sample_write_index_ : 0;
  for (size_t offset = 0; offset < sample_count_; ++offset) {
    const size_t index = (oldest_index + offset) % kMaxMotionSamples;
    const MotionSample& sample = samples_[index];
    if (now_ms - sample.time_ms <= kModelWindowMs) {
      output[*count] = sample;
      *count += 1;
    }
  }

  if (*count > 0) {
    return true;
  }

  const size_t last_index =
      (sample_write_index_ + kMaxMotionSamples - 1) % kMaxMotionSamples;
  output[0] = samples_[last_index];
  *count = 1;
  return true;
}

bool MlIntentClassifier::hasFullCalibration() const {
  return neutral_.valid && left_.valid && right_.valid && forward_.valid &&
         backward_.valid;
}

void MlIntentClassifier::buildFeatures(
    const MotionSample* samples,
    size_t count,
    float* features) const {
  const AxisStats gravity_x = SummarizeAxis(samples, count, 'g', 'x');
  const AxisStats gravity_y = SummarizeAxis(samples, count, 'g', 'y');
  const AxisStats gravity_z = SummarizeAxis(samples, count, 'g', 'z');
  const AxisStats gyro_x = SummarizeAxis(samples, count, 'r', 'x');
  const AxisStats gyro_y = SummarizeAxis(samples, count, 'r', 'y');
  const AxisStats gyro_z = SummarizeAxis(samples, count, 'r', 'z');
  const Vector3 gravity_mean =
      Normalize({gravity_x.mean, gravity_y.mean, gravity_z.mean});
  const Vector3 neutral =
      neutral_.valid ? Vector3{neutral_.x, neutral_.y, neutral_.z}
                     : Vector3{0.0f, 0.0f, 1.0f};
  const Vector3 forward =
      forward_.valid ? Vector3{forward_.x, forward_.y, forward_.z} : neutral;
  const Vector3 backward =
      backward_.valid ? Vector3{backward_.x, backward_.y, backward_.z} : neutral;
  const Vector3 left =
      left_.valid ? Vector3{left_.x, left_.y, left_.z} : neutral;
  const Vector3 right =
      right_.valid ? Vector3{right_.x, right_.y, right_.z} : neutral;
  const Vector3 forward_axis =
      Normalize(Subtract(forward, backward), {1.0f, 0.0f, 0.0f});
  const Vector3 left_axis =
      Normalize(Subtract(left, right), {0.0f, 1.0f, 0.0f});
  const float angle_neutral = AngleBetweenDegrees(gravity_mean, neutral);
  const float angle_forward = AngleBetweenDegrees(gravity_mean, forward);
  const float angle_backward = AngleBetweenDegrees(gravity_mean, backward);
  const float angle_left = AngleBetweenDegrees(gravity_mean, left);
  const float angle_right = AngleBetweenDegrees(gravity_mean, right);
  const float forward_projection = Dot(gravity_mean, forward_axis);
  const float left_projection = Dot(gravity_mean, left_axis);
  const float forward_score = max(0.0f, forward_projection);
  const float backward_score = max(0.0f, -forward_projection);
  const float left_score = max(0.0f, left_projection);
  const float right_score = max(0.0f, -left_projection);
  float gyro_energy_sum = 0.0f;

  for (size_t index = 0; index < count; ++index) {
    gyro_energy_sum += Magnitude(
        {samples[index].gyro_x, samples[index].gyro_y, samples[index].gyro_z});
  }

  const float gyro_energy_mean = gyro_energy_sum / max(static_cast<float>(count), 1.0f);
  const float gravity_jitter = sqrtf(
      gravity_x.std * gravity_x.std +
      gravity_y.std * gravity_y.std +
      gravity_z.std * gravity_z.std);
  const float direction_confidence =
      max(max(forward_score, backward_score), max(left_score, right_score));
  const float neutral_score = Clamp(1.0f - angle_neutral / 90.0f, 0.0f, 1.0f);

  features[0] = gravity_x.mean;
  features[1] = gravity_y.mean;
  features[2] = gravity_z.mean;
  features[3] = gravity_x.std;
  features[4] = gravity_y.std;
  features[5] = gravity_z.std;
  features[6] = gravity_x.delta;
  features[7] = gravity_y.delta;
  features[8] = gravity_z.delta;
  features[9] = angle_neutral;
  features[10] = angle_forward;
  features[11] = angle_backward;
  features[12] = angle_left;
  features[13] = angle_right;
  features[14] = forward_score;
  features[15] = backward_score;
  features[16] = left_score;
  features[17] = right_score;
  features[18] = gyro_x.mean;
  features[19] = gyro_y.mean;
  features[20] = gyro_z.mean;
  features[21] = gyro_x.std;
  features[22] = gyro_y.std;
  features[23] = gyro_z.std;
  features[24] = gyro_x.delta;
  features[25] = gyro_y.delta;
  features[26] = gyro_z.delta;
  features[27] = gyro_energy_mean;
  features[28] = gravity_jitter;
  features[29] = direction_confidence;
  features[30] = neutral_score;
}

void MlIntentClassifier::runModel(
    const float* features,
    float* probabilities) const {
  float input[kModelInputSize];
  float hidden1[kModelHidden1Size];
  float hidden2[kModelHidden2Size];
  float logits[kModelOutputSize];

  for (size_t index = 0; index < kModelInputSize; ++index) {
    const float std_value =
        fabsf(kModelFeatureStd[index]) < 0.000001f
            ? 1.0f
            : kModelFeatureStd[index];
    input[index] = (features[index] - kModelFeatureMean[index]) / std_value;
  }

  DenseRelu(
      input,
      kModelDense0Weights,
      kModelDense0Bias,
      kModelInputSize,
      kModelHidden1Size,
      hidden1);
  DenseRelu(
      hidden1,
      kModelDense1Weights,
      kModelDense1Bias,
      kModelHidden1Size,
      kModelHidden2Size,
      hidden2);
  DenseLinear(
      hidden2,
      kModelDense2Weights,
      kModelDense2Bias,
      kModelHidden2Size,
      kModelOutputSize,
      logits);

  for (size_t index = 0; index < kModelOutputSize; ++index) {
    probabilities[index] = Sigmoid(logits[index]);
  }
}

uint8_t MlIntentClassifier::resolveKeyMask(const float* probabilities) {
  uint8_t main_mask = 0;

  for (size_t index = 0; index < kModelOutputSize; ++index) {
    const uint8_t bit = KeyMaskForIndex(index);
    const bool was_active = (active_key_mask_ & bit) != 0;
    const float threshold = was_active ? kKeyOffThreshold : kKeyOnThreshold;
    if (probabilities[index] >= threshold) {
      main_mask |= bit;
    }
  }

  if ((main_mask & KEY_MASK_W) && (main_mask & KEY_MASK_S)) {
    main_mask &=
        probabilities[0] >= probabilities[2] ? ~KEY_MASK_S : ~KEY_MASK_W;
  }
  if ((main_mask & KEY_MASK_A) && (main_mask & KEY_MASK_D)) {
    main_mask &=
        probabilities[1] >= probabilities[3] ? ~KEY_MASK_D : ~KEY_MASK_A;
  }

  uint8_t mask = main_mask;
  if (main_mask & KEY_MASK_S) {
    mask = KEY_MASK_S;
  } else if (main_mask & KEY_MASK_W) {
    const float a_threshold =
        (active_key_mask_ & KEY_MASK_A) ? kKeyOffThreshold : kComboSteerThreshold;
    const float d_threshold =
        (active_key_mask_ & KEY_MASK_D) ? kKeyOffThreshold : kComboSteerThreshold;
    const bool a_eligible =
        probabilities[1] >= a_threshold &&
        probabilities[1] - probabilities[3] >= kComboSteerMargin;
    const bool d_eligible =
        probabilities[3] >= d_threshold &&
        probabilities[3] - probabilities[1] >= kComboSteerMargin;

    mask = KEY_MASK_W;
    if (a_eligible || d_eligible) {
      mask |= a_eligible ? KEY_MASK_A : KEY_MASK_D;
    }
  }

  const uint8_t max_active = kMaxActiveKeys < 1 ? 1 : kMaxActiveKeys;
  while (CountBits(mask) > max_active) {
    float weakest_probability = 2.0f;
    uint8_t weakest_bit = 0;
    for (size_t index = 0; index < kModelOutputSize; ++index) {
      const uint8_t bit = KeyMaskForIndex(index);
      if ((mask & bit) && probabilities[index] < weakest_probability) {
        weakest_probability = probabilities[index];
        weakest_bit = bit;
      }
    }
    mask &= ~weakest_bit;
  }

  return applyKeySwitchFilter(mask);
}

uint8_t MlIntentClassifier::applyKeySwitchFilter(uint8_t raw_key_mask) {
  if (raw_key_mask == 0 || raw_key_mask == active_key_mask_) {
    active_key_mask_ = raw_key_mask;
    pending_key_mask_ = 0;
    pending_key_count_ = 0;
    return active_key_mask_;
  }

  if (raw_key_mask == pending_key_mask_) {
    pending_key_count_ += 1;
  } else {
    pending_key_mask_ = raw_key_mask;
    pending_key_count_ = 1;
  }

  if (pending_key_count_ >= kKeySwitchConfirmFrames) {
    active_key_mask_ = raw_key_mask;
    pending_key_mask_ = 0;
    pending_key_count_ = 0;
  }

  return active_key_mask_;
}

IntentLabel MlIntentClassifier::labelFromKeyMask(uint8_t key_mask) const {
  if ((key_mask & KEY_MASK_W) && (key_mask & KEY_MASK_A)) {
    return INTENT_WA;
  }
  if ((key_mask & KEY_MASK_W) && (key_mask & KEY_MASK_D)) {
    return INTENT_WD;
  }
  if (key_mask & KEY_MASK_W) {
    return INTENT_W;
  }
  if (key_mask & KEY_MASK_A) {
    return INTENT_A;
  }
  if (key_mask & KEY_MASK_S) {
    return INTENT_S;
  }
  if (key_mask & KEY_MASK_D) {
    return INTENT_D;
  }

  return INTENT_NEUTRAL;
}

uint8_t MlIntentClassifier::confidenceFromKeyMask(
    uint8_t key_mask,
    const float* probabilities) const {
  if (key_mask == 0) {
    const float max_probability =
        max(max(probabilities[0], probabilities[1]),
            max(probabilities[2], probabilities[3]));
    return ToPercent(1.0f - max_probability);
  }

  float confidence = 1.0f;
  const uint8_t bits[] = {
      KEY_MASK_W,
      KEY_MASK_A,
      KEY_MASK_S,
      KEY_MASK_D,
  };
  for (size_t index = 0; index < kModelOutputSize; ++index) {
    if (key_mask & bits[index]) {
      confidence = min(confidence, probabilities[index]);
    }
  }
  return ToPercent(confidence);
}

IntentPrediction MlIntentClassifier::predict(unsigned long now_ms) {
  MotionSample window[kMaxMotionSamples];
  size_t window_count = 0;
  IntentPrediction prediction = {
      INTENT_NEUTRAL,
      0,
      0,
      INTENT_FLAG_MODEL_READY,
      0,
      0,
      0,
      0,
  };

  if (!collectWindow(now_ms, window, &window_count)) {
    return prediction;
  }

  float features[kModelInputSize];
  buildFeatures(window, window_count, features);

  float probabilities[kModelOutputSize] = {};
  runModel(features, probabilities);
  prediction.key_mask = resolveKeyMask(probabilities);
  prediction.label = labelFromKeyMask(prediction.key_mask);
  prediction.confidence_percent =
      confidenceFromKeyMask(prediction.key_mask, probabilities);
  prediction.w_percent = ToPercent(probabilities[0]);
  prediction.a_percent = ToPercent(probabilities[1]);
  prediction.s_percent = ToPercent(probabilities[2]);
  prediction.d_percent = ToPercent(probabilities[3]);
  prediction.flags = INTENT_FLAG_MODEL_READY;
  if (prediction.confidence_percent >= ToPercent(kModelConfidenceThreshold)) {
    prediction.flags |= INTENT_FLAG_CONFIDENT;
  }
  if (hasFullCalibration()) {
    prediction.flags |= INTENT_FLAG_CALIBRATED;
  }

  return prediction;
}
