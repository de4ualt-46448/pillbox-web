/*
 * stepper.h — half-step driver for the 28BYJ-48 unipolar stepper via a
 * ULN2003 driver board. Keeps track of absolute position so the carousel
 * can rotate to a numbered slot.
 */

#ifndef ZCARE_STEPPER_H
#define ZCARE_STEPPER_H

#include <Arduino.h>
#include "config.h"

// 8-step (half-step) sequence for the 28BYJ-48 / ULN2003.
static const uint8_t STEPS[8] = {
    0b00001,
    0b00011,
    0b00010,
    0b00110,
    0b00100,
    0b01100,
    0b01000,
    0b01001,
};

class Stepper {
 public:
  Stepper(uint8_t pin1, uint8_t pin2, uint8_t pin3, uint8_t pin4)
      : _pin1(pin1), _pin2(pin2), _pin3(pin3), _pin4(pin4) {}

  void begin() {
    pinMode(_pin1, OUTPUT);
    pinMode(_pin2, OUTPUT);
    pinMode(_pin3, OUTPUT);
    pinMode(_pin4, OUTPUT);
    powerOff();
  }

  // Rotate the given number of micro-steps. Positive = clockwise.
  void step(int stepsToMove) {
    _moving = true;
    int direction = stepsToMove > 0 ? 1 : -1;
    int remaining = abs(stepsToMove);
    while (remaining > 0) {
      _index = (_index + direction + 8) % 8;
      writeStep(_index);
      _position = (_position + direction);
      delayMicroseconds(STEP_INTERVAL_US);
      remaining--;
    }
    powerOff();
    _moving = false;
  }

  // Move to a 0-based carousel slot (shortest rotation from current slot).
  void moveToSlot(uint8_t targetSlot) {
    int8_t currentSlot = _position % STEPS_PER_SLOT;  // not used directly
    int stepsPerSlot = STEPS_PER_SLOT;
    long target = (long)targetSlot * stepsPerSlot;
    long diff = target - (_position % STEPS_PER_REV);
    // Take the shorter way around the circle.
    if (diff > STEPS_PER_REV / 2) diff -= STEPS_PER_REV;
    if (diff < -STEPS_PER_REV / 2) diff += STEPS_PER_REV;
    step((int)diff);
  }

  bool isMoving() const { return _moving; }
  int  position() const { return _position; }

 private:
  void writeStep(uint8_t idx) {
    digitalWrite(_pin1, STEPS[idx] & 0b0001 ? HIGH : LOW);
    digitalWrite(_pin2, STEPS[idx] & 0b0010 ? HIGH : LOW);
    digitalWrite(_pin3, STEPS[idx] & 0b0100 ? HIGH : LOW);
    digitalWrite(_pin4, STEPS[idx] & 0b1000 ? HIGH : LOW);
  }

  void powerOff() {
    digitalWrite(_pin1, LOW);
    digitalWrite(_pin2, LOW);
    digitalWrite(_pin3, LOW);
    digitalWrite(_pin4, LOW);
  }

  uint8_t _pin1, _pin2, _pin3, _pin4;
  int     _index = 0;
  int     _position = 0;  // absolute micro-steps since boot
  bool    _moving = false;
};

#endif  // ZCARE_STEPPER_H
