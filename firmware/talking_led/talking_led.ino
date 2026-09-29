// Dream Debate talking LED — Adafruit ESP32 Feather V2
//
// Serial protocol (115200 baud, newline-terminated ASCII):
//   boot        -> READY:dream-debate-1
//   ID?         -> ID:dream-debate-1
//   LED:<0-255> -> sets LED brightness on GPIO 27 (no reply; sent often)
//
// Wiring: GPIO 27 -> 220 ohm resistor -> LED anode (long leg); LED cathode -> GND.

const char *BOARD_ID = "dream-debate-1";
const int LED_PIN = 27;

String line;

void setup() {
  Serial.begin(115200);
  analogWrite(LED_PIN, 0);
  delay(200);
  Serial.print("READY:");
  Serial.println(BOARD_ID);
}

void handleLine(String cmd) {
  cmd.trim();
  if (cmd == "ID?") {
    Serial.print("ID:");
    Serial.println(BOARD_ID);
  } else if (cmd.startsWith("LED:")) {
    int value = constrain(cmd.substring(4).toInt(), 0, 255);
    analogWrite(LED_PIN, value);
  }
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleLine(line);
      line = "";
    } else if (c != '\r' && line.length() < 32) {
      line += c;
    }
  }
}
